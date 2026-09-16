/**
 * The DeepSeek Harness plugin half of `deepseek-harness-sync`.
 *
 * It adds four model-facing tools and one human slash command, all of which run
 * the same code as the `harness-sync` CLI. Two deliberate choices:
 *
 * - `inject` names only `tools`. The command registry and the web server are
 *   *optional* services, reached through a `ctx.inject` child fiber: `inject` is
 *   a hard gate, so naming `commands` there would stop the plugin from loading
 *   at all in a profile that does not mount it (such as a minimal SDK profile).
 * - Tool results are rendered from a captured text sink rather than returned as
 *   structured data, so a tool result reads exactly like the terminal output a
 *   person would see, including the divergence menu.
 *
 * @module deepseek-harness-sync
 */

import { registerApi } from './host/api.js';
import { Ui } from './ui.js';
import { dispatch } from './run.js';

/** Plugin name as the loader logs it. */
export const name = 'harness-sync';

/** The only hard dependency: the tool registry. */
export const inject = ['tools'];

/** JSON Schema for every tool's result: the captured output plus the exit code. */
const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		exitCode: { type: 'integer', description: '0 success, 1 error, 2 diverged (the user must choose pull or force-push).' },
		output: { type: 'string', description: 'The full human-readable output of the command.' },
	},
	required: ['exitCode', 'output'],
	additionalProperties: false,
};

/** Subcommands the slash command accepts. */
const SUBCOMMANDS = new Set(['status', 'push', 'pull', 'sync', 'diff', 'rollback', 'export', 'init']);

/**
 * Validate and default the plugin configuration.
 *
 * The loader hands over whatever the profile's patch entry contains, so a typo
 * there must fail loudly at load time rather than silently syncing the wrong
 * profile.
 *
 * @param {object} raw - the configured values.
 * @returns {{profile: string, device: string|undefined, dataRoot: string|undefined}} the effective configuration.
 */
function normalizeConfig(raw) {
	const config = {
		profile: 'web',
		device: undefined,
		dataRoot: undefined,
		root: undefined,
		...(raw ?? {}),
	};
	for (const key of ['profile', 'device', 'dataRoot', 'root']) {
		const value = config[key];
		if (value === undefined || value === null) {
			config[key] = undefined;
			continue;
		}
		if (typeof value !== 'string' || value.trim() === '') {
			throw new Error(`${name}: config.${key} must be a non-empty string, got ${JSON.stringify(value)}`);
		}
	}
	if (config.profile === undefined) config.profile = 'web';
	return config;
}

/**
 * A `Ui` that captures output into an array instead of a terminal.
 *
 * @returns {{ui: Ui, text: () => string}} the facade and its accumulated text.
 */
function collectingUi() {
	/** @type {string[]} */
	const chunks = [];
	const sink = {
		isTTY: false,
		write(chunk) {
			chunks.push(String(chunk));
			return true;
		},
	};
	return {
		ui: new Ui({ out: sink, err: sink, color: false, env: {} }),
		text: () => chunks.join('').replace(/\n+$/, ''),
	};
}

/**
 * Register the plugin's tools and, when available, its slash command.
 *
 * @param {object} ctx - the cordis context carrying `ctx.tools`.
 * @param {object} rawConfig - the profile-provided configuration.
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);

	/**
	 * Run one command and capture everything it prints.
	 *
	 * @param {string[]} argv - arguments after the program name.
	 * @returns {Promise<{exitCode: number, output: string}>} the captured result.
	 */
	const runCommand = async (argv) => {
		const { ui, text } = collectingUi();
		try {
			const exitCode = await dispatch(argv, {
				ui,
				env: process.env,
				root: config.root,
				profile: config.profile,
				device: config.device,
				dataRoot: config.dataRoot,
			});
			return { exitCode, output: text() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { exitCode: 1, output: `${text()}\nERROR ${message}`.trim() };
		}
	};

	/**
	 * Assemble an argument vector from a tool call's arguments.
	 *
	 * @param {string} command - the subcommand.
	 * @param {object} args - the validated tool arguments.
	 * @returns {string[]} the argument vector.
	 */
	const argvFor = (command, args) => {
		const argv = [command];
		if (args.force === true) argv.push('--force');
		if (args.dryRun === true) argv.push('--dry-run');
		if (args.list === true) argv.push('--list');
		if (typeof args.workspace === 'string' && args.workspace !== '') argv.push('--workspace', args.workspace);
		if (typeof args.to === 'string' && args.to !== '') argv.push('--to', args.to);
		return argv;
	};

	/**
	 * Assert that a tool's arguments have the declared shape.
	 *
	 * The tool registry validates a definition's *output* schema but not its
	 * `parameters`, so a definition built without the first-party `defineTool`
	 * helper owns its own argument checks. This plugin stays dependency-free on
	 * purpose, so the checks live here.
	 *
	 * @param {string} tool - the tool name.
	 * @param {object} args - the raw arguments.
	 * @param {{boolean?: string[], string?: string[]}} shape - the allowed fields.
	 */
	const checkArgs = (tool, args, shape) => {
		for (const key of Object.keys(args ?? {})) {
			const isBoolean = shape.boolean?.includes(key);
			const isString = shape.string?.includes(key);
			if (isBoolean !== true && isString !== true) throw new Error(`${tool}: unrecognized argument "${key}"`);
			if (isBoolean === true && typeof args[key] !== 'boolean') throw new Error(`${tool}: "${key}" must be a boolean`);
			if (isString === true && typeof args[key] !== 'string') throw new Error(`${tool}: "${key}" must be a string`);
		}
	};

	/**
	 * Define one tool that wraps a command.
	 *
	 * @param {{tool: string, command: string, description: string, parameters: object, boolean?: string[], string?: string[]}} spec - the tool specification.
	 * @returns {object} a registry-ready definition.
	 */
	const commandTool = (spec) => ({
		name: spec.tool,
		description: spec.description,
		parameters: spec.parameters,
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: value.output === '' ? `exit ${value.exitCode}` : value.output }],
		},
		// Reading and writing configuration are not safe to run concurrently
		// against the same files, so the registry is told so explicitly.
		isConcurrencySafe: () => false,
		async execute(args) {
			checkArgs(spec.tool, args, { boolean: spec.boolean, string: spec.string });
			return runCommand(argvFor(spec.command, args ?? {}));
		},
	});

	const noArgs = { type: 'object', properties: {}, additionalProperties: false };
	/**
	 * The workspace argument, offered by every command that reads or writes it.
	 *
	 * Omitted, the tool uses the session's working directory — which is the
	 * workspace by definition in a chat session — falling back to whatever `init`
	 * recorded for this device. It is a path on THIS machine and is never synced:
	 * `/home/alice/work` means nothing on another device.
	 */
	const workspaceProperty = {
		workspace: {
			type: 'string',
			description: 'Absolute path of the session workspace to include. Defaults to the session working directory, then to the path recorded by init. The workspace is synced as configuration and notes plus repository references; research data, build output and anything credential-shaped are never included.',
		},
	};
	const flagsOnly = {
		type: 'object',
		properties: {
			force: { type: 'boolean', description: 'Proceed even though the repository advanced since the last sync. Without this, a push onto a moved remote is refused.' },
			dryRun: { type: 'boolean', description: 'Report what would happen and change nothing.' },
			...workspaceProperty,
		},
		additionalProperties: false,
	};

	ctx.tools.register(
		commandTool({
			tool: 'harness_sync_status',
			command: 'status',
			description:
				'Compare this machine\'s DeepSeek Harness configuration against the private GitHub configuration repository: connection, which side is newer, the version numbers, and the synchronization verdict. Read-only.',
			parameters: { type: 'object', properties: { ...workspaceProperty }, additionalProperties: false },
			string: ['workspace'],
		}),
	);
	ctx.tools.register(
		commandTool({
			tool: 'harness_sync_push',
			command: 'push',
			description:
				'Upload this machine\'s DeepSeek Harness configuration — the harness home and the session workspace — to the private configuration repository. Refuses to run if the files contain anything that looks like a credential, and refuses to overwrite a repository that advanced since the last sync unless force is set. Git repositories inside the workspace are recorded as clone references, not copied.',
			parameters: flagsOnly,
			boolean: ['force', 'dryRun'],
			string: ['workspace'],
		}),
	);
	ctx.tools.register(
		commandTool({
			tool: 'harness_sync_pull',
			command: 'pull',
			description:
				'Download the configuration from the private repository and apply it to this machine, covering both the harness home and the session workspace. Always writes a local backup first, so the change can be undone with harness_sync_rollback. If the snapshot carries workspace files and no workspace is configured here, the pull refuses and writes nothing.',
			parameters: {
				type: 'object',
				properties: { dryRun: { type: 'boolean', description: 'Report what would change and apply nothing.' }, ...workspaceProperty },
				additionalProperties: false,
			},
			boolean: ['dryRun'],
			string: ['workspace'],
		}),
	);
	ctx.tools.register(
		commandTool({
			tool: 'harness_sync_rollback',
			command: 'rollback',
			description:
				'Restore a local configuration backup, taken automatically before every pull. Lists the available backups when list is true; otherwise restores the newest one, or the one named by to. The current configuration is backed up first, so a rollback can itself be undone.',
			parameters: {
				type: 'object',
				properties: {
					list: { type: 'boolean', description: 'List the available backups instead of restoring one.' },
					to: { type: 'string', description: 'Backup file name or 1-based index from the list. Defaults to the newest.' },
				},
				additionalProperties: false,
			},
			boolean: ['list'],
			string: ['to'],
		}),
	);

	// Optional services. `inject` is a hard gate — a plugin that declared
	// `commands` or `webServer` there would never load in a profile that does not
	// mount them, and would fail silently — so both are attached the way shipped
	// code does it: `ctx.inject` starts a *child* fiber that waits for the
	// service, so the tools above register either way and the command and the
	// settings bridge attach the moment the service shows up.
	//
	// The child *context* matters as much as the wait. Cordis resolves
	// `ctx.commands` by property only inside a context that injected `commands`;
	// anywhere else the read throws `cannot get property "commands" without
	// inject`. Checking the service with `ctx.get('commands')` is therefore not
	// enough — probing it and then reading `ctx.commands` on the *outer* context
	// throws at load time. Every registration below uses the scope the callback
	// hands over, never the outer `ctx`.
	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.effect(
			() =>
				commandCtx.commands.register({
					name: 'harness-sync',
					description: 'Sync DeepSeek Harness configuration through your private GitHub repository',
					input: { hint: 'status | push | pull | sync | diff | rollback [--force] [--dry-run]' },
					async handler(invocation) {
						const parts = String(invocation.rawInput ?? '').trim().split(/\s+/).filter((part) => part !== '');
						const sub = parts[0] ?? 'status';
						if (!SUBCOMMANDS.has(sub)) {
							return {
								kind: 'error',
								text: `unknown subcommand "${sub}" — try one of: ${[...SUBCOMMANDS].join(', ')}`,
							};
						}
						const result = await runCommand([sub, ...parts.slice(1)]);
						return {
							kind: result.exitCode === 0 ? 'success' : 'error',
							text: result.output === '' ? `exit ${result.exitCode}` : result.output,
						};
					},
				}),
			'harness-sync: slash command',
		);
	});

	// The Settings page's bridge. Without a web server (Electron loads the client
	// over file://) the page still renders, but its buttons report that the host
	// is unreachable rather than failing silently.
	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(() => {
			const disposers = registerApi(webCtx.webServer, config);
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, 'harness-sync: settings api');
	});
}

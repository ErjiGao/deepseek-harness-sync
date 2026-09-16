/**
 * Shared plumbing for the CLI commands: context, local/remote reads, prompts.
 *
 * @module deepseek-harness-sync/commands/shared
 */

import { createInterface } from 'node:readline/promises';

import { collect, detectMachineDependencies } from '../core/collect.js';
import { readRemoteFile, resolveToken, syncWorktree } from '../core/github.js';
import { collectAll, repositoryPreferences } from '../core/layers.js';
import { resolvePaths } from '../core/paths.js';
import { METADATA_PATH, SNAPSHOT_PATH, buildMetadata, buildSnapshot, parseSnapshot } from '../core/snapshot.js';
import { deviceName, readState } from '../core/state.js';
import { Ui } from '../ui.js';

/** Profile used when nothing else says otherwise. */
export const DEFAULT_PROFILE = 'web';

/** Branch used when nothing else says otherwise. */
export const DEFAULT_BRANCH = 'main';

/** Contents written to `README.md` inside the configuration repository. */
export const CONFIG_REPO_README = `# DeepSeek Harness configuration

This repository is managed by \`deepseek-harness-sync\`. It holds one snapshot of a
DeepSeek Harness installation so the same configuration can be restored on
another machine.

- \`config/harness-config.json\` — the snapshot: version, timestamp, device, and each
  configuration file stored as verbatim text.
- \`metadata.json\` — a small index (version, timestamp, device, per-file digests).

Keep this repository **private**. It contains machine names, the list of plugins
you run, and your settings document. It never contains credentials.

Do not hand-edit these files: \`harness-sync push\` rewrites them. To make a change,
change it in DeepSeek Harness and push again.
`;

/** Contents written to `.gitignore` inside the configuration repository, as a second line of defence. */
export const CONFIG_REPO_GITIGNORE = `# --- deepseek-harness-sync secrets (do not remove this line) ---
# Nothing in this plugin ever stages these, and this block makes sure a stray
# manual \`git add -A\` cannot publish them either.
.credentials.yaml
*.token
.env
*.sqlite
*.sqlite-shm
*.sqlite-wal
sessions/
attachments/
storages/
node_modules/
`;

/**
 * Build the execution context shared by every command.
 *
 * @param {{root?: string, dataRoot?: string, profile?: string, device?: string, token?: string, flags?: object, ui?: Ui, env?: NodeJS.ProcessEnv}} [options] - overrides, used by tests and by the CLI.
 * @returns {object} the context.
 */
export function loadContext(options = {}) {
	const env = options.env ?? process.env;
	const ui = options.ui ?? new Ui({ env });
	const paths = resolvePaths({ dshHome: options.root, dataRoot: options.dataRoot, env });
	const state = readState(paths.state);
	return {
		paths,
		env,
		ui,
		state,
		profile: options.profile ?? state?.profile ?? DEFAULT_PROFILE,
		device: options.device ?? state?.device ?? deviceName(env),
		// The workspace root is a property of THIS machine, so it is never synced:
		// machine A's `/home/a/work` means nothing on machine B. It is resolved from,
		// in order, an explicit option, the recorded state, `$DSH_WORKSPACE`, and the
		// workspace the harness itself would default to. When none of those yield a
		// directory, the workspace layer is simply not collected — the harness-home
		// half of a snapshot is unaffected either way.
		workspace: resolveWorkspace({ explicit: options.workspace, state, env, paths }),
		token: Object.hasOwn(options, 'token') ? options.token : resolveToken(env),
		flags: options.flags ?? {},
	};
}

/**
 * Decide which directory this machine treats as the session workspace.
 *
 * Order matters: an explicit flag beats the recorded state, which beats the
 * environment. The state file is per-machine, so a workspace path recorded here
 * says nothing about another device — which is precisely why it is state and not
 * configuration.
 *
 * @param {{explicit?: string, state?: object, env: NodeJS.ProcessEnv}} input - the candidates.
 * @returns {string|undefined} the workspace root, or undefined when none is known.
 */
export function resolveWorkspace(input) {
	const { explicit, state, env } = input;
	const candidates = [
		explicit,
		state?.workspace,
		env?.DSH_WORKSPACE,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
	}
	return undefined;
}

/**
 * Return the state record, or explain how to create one.
 *
 * @param {object} ctx - the context.
 * @returns {object} the state record.
 * @throws {Error} when this device has not been initialized.
 */
export function requireState(ctx) {
	if (ctx.state === undefined) {
		throw new Error(`this device is not initialized yet — run "harness-sync init" first (state file: ${ctx.paths.state})`);
	}
	return ctx.state;
}

/**
 * Read this machine's configuration as a file map, covering both roots.
 *
 * @param {object} ctx - the context.
 * @returns {{files: Record<string, string>, absent: string[], repositories: Array<object>, workspacePresent: boolean, notes: string[], machine: {rel: string, line: number, spec: string}[]}} the local state.
 */
export function readLocal(ctx) {
	const { files, absent, repositories, workspacePresent, notes } = collectAll({
		dshHome: ctx.paths.dshHome,
		profile: ctx.profile,
		workspace: ctx.workspace,
		collectHome: collect,
	});
	return {
		files,
		absent,
		repositories,
		workspacePresent,
		notes,
		// Machine-dependency detection looks only at home paths; a workspace
		// `package.json` is not a harness dependency spec.
		machine: detectMachineDependencies(files, ctx.profile),
	};
}

/**
 * Fetch the remote branch and read the configuration it carries.
 *
 * @param {object} ctx - the context.
 * @returns {{branchExists: boolean, envelope?: object, metadataText?: string, commit?: string}} the remote state.
 */
export function readRemote(ctx) {
	const state = requireState(ctx);
	const { fetched, branchExists, fetchError } = syncWorktree({
		repoDir: ctx.paths.repo,
		url: state.repoUrl,
		branch: state.branch,
		token: ctx.token,
		log: (message) => ctx.ui.dim(message),
	});
	if (!fetched) return { fetched: false, fetchError, branchExists: false };
	if (!branchExists) return { fetched: true, fetchError: '', branchExists: false };
	const snapshotText = readRemoteFile({ repoDir: ctx.paths.repo, branch: state.branch, path: SNAPSHOT_PATH });
	const metadataText = readRemoteFile({ repoDir: ctx.paths.repo, branch: state.branch, path: METADATA_PATH });
	return {
		fetched: true,
		fetchError: '',
		branchExists: true,
		envelope: snapshotText === undefined ? undefined : parseSnapshot(snapshotText),
		metadataText,
	};
}

/**
 * Assemble a snapshot envelope for the local configuration.
 *
 * @param {object} ctx - the context.
 * @param {{files: Record<string, string>, absent: string[], repositories?: Array<object>}} local - the local files.
 * @param {number} version - the version to stamp.
 * @param {string} [reason] - why the snapshot was taken, stored on backups.
 * @returns {object} the envelope.
 */
export function makeEnvelope(ctx, local, version, reason) {
	return buildSnapshot({
		version,
		device: ctx.device,
		profile: ctx.profile,
		files: local.files,
		absent: local.absent,
		// Repository references travel in `preferences`, which older builds already
		// pass through untouched, so a snapshot carrying them still applies on a
		// machine running an earlier version of this plugin.
		preferences: repositoryPreferences(local.repositories ?? []),
		...(reason !== undefined ? { reason } : {}),
	});
}

export { buildMetadata };

/**
 * The exact wording the specification asks for when the two sides have diverged.
 *
 * @param {{localVersion: number, remoteVersion: number}} versions - the two versions.
 * @returns {string} the message.
 */
export function divergenceMessage(versions) {
	return [
		'Remote configuration has changed.',
		'',
		`Local:  version ${versions.localVersion}`,
		`Remote: version ${versions.remoteVersion}`,
		'',
		'Please choose:',
		'',
		'1. Pull remote configuration      harness-sync pull',
		'2. Force push local configuration harness-sync push --force',
		'3. Show differences               harness-sync diff',
	].join('\n');
}

/**
 * The header of the divergence menu, without the numbered choices.
 *
 * @param {{localVersion: number, remoteVersion: number}} versions - the two versions.
 * @returns {string} the header.
 */
export function divergenceHeader(versions) {
	return [
		'Remote configuration has changed.',
		'',
		`Local:  version ${versions.localVersion}`,
		`Remote: version ${versions.remoteVersion}`,
	].join('\n');
}

/**
 * Ask a question on the terminal, when there is one.
 *
 * @param {object} ctx - the context.
 * @param {string} question - the prompt.
 * @param {{defaultValue?: string}} [options] - prompt options.
 * @returns {Promise<string|undefined>} the trimmed answer, or undefined when not interactive.
 */
export async function ask(ctx, question, options = {}) {
	const input = process.stdin;
	if (input.isTTY !== true) return undefined;
	const rl = createInterface({ input, output: process.stdout });
	try {
		const suffix = options.defaultValue === undefined ? '' : ` [${options.defaultValue}]`;
		const answer = await rl.question(`${question}${suffix}: `);
		const trimmed = answer.trim();
		return trimmed === '' ? options.defaultValue : trimmed;
	} finally {
		rl.close();
	}
}

/**
 * Offer numbered choices on the terminal.
 *
 * @param {object} ctx - the context.
 * @param {string} header - text printed before the menu.
 * @param {{label: string}[]} choices - the options.
 * @returns {Promise<number|undefined>} the chosen 1-based index, or undefined when not interactive.
 */
export async function choose(ctx, header, choices) {
	const input = process.stdin;
	if (input.isTTY !== true) return undefined;
	ctx.ui.write(header);
	choices.forEach((choice, index) => ctx.ui.write(`  ${index + 1}. ${choice.label}`));
	const rl = createInterface({ input, output: process.stdout });
	try {
		const answer = (await rl.question('> ')).trim();
		const index = Number.parseInt(answer, 10);
		if (!Number.isInteger(index) || index < 1 || index > choices.length) return undefined;
		return index;
	} finally {
		rl.close();
	}
}

/**
 * Report machine-local dependency specs, which break on another device.
 *
 * @param {object} ctx - the context.
 * @param {{rel: string, line: number, spec: string}[]} machine - detected specs.
 * @returns {void}
 */
export function reportMachineDependencies(ctx, machine) {
	if (machine.length === 0) return;
	ctx.ui.warn(`${machine.length} dependency spec(s) point at a directory on THIS machine and will not resolve elsewhere:`);
	for (const hit of machine) ctx.ui.write(`         ${hit.rel}:${hit.line}  ${hit.spec}`);
	ctx.ui.write('         These are synced as-is. On the next device, either publish that plugin or remove the entry,');
	ctx.ui.write('         then run `pnpm install` in the profile directory.');
}

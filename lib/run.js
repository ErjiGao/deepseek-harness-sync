/**
 * Argument parsing and command dispatch, shared by the CLI and the plugin.
 *
 * Both front doors run exactly this code, so `harness-sync push` in a terminal
 * and `/harness-sync push` in the Web GUI cannot drift apart.
 *
 * @module deepseek-harness-sync/run
 */

import { GitError } from './core/github.js';
import { Ui } from './ui.js';
import { loadContext } from './commands/shared.js';
import { run as runDiff } from './commands/diff.js';
import { run as runExport } from './commands/export.js';
import { run as runInit } from './commands/init.js';
import { run as runPull } from './commands/pull.js';
import { run as runPush } from './commands/push.js';
import { run as runRollback } from './commands/rollback.js';
import { run as runStatus } from './commands/status.js';
import { run as runSync } from './commands/sync.js';

/** The version reported by `--version`; kept in sync with package.json by tests. */
export const VERSION = '0.1.0';

/** The help banner. */
export const HELP = `harness-sync — sync DeepSeek Harness configuration through your own private GitHub repository

Usage
  harness-sync <command> [options]

Commands
  init        connect this device to a private configuration repository
  status      compare this device against the repository
  push        upload this device's configuration
  pull        apply the repository's configuration to this device
  sync        pull, inspect the difference, then synchronize
  diff        show what differs, file by file
  rollback    restore a local backup (written automatically before every pull)
  export      write a restorable snapshot of this device to a file

Options
  --root <dir>        treat <dir> as the harness home instead of $DSH_HOME / ~/.dsh
  --data-root <dir>   store this plugin's state here instead of <harness home>/harness-sync
  --profile <name>    profile to sync (default: web)
  --device <name>     device name recorded in snapshots (default: this machine's hostname)
  --url <url>         repository URL                              (init)
  --user <name>       GitHub username                             (init)
  --repo <name>       repository name                             (init)
  --branch <name>     branch (default: main)                      (init, or to override)
  --force             proceed even though the repository advanced  (push)
  --dry-run           show what would happen, change nothing
  --list              list available backups                      (rollback)
  --to <name|index>   choose a backup to restore                  (rollback)
  --json              machine-readable output                     (status)
  --no-color          disable colour
  -h, --help          show this help
  -v, --version       show the version

Authentication
  Nothing is stored here. Git's own credential helper (Git Credential Manager,
  osxkeychain, libsecret) is used by default, so signing in once is enough.
  In automation, set GH_TOKEN or GITHUB_TOKEN to a fine-grained token that grants
  "Contents: read and write" on the configuration repository only. A token passed
  as a command-line argument would be visible to other processes, so that is
  deliberately not supported.

Exit codes
  0  success        1  error        2  diverged: you must choose (pull or force-push)
`;

/** Options that take a value. */
const VALUE_FLAGS = new Set(['root', 'data-root', 'profile', 'device', 'url', 'user', 'repo', 'branch', 'to']);

/** Options that are booleans. */
const BOOLEAN_FLAGS = new Set(['force', 'dry-run', 'list', 'json', 'no-color', 'help', 'version', 'verbose']);

/** Commands this program understands. */
const COMMANDS = new Set(['init', 'status', 'push', 'pull', 'sync', 'diff', 'rollback', 'export', 'help']);

/**
 * Parse an argument vector.
 *
 * @param {string[]} argv - arguments after the program name.
 * @returns {{command: string|undefined, positionals: string[], flags: Record<string, string|boolean>, unknown: string[]}} the parse.
 */
export function parseArgs(argv) {
	/** @type {Record<string, string|boolean>} */
	const flags = {};
	/** @type {string[]} */
	const positionals = [];
	/** @type {string[]} */
	const unknown = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === '--') {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (token.startsWith('--')) {
			const body = token.slice(2);
			const equals = body.indexOf('=');
			const name = equals === -1 ? body : body.slice(0, equals);
			if (VALUE_FLAGS.has(name)) {
				const value = equals === -1 ? argv[index + 1] : body.slice(equals + 1);
				if (value === undefined || (equals === -1 && value.startsWith('--'))) {
					unknown.push(token);
					continue;
				}
				flags[name] = value;
				if (equals === -1) index += 1;
				continue;
			}
			if (BOOLEAN_FLAGS.has(name)) {
				flags[name] = equals === -1 ? true : body.slice(equals + 1) !== 'false';
				continue;
			}
			unknown.push(token);
			continue;
		}
		if (token === '-h') {
			flags.help = true;
			continue;
		}
		if (token === '-v') {
			flags.version = true;
			continue;
		}
		if (token.startsWith('-') && token !== '-') {
			unknown.push(token);
			continue;
		}
		positionals.push(token);
	}
	const command = positionals.length > 0 && COMMANDS.has(positionals[0]) ? positionals[0] : undefined;
	return {
		command,
		positionals: command === undefined ? positionals : positionals.slice(1),
		flags,
		unknown,
	};
}

/**
 * Parse and run one invocation.
 *
 * @param {string[]} argv - arguments after the program name.
 * @param {{ui?: Ui, env?: NodeJS.ProcessEnv, profile?: string, device?: string, root?: string, dataRoot?: string}} [overrides] - front-door overrides.
 * @returns {Promise<number>} the process exit code.
 */
export async function dispatch(argv, overrides = {}) {
	const parsed = parseArgs(argv);
	const env = overrides.env ?? process.env;
	const ui = overrides.ui ?? new Ui({ env });

	if (parsed.flags.version === true) {
		ui.write(VERSION);
		return 0;
	}
	if (parsed.flags.help === true || parsed.command === 'help') {
		ui.write(HELP.trimEnd());
		return 0;
	}
	if (parsed.command === undefined && parsed.positionals.length === 0) {
		ui.write(HELP.trimEnd());
		return 0;
	}
	if (parsed.command === undefined) {
		ui.fail(`unknown command "${parsed.positionals[0] ?? ''}"`);
		ui.write('Run "harness-sync --help" for the command list.');
		return 1;
	}
	if (parsed.unknown.length > 0) {
		ui.fail(`unknown option(s): ${parsed.unknown.join(', ')}`);
		ui.write('Run "harness-sync --help" for the option list.');
		return 1;
	}
	if (parsed.positionals.length > 0) {
		ui.fail(`unexpected argument(s): ${parsed.positionals.join(' ')}`);
		return 1;
	}

	const flags = parsed.flags;
	/** @type {object} */
	let ctx;
	try {
		ctx = loadContext({
			env,
			ui,
			root: (flags.root ?? overrides.root),
			dataRoot: (flags['data-root'] ?? overrides.dataRoot),
			profile: (flags.profile ?? overrides.profile),
			device: (flags.device ?? overrides.device),
			flags,
			...(Object.hasOwn(overrides, 'token') ? { token: overrides.token } : {}),
		});
	} catch (error) {
		ui.fail(error instanceof Error ? error.message : String(error));
		return 1;
	}

	try {
		switch (parsed.command) {
			case 'init':
				return await runInit(ctx, {
					url: flags.url,
					user: flags.user,
					repo: flags.repo,
					branch: flags.branch,
				});
			case 'status':
				return await runStatus(ctx);
			case 'push':
				return await runPush(ctx);
			case 'pull':
				return await runPull(ctx);
			case 'sync':
				return await runSync(ctx);
			case 'diff':
				return await runDiff(ctx);
			case 'export':
				return await runExport(ctx);
			case 'rollback':
				return await runRollback(ctx, {
					list: flags.list === true,
					to: typeof flags.to === 'string' ? flags.to : undefined,
				});
			default:
				ui.fail(`unknown command "${parsed.command}"`);
				return 1;
		}
	} catch (error) {
		if (error instanceof GitError) {
			ui.fail(error.message);
			return 1;
		}
		ui.fail(error instanceof Error ? error.message : String(error));
		if (flags.verbose === true && error instanceof Error && error.stack !== undefined) ui.write(error.stack);
		return 1;
	}
}

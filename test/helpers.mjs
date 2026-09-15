/**
 * Test fixtures and a runner for the CLI.
 *
 * Every test builds its own throwaway harness home and its own throwaway Git
 * remote under the operating system's temp directory. Nothing in this suite ever
 * reads or writes a real `$DSH_HOME`.
 *
 * @module deepseek-harness-sync/test/helpers
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Ui } from '../lib/ui.js';
import { dispatch } from '../lib/run.js';

/**
 * Create an empty temporary directory.
 *
 * @param {string} prefix - a name fragment for readability.
 * @returns {string} the absolute path.
 */
export function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), `harness-sync-${prefix}-`));
}

/**
 * Build a fake harness home from a map of relative paths to contents.
 *
 * @param {Record<string, string>} files - relative POSIX paths to contents.
 * @param {string} [root] - an existing directory to fill.
 * @returns {string} the root.
 */
export function makeRoot(files, root = tempDir('root')) {
	for (const [rel, text] of Object.entries(files)) {
		const abs = join(root, ...rel.split('/'));
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text, 'utf8');
	}
	return root;
}

/**
 * A realistic, minimal harness home.
 *
 * @param {{profile?: string, settings?: string, extra?: Record<string, string>}} [options] - overrides.
 * @returns {Record<string, string>} the file map.
 */
export function harnessFiles(options = {}) {
	const profile = options.profile ?? 'web';
	return {
		'settings.yaml': options.settings ?? 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n',
		[`profiles/${profile}/package.json`]: `${JSON.stringify({
			name: `dsh-profile-${profile}`,
			private: true,
			dependencies: { '@deepseek-ai/dsh-base': '^0.1.5-rc.1' },
			dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
		}, null, 2)}\n`,
		[`profiles/${profile}/cordis.patch.yml`]: '[]\n',
		[`profiles/${profile}/cordis.yml`]: '[]\n',
		[`profiles/${profile}/pnpm-workspace.yaml`]: 'packages:\n  - .\nnodeLinker: hoisted\n',
		...(options.extra ?? {}),
	};
}

/**
 * Create a bare Git repository to stand in for GitHub.
 *
 * @param {string} [parent] - a directory to create it inside.
 * @returns {string} the absolute path of the bare repository.
 */
export function makeBareRemote(parent = tempDir('git')) {
	const path = join(parent, 'config.git');
	const result = spawnSync('git', ['init', '--bare', '--initial-branch=main', path], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`could not create the bare test remote: ${result.stderr || result.error?.message}`);
	return path;
}

/**
 * A clean environment: no harness home, no token, a pinned device name.
 *
 * @param {Record<string, string>} [extra] - additional variables.
 * @returns {NodeJS.ProcessEnv} the environment.
 */
export function cleanEnv(extra = {}) {
	return {
		PATH: process.env.PATH,
		SYSTEMROOT: process.env.SYSTEMROOT,
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
		HARNESS_SYNC_DEVICE: 'test-device',
		...extra,
	};
}

/**
 * Run one `harness-sync` invocation against a throwaway home, capturing output.
 *
 * @param {string[]} argv - arguments after the program name.
 * @param {{root: string, env?: NodeJS.ProcessEnv, token?: string|null}} options - the home to use.
 * @returns {Promise<{code: number, out: string}>} the exit code and captured output.
 */
export async function runCli(argv, options) {
	/** @type {string[]} */
	const chunks = [];
	const sink = {
		isTTY: false,
		write(chunk) {
			chunks.push(String(chunk));
			return true;
		},
	};
	const ui = new Ui({ out: sink, err: sink, color: false, env: {} });
	const code = await dispatch(argv, {
		ui,
		env: options.env ?? cleanEnv(),
		root: options.root,
		token: options.token ?? null,
	});
	return { code, out: chunks.join('') };
}

/**
 * Run a git command that must succeed.
 *
 * @param {string} cwd - working directory.
 * @param {string[]} args - git arguments.
 * @returns {string} stdout.
 */
function gitMust(cwd, args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
	return result.stdout ?? '';
}

/**
 * Pre-populate a bare remote, standing in for a repository another tool already uses.
 *
 * @param {string} remote - the bare repository path.
 * @param {Record<string, string>} files - relative POSIX paths to contents.
 * @param {string} [branch] - the branch to create.
 * @returns {string} the throwaway working directory used to seed it.
 */
export function seedRemote(remote, files, branch = 'main') {
	const work = tempDir('seed');
	gitMust(work, ['init', '-q']);
	gitMust(work, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
	gitMust(work, ['remote', 'add', 'origin', remote]);
	for (const [rel, text] of Object.entries(files)) {
		const abs = join(work, ...rel.split('/'));
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text, 'utf8');
	}
	gitMust(work, ['add', '-A']);
	gitMust(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@localhost', 'commit', '-q', '-m', 'seed']);
	gitMust(work, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
	return work;
}

/**
 * Read every file at a branch of a bare remote.
 *
 * @param {string} remote - the bare repository path.
 * @param {string} [branch] - the branch to read.
 * @returns {Record<string, string>} relative path to contents.
 */
export function listRemote(remote, branch = 'main') {
	const listing = spawnSync('git', [`--git-dir=${remote}`, 'ls-tree', '-r', '--name-only', branch], { encoding: 'utf8' });
	if (listing.status !== 0) return {};
	/** @type {Record<string, string>} */
	const files = {};
	for (const name of (listing.stdout ?? '').split('\n').filter((line) => line !== '')) {
		const shown = spawnSync('git', [`--git-dir=${remote}`, 'show', `${branch}:${name}`], { encoding: 'utf8' });
		files[name] = shown.stdout ?? '';
	}
	return files;
}

/**
 * Read a file inside a test root, or undefined when it does not exist.
 *
 * @param {string} root - the harness home.
 * @param {string} rel - a relative POSIX path.
 * @returns {string|undefined} the contents.
 */
export function readRel(root, rel) {
	const abs = join(root, ...rel.split('/'));
	return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
}

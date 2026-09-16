/**
 * The Git transport.
 *
 * Design choices worth knowing:
 *
 * - **Nothing is stored.** Authentication is delegated to whatever Git already
 *   uses (Git Credential Manager on Windows/macOS, libsecret on Linux). When a
 *   token is supplied it is injected through `GIT_CONFIG_COUNT` environment
 *   variables, which Git reads but never writes: the token does not reach the
 *   remote URL, `.git/config`, a temp file, the process argument list, or any
 *   log line this module produces.
 * - **Prompts are disabled.** `GIT_TERMINAL_PROMPT=0` stops a missing credential
 *   from hanging a tool call or a non-interactive push forever. Credential
 *   Manager's own GUI/browser flow is unaffected, so the first `push` still
 *   works interactively.
 * - **Every failure is translated.** Raw Git stderr ("Connection was reset")
 *   tells a user nothing; `explainGitError` turns it into an instruction.
 *
 * @module deepseek-harness-sync/core/github
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Fallback commit identity, used only when Git has none configured. */
export const DEFAULT_AUTHOR = { name: 'harness-sync', email: 'harness-sync@localhost' };

/**
 * Ceiling on a single Git command's captured output.
 *
 * Node's default is 1 MiB, which a growing snapshot outgrew. 256 MB is far above
 * anything a configuration snapshot should reach while still being a bound.
 */
export const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * A failed Git invocation, carrying the streams for `explainGitError`.
 */
export class GitError extends Error {
	/**
	 * @param {string} message - a human-readable summary.
	 * @param {{code?: number|null, stdout?: string, stderr?: string, args?: string[]}} [info] - captured process detail.
	 */
	constructor(message, info = {}) {
		super(message);
		this.name = 'GitError';
		this.code = info.code ?? null;
		this.stdout = info.stdout ?? '';
		this.stderr = info.stderr ?? '';
		this.args = info.args ?? [];
	}
}

/**
 * Split a repository URL into the pieces the private check needs.
 *
 * @param {string} input - an HTTPS, SSH or SCP-style Git URL.
 * @returns {{url: string, scheme: 'https'|'ssh', host: string, owner: string, repo: string, origin: string}|undefined} the parse, or undefined when unrecognised.
 */
export function parseRepoUrl(input) {
	const url = String(input).trim();
	const candidates = [
		{ re: /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/, scheme: 'https' },
		{ re: /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/, scheme: 'ssh' },
		{ re: /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?$/, scheme: 'ssh' },
	];
	for (const { re, scheme } of candidates) {
		const match = re.exec(url);
		if (match === null) continue;
		const host = match[1];
		const owner = match[2];
		const repo = match[3];
		return { url, scheme, host, owner, repo, origin: `https://${host}` };
	}
	return undefined;
}

/**
 * Redact secrets from any text before it is shown, logged, or returned.
 *
 * @param {string} text - text that may contain a credential.
 * @param {string[]} secrets - values to remove.
 * @returns {string} the redacted text.
 */
export function redact(text, secrets) {
	let out = String(text);
	for (const secret of secrets) {
		if (typeof secret !== 'string' || secret.length < 8) continue;
		out = out.split(secret).join('***');
	}
	return out;
}

/**
 * Build the child environment, injecting a token when one is available.
 *
 * @param {{url?: string, token?: string, env?: NodeJS.ProcessEnv}} options - inputs.
 * @returns {{env: NodeJS.ProcessEnv, secrets: string[]}} the environment and the values to redact.
 */
function buildEnv(options) {
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, ...(options.env ?? {}) };
	// Never let Git block on a terminal prompt.
	env.GIT_TERMINAL_PROMPT = '0';
	/** @type {string[]} */
	const secrets = [];
	const token = options.token;
	if (typeof token !== 'string' || token === '' || options.url === undefined) return { env, secrets };
	const parsed = parseRepoUrl(options.url);
	// An SSH remote authenticates with a key; an Authorization header means nothing there.
	if (parsed === undefined || parsed.scheme !== 'https') return { env, secrets };
	const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
	const index = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
	env.GIT_CONFIG_COUNT = String(index + 1);
	env[`GIT_CONFIG_KEY_${index}`] = `http.${parsed.origin}/.extraheader`;
	env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${basic}`;
	secrets.push(token, basic, `x-access-token:${token}`);
	return { env, secrets };
}

/**
 * Run one Git command.
 *
 * `maxBuffer` is raised well above Node's 1 MiB default on purpose. A snapshot
 * is one JSON document holding every tracked file, so it grows with the
 * configuration: the moment the remote snapshot passed 1 MiB, `git show` failed
 * with `ENOBUFS` and — because that read used to swallow its own failure — every
 * status call broke and the divergence check silently stopped running. The cap is
 * a ceiling, not an allocation, so a generous value costs nothing until reached.
 *
 * @param {string[]} args - Git arguments, without the leading `git`.
 * @param {{cwd?: string, url?: string, token?: string, env?: NodeJS.ProcessEnv, allowFailure?: boolean, input?: string}} [options] - invocation options.
 * @returns {{code: number, stdout: string, stderr: string, secrets: string[]}} the result.
 * @throws {GitError} when Git is missing, or exits non-zero and `allowFailure` is not set.
 */
export function git(args, options = {}) {
	const { env, secrets } = buildEnv(options);
	const result = spawnSync('git', args, {
		cwd: options.cwd,
		env,
		encoding: 'utf8',
		windowsHide: true,
		input: options.input,
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
	});
	if (result.error !== undefined) {
		if (result.error.code === 'ENOENT') {
			throw new GitError('git is not installed or not on PATH — install Git and try again', { args });
		}
		if (result.error.code === 'ENOBUFS') {
			throw new GitError(
				`git ${args[0]} produced more output than this plugin will buffer (${Math.round(MAX_GIT_OUTPUT_BYTES / 1024 / 1024)} MB). This usually means the configuration repository has grown far beyond configuration — check what is being snapshotted.`,
				{ args },
			);
		}
		throw new GitError(`could not run git: ${result.error.message}`, { args });
	}
	const code = result.status ?? 1;
	const stdout = redact(result.stdout ?? '', secrets);
	const stderr = redact(result.stderr ?? '', secrets);
	if (code !== 0 && options.allowFailure !== true) {
		throw new GitError(`git ${args[0]} failed (exit ${code}): ${explainGitError(stderr)}`, { code, stdout, stderr, args });
	}
	return { code, stdout, stderr, secrets };
}

/**
 * Translate Git's stderr into something a user can act on.
 *
 * @param {string} stderr - the captured stderr, already redacted.
 * @returns {string} a hint-bearing message.
 */
export function explainGitError(stderr) {
	const text = stderr.trim();
	const last = text.split('\n').filter((line) => line.trim() !== '').slice(-1)[0] ?? '';
	if (/could not read Username|Authentication failed|terminal prompts disabled|invalid username or password|403/i.test(text)) {
		return `${last}\n  hint: Git has no credential for this repository. Either sign in once with Git Credential Manager (run any git command against the repo in a terminal), or set GH_TOKEN / GITHUB_TOKEN to a fine-grained PAT that grants "Contents: read and write" on this one repository.`;
	}
	if (/Could not resolve host|Failed to connect|Connection was reset|Connection timed out|unable to access/i.test(text)) {
		return `${last}\n  hint: this machine cannot reach the Git host. If you are behind a proxy, set it with: git config --global http.proxy http://host:port (and https.proxy), or export HTTPS_PROXY.`;
	}
	if (/not found|does not exist|Repository not found/i.test(text)) {
		return `${last}\n  hint: the repository is missing, misspelled, or the credential does not grant access to it. Check the owner/repo in "harness-sync status".`;
	}
	if (/non-fast-forward|rejected|fetch first/i.test(text)) {
		return `${last}\n  hint: the remote moved while this ran. Re-run the command; a genuine divergence is reported by "harness-sync status" before anything is overwritten.`;
	}
	if (/not a git repository/i.test(text)) {
		return `${last}\n  hint: the local clone is not a Git repository. Delete the "repo" directory under the plugin data root and re-run.`;
	}
	return last === '' ? 'no output' : last;
}

/**
 * Reset this plugin's working clone so its files match the remote branch.
 *
 * The directory is owned exclusively by this plugin, so discarding local state
 * here is safe and is what makes every later read a pure read of the remote.
 *
 * @param {{repoDir: string, url: string, branch: string, token?: string, log?: (message: string) => void}} options - inputs.
 * @returns {{fetched: boolean, branchExists: boolean, fetchError: string}} what the remote offered.
 */
export function syncWorktree(options) {
	const { repoDir, url, branch, token, log = () => {} } = options;
	mkdirSync(repoDir, { recursive: true });
	const call = (args, extra = {}) => git(args, { cwd: repoDir, url, token, ...extra });
	if (!existsSync(join(repoDir, '.git'))) {
		call(['init', '-q']);
		// `init -b` needs Git 2.28+; symbolic-ref works everywhere.
		call(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
		call(['remote', 'add', 'origin', url]);
		log(`initialized local clone at ${repoDir}`);
	}
	call(['remote', 'set-url', 'origin', url]);
	const fetch = call(['fetch', '--prune', 'origin'], { allowFailure: true });
	const fetched = fetch.code === 0;
	const branchExists = fetched && call(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFailure: true }).code === 0;
	if (branchExists) {
		call(['checkout', '-q', '-B', branch, `origin/${branch}`]);
		call(['reset', '-q', '--hard', `origin/${branch}`]);
	} else if (fetched) {
		call(['checkout', '-q', '-B', branch]);
	}
	return {
		fetched,
		branchExists,
		fetchError: fetched ? '' : explainGitError(fetch.stderr),
	};
}

/**
 * Read one file at the remote branch without touching the working tree.
 *
 * Absence and failure are answered differently on purpose. "The remote does not
 * have this file" is an ordinary state — a brand-new repository has no snapshot —
 * but "git could not tell us" is not, and returning `undefined` for both would
 * let a failed read masquerade as an empty remote, silently switching the
 * divergence check off. That is precisely what happened when this read hit
 * `ENOBUFS`: pushes kept succeeding while the safety check did nothing.
 *
 * So the cheap, output-free probes decide absence, and the read itself is
 * allowed to throw.
 *
 * @param {{repoDir: string, branch: string, path: string}} options - inputs.
 * @returns {string|undefined} the file text, or undefined when it does not exist.
 * @throws {GitError} when the branch or file cannot be read for any other reason.
 */
export function readRemoteFile(options) {
	const { repoDir, branch, path } = options;
	const ref = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repoDir, allowFailure: true });
	// No such remote branch yet: the repository exists but carries nothing.
	if (ref.code !== 0) return undefined;
	const probe = git(['cat-file', '-e', `origin/${branch}:${path}`], { cwd: repoDir, allowFailure: true });
	// The branch exists but not this file: an ordinary empty-remote state.
	if (probe.code !== 0) return undefined;
	return git(['show', `origin/${branch}:${path}`], { cwd: repoDir }).stdout;
}

/**
 * Resolve the commit identity Git would use, falling back to a local default.
 *
 * A fresh machine often has no `user.name`/`user.email` at all, which makes
 * `git commit` fail outright. Rather than writing to the user's global config,
 * the identity is passed per-invocation.
 *
 * @param {string} repoDir - the working clone.
 * @returns {{name: string, email: string, source: 'git-config'|'default'}} the identity.
 */
export function resolveAuthor(repoDir) {
	const email = git(['config', 'user.email'], { cwd: repoDir, allowFailure: true }).stdout.trim();
	const name = git(['config', 'user.name'], { cwd: repoDir, allowFailure: true }).stdout.trim();
	if (email !== '' && name !== '') return { name, email, source: 'git-config' };
	return { ...DEFAULT_AUTHOR, source: 'default' };
}

/**
 * Stage everything and commit, if there is anything to commit.
 *
 * @param {{repoDir: string, message: string}} options - inputs.
 * @returns {{committed: boolean, author: {name: string, email: string, source: string}}} the outcome.
 */
export function commitAll(options) {
	const { repoDir, message } = options;
	git(['add', '-A'], { cwd: repoDir });
	const status = git(['status', '--porcelain'], { cwd: repoDir }).stdout;
	const author = resolveAuthor(repoDir);
	if (status.trim() === '') return { committed: false, author };
	git(
		['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', message],
		{ cwd: repoDir },
	);
	return { committed: true, author };
}

/**
 * Push the current HEAD to the configured branch.
 *
 * @param {{repoDir: string, branch: string, url: string, token?: string, force?: boolean}} options - inputs.
 */
export function pushBranch(options) {
	const { repoDir, branch, url, token, force = false } = options;
	const args = ['push', 'origin', `HEAD:refs/heads/${branch}`];
	if (force) args.push('--force-with-lease');
	git(args, { cwd: repoDir, url, token });
}

/**
 * Check that a repository and branch are reachable with the current credentials.
 *
 * @param {{url: string, branch: string, token?: string}} options - inputs.
 * @returns {{ok: boolean, branchExists: boolean, message: string}} the verdict.
 */
export function probeRemote(options) {
	const { url, branch, token } = options;
	const result = git(['ls-remote', '--heads', url, branch], { url, token, allowFailure: true });
	if (result.code !== 0) {
		return { ok: false, branchExists: false, message: explainGitError(result.stderr) };
	}
	return {
		ok: true,
		branchExists: result.stdout.trim() !== '',
		message: result.stdout.trim() === '' ? `reachable, but it has no "${branch}" branch yet` : `reachable, "${branch}" exists`,
	};
}

/**
 * The current commit id of the remote branch, or undefined when there is none.
 *
 * @param {{repoDir: string, branch: string}} options - inputs.
 * @returns {string|undefined} the commit id.
 */
export function remoteHead(options) {
	const { repoDir, branch } = options;
	const result = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: repoDir, allowFailure: true });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Find a GitHub token without ever asking the user to paste one into a file.
 *
 * Order: `GH_TOKEN`, then `GITHUB_TOKEN`, then the GitHub CLI's own store via
 * `gh auth token`. Returning undefined is normal and not an error — with no
 * token, authentication falls through to Git's credential helper, which is the
 * preferred path anyway.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string|undefined} the token, when one can be found.
 */
export function resolveToken(env = process.env) {
	for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
		const value = env[name];
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	const result = spawnSync('gh', ['auth', 'token'], {
		encoding: 'utf8',
		windowsHide: true,
		timeout: 5000,
		// `gh` must never open a browser or block waiting for input.
		env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
	});
	if (result.error !== undefined || result.status !== 0) return undefined;
	const token = (result.stdout ?? '').trim();
	return token === '' ? undefined : token;
}

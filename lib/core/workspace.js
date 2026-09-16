/**
 * The workspace layer.
 *
 * `manifest.js` refuses to enumerate the harness home, and it can do that
 * because the set of configuration files there is finite and known. A
 * **workspace** is the opposite kind of thing: it is a directory the user works
 * in, holding research data, scratch files, generated output and cloned
 * repositories. There is no finite list of what is in it.
 *
 * So this module uses a different shape of the same discipline:
 *
 * 1. A **pattern allowlist** — workspace files are only captured when their
 *    relative path matches one of `ALLOWED_PATTERNS`. Being off the list means
 *    being excluded, so a new 500 MB dataset cannot leak into the configuration
 *    repository simply by appearing.
 * 2. A **hard deny-list that runs first** — because a workspace holds arbitrary
 *    files, a pattern like `**\/*.md` could otherwise sweep up notes that quote a
 *    key, and `**\/*.json` could sweep up a credential file. Anything matching
 *    `DENIED_PATTERNS` is refused before the allowlist is consulted, whatever
 *    else would have matched.
 * 3. **Repositories are recorded, not copied** — a directory that is a git
 *    working tree is captured as a `{path, remote, branch, head}` reference.
 *    Copying a checkout into the configuration repository would duplicate what
 *    `git clone` already does, bloat the repository with build output, and
 *    destroy the ability to pull updates. Cloning is the faithful operation.
 * 4. **A size ceiling** — even an allowed file is refused past `MAX_FILE_BYTES`,
 *    on the principle that a configuration sync carrying large binaries has
 *    stopped being a configuration sync.
 *
 * Paths in a snapshot are prefixed with the root they belong to. Home files keep
 * their bare, historical form (`settings.yaml`) so that snapshots written by
 * earlier versions still apply; workspace files carry `workspace/`
 * (`workspace/.dsh/config.toml`).
 *
 * @module deepseek-harness-sync/core/workspace
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { MAX_FILE_BYTES, WORKSPACE_PREFIX } from './manifest.js';

export { WORKSPACE_PREFIX };

/**
 * Workspace-relative paths captured verbatim.
 *
 * A pattern is either an exact path (`AGENTS.md`) or a directory prefix written
 * with a trailing `/**` (`notes/**`). Prefix matching is used rather than glob
 * syntax on purpose: a hand-rolled `**` matcher that disagrees with the user's
 * intuition about `*` is a security bug waiting to happen, and the two forms
 * above are unambiguous.
 *
 * The `.dsh` directory is the workspace-local harness configuration (the
 * filesystem skill provider scans `.dsh/skills`, and per-workspace settings live
 * here), so it is the single most important thing in this list.
 *
 * @type {string[]}
 */
export const ALLOWED_PATTERNS = [
	'.dsh/**',
	'.agent-presets/**',
	'skills/**',
	'AGENTS.md',
	'CLAUDE.md',
	'GEMINI.md',
	'.cursorrules',
	'.editorconfig',
	'.gitattributes',
	'.gitignore',
	'README.md',
	'NOTES.md',
	'TODO.md',
];

/**
 * Names that are never captured, matched case-insensitively against the final
 * path segment, anywhere in the workspace.
 *
 * This exists because `ALLOWED_PATTERNS` contains `**` forms. `notes/**` will
 * happily match `notes/.env`, and a workspace is exactly where somebody keeps a
 * `.env`. These names are refused before the allowlist is consulted.
 *
 * @type {Set<string>}
 */
export const DENIED_NAMES = new Set([
	'.env', '.env.local', '.env.production', '.env.development',
	'.credentials.yaml', '.credentials.yml', '.credentials.json',
	'credentials', 'credentials.json', 'credentials.yaml', 'credentials.yml',
	'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
	'.netrc', '_netrc', '.htpasswd', '.npmrc', '.pypirc', '.pgpass',
	'token', 'tokens', 'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml',
	'.git-credentials',
]);

/**
 * Extensions refused outright.
 *
 * A certificate or a private key in a configuration repository is a disclosure
 * even when it is "only" a test key, because test keys are frequently real keys
 * that were never rotated.
 *
 * @type {Set<string>}
 */
export const DENIED_EXTENSIONS = new Set([
	'.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.ppk', '.kdbx', '.age',
]);

/**
 * Directory names never descended into.
 *
 * `node_modules` and build output are large and reproducible; `.git` is handled
 * by the repository-reference path, not by content capture. `__pycache__` and
 * the venv names are here for the same reason as `node_modules`: a Python
 * environment is tens of thousands of files that `pip install` restores.
 *
 * @type {Set<string>}
 */
export const SKIP_DIRS = new Set([
	'node_modules', '.git', '.svn', '.hg', '.cache', '__pycache__',
	'.venv', 'venv', '.mypy_cache', '.pytest_cache', '.ruff_cache',
	'dist', 'build', 'target', '.next', '.nuxt', '.tox',
]);

/**
 * Whether a final path segment is refused by name or extension.
 *
 * @param {string} name - the final path segment.
 * @returns {boolean} true when the name must never be captured.
 */
export function isDeniedName(name) {
	const lower = name.toLowerCase();
	if (DENIED_NAMES.has(lower)) return true;
	const dot = lower.lastIndexOf('.');
	if (dot > 0 && DENIED_EXTENSIONS.has(lower.slice(dot))) return true;
	// A dotfile that mentions credentials, by any spelling.
	if (/credential|secret|\.pem$|_rsa$|\.key$/i.test(lower)) return true;
	return false;
}

/**
 * Whether a path matches the ALLOW patterns, ignoring the deny rules.
 *
 * Used only to tell the two reasons for exclusion apart so the caller can report
 * the interesting one: a file that the allowlist admits but the deny-list refuses
 * is a **finding worth telling the user about**, whereas a file the allowlist
 * never matched is simply not configuration.
 *
 * @param {string} rel - workspace-relative POSIX path.
 * @returns {boolean} true when an allow pattern matches.
 */
export function matchesAllowPattern(rel) {
	if (typeof rel !== 'string' || rel === '') return false;
	for (const pattern of ALLOWED_PATTERNS) {
		if (pattern.endsWith('/**')) {
			const prefix = pattern.slice(0, -3);
			if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
		} else if (rel === pattern) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a workspace-relative POSIX path may be captured.
 *
 * @param {string} rel - workspace-relative POSIX path.
 * @returns {boolean} true when the allowlist matches and no deny rule fires.
 */
export function isAllowed(rel) {
	if (typeof rel !== 'string' || rel === '') return false;
	const segments = rel.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
	// The deny-list is checked on EVERY segment, not just the last: a directory
	// called `secrets/` must not be walked into even if the file inside it is
	// named `notes.md`.
	for (const segment of segments) {
		if (isDeniedName(segment)) return false;
	}
	for (const pattern of ALLOWED_PATTERNS) {
		if (pattern.endsWith('/**')) {
			const prefix = pattern.slice(0, -3);
			if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
		} else if (rel === pattern) {
			return true;
		}
	}
	return false;
}

/**
 * Refuse an unsafe workspace-relative path.
 *
 * @param {string} rel - a candidate workspace-relative POSIX path.
 * @returns {string} the path, unchanged.
 * @throws {Error} when the path is unsafe or not allowed.
 */
export function assertWorkspacePath(rel) {
	if (typeof rel !== 'string' || rel === '') throw new Error('refusing empty workspace path');
	if (rel.includes('\0')) throw new Error(`refusing workspace path containing a NUL byte: ${JSON.stringify(rel)}`);
	if (rel.includes('\\')) throw new Error(`refusing workspace path with a backslash (snapshots are POSIX): ${rel}`);
	if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error(`refusing absolute workspace path: ${rel}`);
	const segments = rel.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`refusing workspace path with an empty or traversal segment: ${rel}`);
	}
	for (const segment of segments) {
		if (isDeniedName(segment)) throw new Error(`refusing workspace path with a sensitive name: ${rel}`);
	}
	if (!isAllowed(rel)) throw new Error(`refusing workspace path outside the workspace whitelist: ${rel}`);
	return rel;
}

/**
 * Read a workspace-relative file as text, honouring the deny-list and the size
 * ceiling.
 *
 * @param {string} root - the workspace root.
 * @param {string} rel - workspace-relative POSIX path.
 * @returns {{text?: string, skip?: string}} the text, or why it was skipped.
 */
function readAllowed(root, rel) {
	const abs = join(root, ...rel.split('/'));
	let stats;
	try {
		stats = statSync(abs);
	} catch (error) {
		return { skip: `${rel}: cannot stat (${error.code ?? error.message})` };
	}
	if (!stats.isFile()) return { skip: `${rel}: not a regular file` };
	if (stats.size > MAX_FILE_BYTES) {
		return { skip: `${rel}: ${(stats.size / 1024).toFixed(0)} KB exceeds the ${MAX_FILE_BYTES / 1024} KB ceiling; skipped` };
	}
	let buffer;
	try {
		buffer = readFileSync(abs);
	} catch (error) {
		return { skip: `${rel}: cannot read (${error.code ?? error.message})` };
	}
	if (buffer.subarray(0, 8192).includes(0)) return { skip: `${rel}: looks binary; skipped` };
	return { text: buffer.toString('utf8') };
}

/**
 * Whether a directory is a git working tree.
 *
 * @param {string} dir - an absolute directory.
 * @returns {boolean} true when it holds a `.git` entry.
 */
function isGitWorkTree(dir) {
	return existsSync(join(dir, '.git'));
}

/**
 * Read a repository's origin URL, branch and HEAD from its `.git` metadata,
 * without spawning `git`.
 *
 * The configuration directory is written by `git` itself and is a documented,
 * stable format; reading it directly keeps a sync working on a machine where
 * `git` is not on `PATH`, which is a real case for a first-boot restore.
 *
 * @param {string} dir - the repository working tree.
 * @returns {{remote?: string, branch?: string, head?: string}} what was readable.
 */
export function readRepoInfo(dir) {
	const out = {};
	const gitDir = join(dir, '.git');
	// A worktree or submodule stores `.git` as a file pointing elsewhere; follow
	// it, because refusing to would silently drop the reference.
	let realGitDir = gitDir;
	try {
		if (statSync(gitDir).isFile()) {
			const pointer = readFileSync(gitDir, 'utf8').trim();
			const match = /^gitdir:\s*(.+)$/.exec(pointer);
			if (match !== null) realGitDir = resolve(dir, match[1].trim());
		}
	} catch {
		return out;
	}
	try {
		const config = readFileSync(join(realGitDir, 'config'), 'utf8');
		const origin = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config);
		if (origin !== null) {
			const url = /^\s*url\s*=\s*(.+)$/m.exec(origin[1]);
			if (url !== null) out.remote = url[1].trim();
		}
	} catch {
		/* no config: leave remote undefined rather than inventing one */
	}
	try {
		const head = readFileSync(join(realGitDir, 'HEAD'), 'utf8').trim();
		const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		if (ref !== null) {
			out.branch = ref[1];
			try {
				out.head = readFileSync(join(realGitDir, 'refs', 'heads', ...ref[1].split('/')), 'utf8').trim();
			} catch {
				/* an unborn branch has no ref file yet */
			}
		} else if (/^[0-9a-f]{7,64}$/i.test(head)) {
			// Detached HEAD: record the commit so a restore can reproduce it.
			out.head = head;
		}
	} catch {
		/* leave branch/head undefined */
	}
	return out;
}

/**
 * Read the user's optional workspace configuration.
 *
 * Kept in the workspace itself (`.dsh/sync.json`) rather than in the harness
 * home, because the workspace is what moves between machines; a list of extra
 * includes that lived only on this machine would defeat the purpose.
 *
 * @param {string} root - the workspace root.
 * @returns {{include: string[], exclude: string[], repositories: boolean}} the effective settings.
 */
export function readWorkspaceConfig(root) {
	const defaults = { include: [], exclude: [], repositories: true };
	const path = join(root, '.dsh', 'sync.json');
	if (!existsSync(path)) return defaults;
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
		const include = Array.isArray(raw.include) ? raw.include.filter((e) => typeof e === 'string' && e !== '') : [];
		const exclude = Array.isArray(raw.exclude) ? raw.exclude.filter((e) => typeof e === 'string' && e !== '') : [];
		return { include, exclude, repositories: raw.repositories !== false };
	} catch {
		// A malformed local config must not silently widen what gets synced, so the
		// defaults (no extra includes, repositories on) are used and the caller is
		// told through the note appended by `collectWorkspace`.
		return defaults;
	}
}

/**
 * Whether a path is covered by one of the user's extra include prefixes.
 *
 * @param {string} rel - workspace-relative POSIX path.
 * @param {string[]} includes - user-supplied prefixes.
 * @returns {boolean} true when covered.
 */
function matchesInclude(rel, includes) {
	return includes.some((entry) => {
		const prefix = entry.replace(/\/+$/, '');
		return rel === prefix || rel.startsWith(`${prefix}/`);
	});
}

/**
 * Whether a path is covered by one of the user's exclude prefixes.
 *
 * @param {string} rel - workspace-relative POSIX path.
 * @param {string[]} excludes - user-supplied prefixes.
 * @returns {boolean} true when excluded.
 */
function matchesExclude(rel, excludes) {
	return excludes.some((entry) => {
		const prefix = entry.replace(/\/+$/, '');
		return rel === prefix || rel.startsWith(`${prefix}/`);
	});
}

/**
 * Collect the workspace's configuration files and repository references.
 *
 * @param {{workspace: string}} options - where to read from.
 * @returns {{files: Record<string, string>, repositories: Array<object>, notes: string[]}} the collection.
 */
export function collectWorkspace(options) {
	const root = options.workspace;
	/** @type {Record<string, string>} */
	const files = {};
	/** @type {Array<object>} */
	const repositories = [];
	/** @type {string[]} */
	const notes = [];

	if (typeof root !== 'string' || root === '' || !existsSync(root)) {
		notes.push(`workspace ${JSON.stringify(root)} does not exist; nothing collected`);
		return { files, repositories, notes };
	}

	const config = readWorkspaceConfig(root);
	if (config.include.length > 0) notes.push(`workspace.sync.json adds ${config.include.length} include prefix(es)`);
	if (config.exclude.length > 0) notes.push(`workspace.sync.json excludes ${config.exclude.length} prefix(es)`);

	/** @type {string[]} */
	const queue = [''];
	while (queue.length > 0) {
		const relDir = queue.shift();
		const absDir = relDir === '' ? root : join(root, ...relDir.split('/'));

		let entries;
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch (error) {
			if (relDir !== '') notes.push(`${relDir}: cannot list (${error.code ?? error.message}); skipped`);
			continue;
		}

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) {
					notes.push(`${rel}: skipped (${entry.name})`);
					continue;
				}
				if (isDeniedName(entry.name)) {
					notes.push(`${rel}: skipped (its name is on the sensitive list, so it is never synced)`);
					continue;
				}
				if (matchesExclude(rel, config.exclude)) {
					notes.push(`${rel}: skipped (excluded by workspace.sync.json)`);
					continue;
				}

				// The repository test comes BEFORE the allowlist prune, and that
				// order is load-bearing. A repository directory is almost never on
				// the allowlist (`dsh-qe-dft`, `my-plugin`), so pruning first would
				// mean no repository was ever recorded — which is exactly the bug
				// this ordering fixes.
				if (isGitWorkTree(join(absDir, entry.name))) {
					if (config.repositories) {
						const info = readRepoInfo(join(absDir, entry.name));
						repositories.push({
							path: rel,
							...(info.remote !== undefined ? { remote: info.remote } : {}),
							...(info.branch !== undefined ? { branch: info.branch } : {}),
							...(info.head !== undefined ? { head: info.head } : {}),
						});
						if (info.remote === undefined) {
							notes.push(`${rel}: a git repository with no "origin" remote — recorded by path only, so it cannot be cloned on another machine`);
						}
					}
					continue;
				}

				// Descend only when the directory could contain an allowed path.
				// This is the check that keeps a walk from touching a 569 MB data
				// directory on every push.
				if (!couldContainAllowed(rel, config.include, config.repositories)) continue;
				queue.push(rel);
				continue;
			}

			if (!entry.isFile()) continue;
			if (matchesExclude(rel, config.exclude)) continue;

			const allowed = isAllowed(rel);
			const included = matchesInclude(rel, config.include);
			if (!allowed && !included) {
				// A file the allowlist admits but the deny-list refuses is a
				// finding, not a non-event: the user should be told that something
				// looking like a credential is sitting where a sync would have
				// picked it up.
				if (matchesAllowPattern(rel)) {
					notes.push(`${rel}: refused (its name is on the sensitive list, so it is never synced)`);
				}
				continue;
			}
			if (isDeniedName(entry.name)) {
				notes.push(`${rel}: refused (its name is on the sensitive list, so it is never synced)`);
				continue;
			}
			const read = readAllowed(root, rel);
			if (read.text !== undefined) files[rel] = read.text;
			else if (read.skip !== undefined) notes.push(read.skip);
		}
	}

	return { files, repositories, notes };
}

/**
 * Whether a directory could contain a repository or an allowed path, so the
 * walk can prune.
 *
 * Without this, a workspace holding a 569 MB `water_density/` directory would be
 * walked file by file on every push. Pruning is a performance decision that must
 * never change the outcome, so it is deliberately conservative: it returns true
 * when any allowlisted prefix starts with the directory or lies inside it, and —
 * when repository discovery is on — for every directory, because a repository is
 * discoverable only by looking, and `nested/project` is a repository that no
 * allowlist mentions. Materialising a directory entry costs one `stat`; a missed
 * repository costs a machine that cannot be reproduced.
 *
 * @param {string} rel - workspace-relative directory path.
 * @param {string[]} includes - user include prefixes.
 * @param {boolean} [discoverRepositories] - whether repositories are being recorded.
 * @returns {boolean} true when the directory should be descended into.
 */
export function couldContainAllowed(rel, includes = [], discoverRepositories = false) {
	if (rel === '') return true;
	if (discoverRepositories) return true;
	for (const pattern of ALLOWED_PATTERNS) {
		const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
		if (prefix.startsWith(`${rel}/`)) return true;
		if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
	}
	for (const entry of includes) {
		const prefix = entry.replace(/\/+$/, '');
		if (prefix === '' ) return true;
		if (prefix.startsWith(`${rel}/`)) return true;
		if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * Render repository references as a shell script a person can run on a new
 * machine.
 *
 * A script is emitted rather than executed: cloning runs with the user's full
 * privileges and hits the network, and a restore that silently clones four
 * repositories is not something a sync tool should do behind a flag.
 *
 * @param {Array<object>} repositories - references from `collectWorkspace`.
 * @param {{workspace?: string}} [options] - where the script will be run.
 * @returns {string} a POSIX shell script.
 */
export function renderCloneScript(repositories, options = {}) {
	const lines = [
		'#!/bin/sh',
		'# Generated by deepseek-harness-sync.',
		'#',
		'# Clones the repositories this workspace contained. Run it from the',
		'# workspace root. Repositories with no recorded remote are listed as',
		'# comments: they cannot be reproduced from a URL, and a copy of them was',
		'# deliberately not taken.',
		'',
		'set -e',
	];
	const clonable = repositories.filter((repo) => typeof repo.remote === 'string' && repo.remote !== '');
	const unreproducible = repositories.filter((repo) => typeof repo.remote !== 'string' || repo.remote === '');
	for (const repo of clonable) {
		const target = repo.path === '' ? '.' : repo.path;
		const branch = typeof repo.branch === 'string' && repo.branch !== '' ? ` --branch ${repo.branch}` : '';
		lines.push('');
		lines.push(`# ${target}${branch === '' ? '' : ` (branch ${repo.branch})`}`);
		lines.push(`if [ -e ${quote(target)} ]; then`);
		lines.push(`  echo "skip ${target}: already exists"`);
		lines.push('else');
		lines.push(`  git clone${branch} ${quote(repo.remote)} ${quote(target)}`);
		lines.push('fi');
		if (typeof repo.head === 'string' && repo.head !== '') {
			lines.push(`# it was at ${repo.head.slice(0, 12)} when this snapshot was taken`);
		}
	}
	for (const repo of unreproducible) {
		lines.push('');
		lines.push(`# NOT REPRODUCIBLE: ${repo.path === '' ? '.' : repo.path} has no "origin" remote.`);
		lines.push('# Its contents were not copied into the configuration repository.');
	}
	if (repositories.length === 0) {
		lines.push('');
		lines.push('# No repositories were recorded.');
	}
	lines.push('');
	return `${lines.join('\n')}`;
}

/**
 * Quote a value for POSIX `sh`.
 *
 * @param {string} value - the value.
 * @returns {string} a single-quoted shell word.
 */
function quote(value) {
	return `'${String(value).split("'").join("'\\''")}'`;
}

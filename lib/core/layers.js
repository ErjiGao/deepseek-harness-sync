/**
 * Assembling a snapshot that covers both roots.
 *
 * A DeepSeek Harness installation is two directories, not one:
 *
 * - the **harness home** (`$DSH_HOME`), holding settings, profiles, skills and
 *   presets — a finite, known set of files;
 * - the **workspace**, holding the project the user actually works in — session
 *   configuration, notes, and cloned repositories, alongside research data that
 *   must never be shipped.
 *
 * `collect.js` and `apply.js` each handle one root and know nothing about the
 * other. This module is the seam: it runs both collectors, merges the results
 * under a path scheme that says which root each file belongs to, and resolves
 * that scheme back to a native path when applying.
 *
 * Keeping the seam in one place is what makes the two whitelists impossible to
 * confuse. A workspace path is never validated by the home's rules, and a home
 * path is never validated by the workspace's.
 *
 * @module deepseek-harness-sync/core/layers
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertSnapshotPath, splitSnapshotPath } from './manifest.js';
import { nativePath } from './collect.js';
import { assertWorkspacePath, collectWorkspace, renderCloneScript } from './workspace.js';

/** Repository-relative path of the generated clone script. */
export const CLONE_SCRIPT_PATH = 'workspace-repos.sh';

/** Repository-relative path of the machine-readable repository list. */
export const REPOS_PATH = 'config/workspace-repos.json';

/**
 * Resolve a snapshot path to a native absolute path.
 *
 * @param {{dshHome: string, workspace?: string, rel: string}} options - the roots and the path.
 * @returns {string} the native absolute path.
 * @throws {Error} when the path names the workspace but no workspace root is known.
 */
export function resolveSnapshotPath(options) {
	const { dshHome, workspace, rel } = options;
	const split = splitSnapshotPath(rel);
	if (split.target === 'workspace') {
		if (typeof workspace !== 'string' || workspace === '') {
			throw new Error(`the snapshot entry ${rel} belongs to a workspace, but no workspace root is known on this machine; pass --workspace`);
		}
		return join(workspace, ...split.path.split('/'));
	}
	return nativePath(dshHome, split.path);
}

/**
 * Collect both roots into one file map.
 *
 * @param {{dshHome: string, profile: string, workspace?: string, collectHome?: Function}} options - where to read.
 * @returns {{files: Record<string, string>, absent: string[], repositories: Array<object>, notes: string[], workspacePresent: boolean}} the collection.
 */
export function collectAll(options) {
	const { dshHome, profile, workspace } = options;
	if (typeof options.collectHome !== 'function') {
		throw new Error('collectAll requires a collectHome function; refusing to guess how to read the harness home');
	}
	const home = options.collectHome({ dshHome, profile });
	/** @type {Record<string, string>} */
	const files = { ...home.files };

	const workspacePresent = typeof workspace === 'string' && workspace !== '' && existsSync(workspace);
	let repositories = [];
	/** @type {string[]} */
	const notes = [...home.notes];
	if (workspacePresent) {
		const ws = collectWorkspace({ workspace });
		for (const [rel, text] of Object.entries(ws.files)) files[`workspace/${rel}`] = text;
		repositories = ws.repositories;
		notes.push(...ws.notes);
	} else {
		notes.push('no workspace was configured, so only the harness home is covered');
	}

	return {
		files,
		// Only the home can record absence: its file list is finite and known, so a
		// missing entry is meaningful. A workspace file that is missing is simply
		// not configuration, and recording it absent would let a snapshot delete an
		// arbitrary path.
		absent: home.absent,
		repositories,
		notes,
		workspacePresent,
	};
}

/**
 * Build the preferences block that travels with the repositories.
 *
 * @param {Array<object>} repositories - references from `collectWorkspace`.
 * @returns {Record<string, unknown>} the preferences fragment.
 */
export function repositoryPreferences(repositories) {
	return {
		repositories: repositories.map((repo) => ({
			path: repo.path,
			...(repo.remote !== undefined ? { remote: repo.remote } : {}),
			...(repo.branch !== undefined ? { branch: repo.branch } : {}),
			...(repo.head !== undefined ? { head: repo.head } : {}),
		})),
	};
}

/**
 * Read back the repository list a snapshot carried.
 *
 * @param {object} envelope - a snapshot envelope.
 * @returns {Array<object>} the references.
 */
export function repositoriesFrom(envelope) {
	const raw = envelope?.preferences?.repositories;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
		.map((entry) => ({
			path: entry.path,
			...(typeof entry.remote === 'string' ? { remote: entry.remote } : {}),
			...(typeof entry.branch === 'string' ? { branch: entry.branch } : {}),
			...(typeof entry.head === 'string' ? { head: entry.head } : {}),
		}));
}

/**
 * Read a repository list from the file a snapshot wrote.
 *
 * @param {string} configRepo - the configuration repository working tree.
 * @returns {Array<object>} the references.
 */
export function readRepositoriesFile(configRepo) {
	const path = join(configRepo, ...REPOS_PATH.split('/'));
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8'));
		return Array.isArray(raw?.repositories) ? raw.repositories : [];
	} catch {
		return [];
	}
}

/**
 * Render the clone script for a set of repository references.
 *
 * @param {Array<object>} repositories - the references.
 * @returns {string} a POSIX shell script.
 */
export function cloneScriptFor(repositories) {
	return renderCloneScript(repositories);
}

/**
 * Validate every path in a snapshot against the rules for its own root.
 *
 * @param {object} envelope - a snapshot envelope.
 * @param {string} profile - the profile name.
 * @returns {string[]} one message per rejected entry; empty means all were accepted.
 */
export function validateEnvelopePaths(envelope, profile) {
	/** @type {string[]} */
	const problems = [];
	for (const rel of Object.keys(envelope.files ?? {})) {
		try {
			assertSnapshotPath(rel, profile, assertWorkspacePath);
		} catch (error) {
			problems.push(error.message);
		}
	}
	for (const rel of envelope.absent ?? []) {
		try {
			assertSnapshotPath(rel, profile, assertWorkspacePath);
		} catch (error) {
			problems.push(error.message);
		}
	}
	return problems;
}

export { assertSnapshotPath, splitSnapshotPath, assertWorkspacePath };

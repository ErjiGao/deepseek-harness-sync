/**
 * The session-log layer.
 *
 * Session logs are the one part of a harness installation that is neither text
 * nor configuration-shaped: they are zstd-compressed JSONL, written by the
 * harness, and effectively append-only. Two consequences shape this module.
 *
 * 1. **They cannot ride inside the snapshot.** A snapshot is a single JSON
 *    document of verbatim text; base64-ing tens of megabytes into it would
 *    rewrite the whole document on every push, so the repository would grow by a
 *    full copy per sync. Sessions travel instead as real files under `sessions/`
 *    in the configuration repository, where Git stores each one as its own blob
 *    and only a session that actually changed costs anything.
 * 2. **Restoring is additive, never destructive.** A session directory on this
 *    machine may hold logs this machine produced and the repository has never
 *    seen. Overwriting them would destroy history that no backup covers, and
 *    merging two machines' logs for one session id is not something this plugin
 *    can do correctly. So a pull writes only what is missing locally, and says
 *    how much it deliberately left alone.
 *
 * The repository tree is a union, not a mirror: a session deleted on one machine
 * is not deleted from the repository, because the repository is the record that
 * outlives the machine.
 *
 * @module deepseek-harness-sync/core/sessions
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Repository-relative directory holding session logs. */
export const SESSIONS_DIR = 'sessions';

/** The harness-home directory they come from. */
export const HOME_SESSIONS = 'sessions';

/** Largest single session file this plugin will copy (64 MiB). */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * Transient names the harness writes beside real logs. They are never worth
 * syncing and some of them are locks that must not be resurrected elsewhere.
 */
const TRANSIENT = /(^|\/)(\.dsh-mkdir[^/]*|session\.lock)$|\.tmp$/;

/**
 * Convert a native path fragment to the POSIX form used in the repository.
 *
 * @param {string} value - any path fragment.
 * @returns {string} the POSIX form.
 */
export function toPosix(value) {
	return value.split('\\').join('/');
}

/**
 * Reject a session-relative path that could escape the session root.
 *
 * A path here arrives from a Git remote on pull, so it is untrusted input.
 *
 * @param {string} rel - a session-relative POSIX path.
 * @returns {string} the validated path.
 * @throws {Error} when the path is malformed or could escape.
 */
export function assertSessionRel(rel) {
	if (typeof rel !== 'string' || rel === '') throw new Error('refusing an empty session path');
	if (rel.includes('\0')) throw new Error(`refusing a session path containing a NUL byte: ${JSON.stringify(rel)}`);
	if (rel.includes('\\')) throw new Error(`refusing a session path with a backslash: ${rel}`);
	// A drive-letter prefix is how a Windows path sneaks past a POSIX segment check:
	// `C:` is a perfectly ordinary segment name, but it is not one of ours.
	if (/^[A-Za-z]:/.test(rel)) throw new Error(`refusing a session path with a drive letter: ${rel}`);
	const segments = rel.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`refusing a session path with an empty or traversal segment: ${rel}`);
	}
	return rel;
}

/**
 * SHA-256 of a file's bytes.
 *
 * @param {string} abs - native absolute path.
 * @returns {string} `sha256:<hex>`.
 */
function hashFile(abs) {
	return `sha256:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
}

/**
 * List every file under a directory, recursively.
 *
 * @param {string} root - the directory to walk.
 * @returns {string[]} native absolute paths.
 */
function walkFiles(root) {
	/** @type {string[]} */
	const out = [];
	if (!existsSync(root)) return out;
	/** @type {string[]} */
	const queue = [root];
	while (queue.length > 0) {
		const dir = queue.shift();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) queue.push(abs);
			else if (entry.isFile()) out.push(abs);
		}
	}
	return out;
}

/**
 * Read the session store of this machine.
 *
 * @param {{dshHome: string}} options - the harness home.
 * @returns {{entries: Array<{rel: string, abs: string, bytes: number, sha256: string}>, notes: string[]}} what was found.
 */
export function collectSessions(options) {
	const { dshHome } = options;
	const root = join(dshHome, HOME_SESSIONS);
	/** @type {Array<{rel: string, abs: string, bytes: number, sha256: string}>} */
	const entries = [];
	/** @type {string[]} */
	const notes = [];
	if (!existsSync(root)) return { entries, notes };
	for (const abs of walkFiles(root).sort()) {
		const rel = toPosix(relative(root, abs));
		if (TRANSIENT.test(rel)) {
			notes.push(`${SESSIONS_DIR}/${rel}: transient; skipped`);
			continue;
		}
		const stats = statSync(abs);
		if (stats.size > MAX_SESSION_BYTES) {
			notes.push(`${SESSIONS_DIR}/${rel}: ${(stats.size / 1024 / 1024).toFixed(1)} MB exceeds the per-file cap; skipped`);
			continue;
		}
		entries.push({ rel, abs, bytes: stats.size, sha256: hashFile(abs) });
	}
	return { entries, notes };
}

/**
 * The index that rides in the snapshot's preferences.
 *
 * It carries hashes rather than bytes, so `status` and `diff` can describe the
 * session layer without reading it.
 *
 * @param {Array<{rel: string, bytes: number, sha256: string}>} entries - collected entries.
 * @returns {Array<{path: string, bytes: number, sha256: string}>} the index.
 */
export function sessionIndex(entries) {
	return entries.map((entry) => ({ path: entry.rel, bytes: entry.bytes, sha256: entry.sha256 }));
}

/**
 * Read the session index back out of a snapshot.
 *
 * @param {object} envelope - a snapshot envelope.
 * @returns {Array<{path: string, bytes?: number, sha256?: string}>} the index.
 */
export function sessionsFrom(envelope) {
	const raw = envelope?.preferences?.sessions;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string')
		.map((entry) => ({
			path: entry.path,
			...(Number.isFinite(entry.bytes) ? { bytes: entry.bytes } : {}),
			...(typeof entry.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
		}));
}

/**
 * Total bytes the index describes.
 *
 * @param {Array<{bytes?: number}>} index - a session index.
 * @returns {number} the sum.
 */
export function sessionBytes(index) {
	return index.reduce((total, entry) => total + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0);
}

/**
 * Copy this machine's session logs into the configuration repository.
 *
 * A file whose bytes already match is left alone, so `git add` sees no change and
 * the push stays cheap on a machine that has not held new sessions.
 *
 * @param {string} repoDir - the configuration repository working tree.
 * @param {Array<{rel: string, abs: string, bytes: number, sha256: string}>} entries - collected entries.
 * @returns {{written: string[], unchanged: number}} what was copied.
 */
export function writeSessionsLayer(repoDir, entries) {
	const root = join(repoDir, SESSIONS_DIR);
	/** @type {string[]} */
	const written = [];
	let unchanged = 0;
	if (entries.length === 0) return { written, unchanged };
	mkdirSync(root, { recursive: true });
	for (const entry of entries) {
		assertSessionRel(entry.rel);
		const dest = join(root, ...entry.rel.split('/'));
		mkdirSync(dirname(dest), { recursive: true });
		if (existsSync(dest) && statSync(dest).size === entry.bytes && hashFile(dest) === entry.sha256) {
			unchanged += 1;
			continue;
		}
		copyFileSync(entry.abs, dest);
		written.push(`${SESSIONS_DIR}/${entry.rel}`);
	}
	return { written, unchanged };
}

/**
 * Restore missing session logs from the configuration repository.
 *
 * Existing local files are never overwritten: they may contain history this
 * machine produced that the repository has never seen.
 *
 * @param {{dshHome: string, repoDir: string, dryRun?: boolean}} options - inputs.
 * @returns {{written: string[], present: string[], notes: string[]}} what happened.
 */
export function applySessions(options) {
	const { dshHome, repoDir, dryRun = false } = options;
	const root = join(repoDir, SESSIONS_DIR);
	/** @type {string[]} */
	const written = [];
	/** @type {string[]} */
	const present = [];
	/** @type {string[]} */
	const notes = [];
	for (const abs of walkFiles(root).sort()) {
		const rel = toPosix(relative(root, abs));
		try {
			assertSessionRel(rel);
		} catch (error) {
			notes.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		if (TRANSIENT.test(rel)) continue;
		const dest = join(dshHome, HOME_SESSIONS, ...rel.split('/'));
		if (existsSync(dest)) {
			present.push(`${SESSIONS_DIR}/${rel}`);
			continue;
		}
		if (!dryRun) {
			mkdirSync(dirname(dest), { recursive: true });
			copyFileSync(abs, dest);
		}
		written.push(`${SESSIONS_DIR}/${rel}`);
	}
	return { written, present, notes };
}

/**
 * Read the whitelisted harness configuration off this machine.
 *
 * Every path read here is named by `manifest.js`. Nothing in this module ever
 * enumerates the harness home, which is what keeps a plaintext credential copy
 * sitting in some plugin's private directory out of a snapshot.
 *
 * @module deepseek-harness-sync/core/collect
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { HOME_FILES, MAX_FILE_BYTES, TREE_ROOTS, TREE_SKIP_DIRS, managedFiles, toPosix } from './manifest.js';

/** Bytes inspected when deciding whether a file is binary. */
const BINARY_PROBE_BYTES = 8192;

/**
 * Turn a harness-relative POSIX path into a native absolute path.
 *
 * @param {string} dshHome - the harness home.
 * @param {string} rel - harness-relative POSIX path.
 * @returns {string} the native absolute path.
 */
export function nativePath(dshHome, rel) {
	return join(dshHome, ...rel.split('/'));
}

/**
 * Read one candidate file as verbatim text.
 *
 * @param {string} abs - native absolute path.
 * @param {string} rel - harness-relative POSIX path, for messages.
 * @param {string[]} notes - collected human-readable notes.
 * @returns {string|undefined} the text, or undefined when it cannot be captured.
 */
function readText(abs, rel, notes) {
	const stats = statSync(abs);
	if (!stats.isFile()) {
		notes.push(`${rel}: not a regular file; skipped`);
		return undefined;
	}
	if (stats.size > MAX_FILE_BYTES) {
		notes.push(`${rel}: ${(stats.size / 1024).toFixed(0)} KB exceeds the ${MAX_FILE_BYTES / 1024} KB limit; skipped (configuration files are never this large — check what put it here)`);
		return undefined;
	}
	const buffer = readFileSync(abs);
	if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
		notes.push(`${rel}: looks binary; skipped`);
		return undefined;
	}
	return buffer.toString('utf8');
}

/**
 * Walk a whitelisted directory tree, collecting text files.
 *
 * @param {string} dshHome - the harness home.
 * @param {string} root - harness-relative POSIX path of the tree root.
 * @param {Record<string, string>} files - accumulator for captured files.
 * @param {string[]} notes - collected human-readable notes.
 */
function walkTree(dshHome, root, files, notes) {
	const rootAbs = nativePath(dshHome, root);
	if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) return;
	/** @type {string[]} */
	const queue = [rootAbs];
	while (queue.length > 0) {
		const dir = queue.shift();
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			notes.push(`${toPosix(relative(dshHome, dir))}: cannot list (${error.code ?? error.message}); skipped`);
			continue;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (TREE_SKIP_DIRS.has(entry.name)) {
					notes.push(`${toPosix(relative(dshHome, abs))}: skipped by policy`);
					continue;
				}
				queue.push(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = toPosix(relative(dshHome, abs));
			const text = readText(abs, rel, notes);
			if (text !== undefined) files[rel] = text;
		}
	}
}

/**
 * Collect the current configuration into a snapshot-shaped file map.
 *
 * @param {{dshHome: string, profile: string}} options - where to read from.
 * @returns {{files: Record<string, string>, absent: string[], notes: string[]}} the collection.
 */
export function collect(options) {
	const { dshHome, profile } = options;
	/** @type {Record<string, string>} */
	const files = {};
	/** @type {string[]} */
	const absent = [];
	/** @type {string[]} */
	const notes = [];

	for (const rel of managedFiles(profile)) {
		const abs = nativePath(dshHome, rel);
		if (!existsSync(abs)) {
			// Only fixed files can be recorded absent: `applySnapshot` deletes what
			// this list names, so it must never contain a discovered path.
			absent.push(rel);
			continue;
		}
		const text = readText(abs, rel, notes);
		if (text !== undefined) files[rel] = text;
	}

	for (const root of TREE_ROOTS) walkTree(dshHome, root, files, notes);

	return { files, absent, notes };
}

/**
 * Find dependency specs that point at a directory on this machine.
 *
 * A `link:`/`file:` spec resolves against the installing machine, so it breaks
 * on the next one. These are reported loudly rather than rewritten: only the
 * user knows whether to publish that plugin or drop it.
 *
 * @param {Record<string, string>} files - a collected file map.
 * @param {string} profile - the profile name.
 * @returns {{rel: string, line: number, spec: string}[]} one entry per occurrence.
 */
export function detectMachineDependencies(files, profile) {
	const targets = [`profiles/${profile}/package.json`, `profiles/${profile}/pnpm-lock.yaml`];
	/** @type {{rel: string, line: number, spec: string}[]} */
	const hits = [];
	for (const rel of targets) {
		const text = files[rel];
		if (text === undefined) continue;
		text.split('\n').forEach((line, index) => {
			const match = /(?:link:|file:)([^"',\s]+)/.exec(line);
			if (match !== null) hits.push({ rel, line: index + 1, spec: match[0] });
		});
	}
	return hits;
}

/**
 * The harness-home paths this plugin would read, for `status` and for docs.
 *
 * @param {string} profile - the profile name.
 * @returns {string[]} harness-relative POSIX paths (fixed files only).
 */
export function managedFileList(profile) {
	return managedFiles(profile);
}

export { HOME_FILES };

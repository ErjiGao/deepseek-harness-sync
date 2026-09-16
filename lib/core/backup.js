/**
 * Local rotation backups — the "never lose a working configuration" guarantee.
 *
 * A backup is an ordinary snapshot envelope, so restoring one is just
 * `applySnapshot` and every backup can be inspected with the same tooling. The
 * remote repository's Git history is the second safety net; these files are the
 * fast, offline one.
 *
 * @module deepseek-harness-sync/core/backup
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collect } from './collect.js';
import { collectAll, repositoryPreferences } from './layers.js';
import { buildSnapshot, parseSnapshot, stableStringify } from './snapshot.js';

/** How many backups to keep unless configured otherwise. */
export const DEFAULT_KEEP = 5;

/** Filename prefix and extension for one backup. */
const PREFIX = 'harness-config-';
const SUFFIX = '.json';

/**
 * Format a timestamp the way a person reads it and a filename sorts by.
 *
 * @param {Date} [date] - the moment to stamp.
 * @returns {string} `YYYY-MM-DD-HHmm`.
 */
export function stamp(date = new Date()) {
	const pad = (value) => String(value).padStart(2, '0');
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		`${pad(date.getHours())}${pad(date.getMinutes())}`,
	].join('-');
}

/**
 * Choose a free backup filename, disambiguating two backups in one minute.
 *
 * @param {string} backupDir - the backup directory.
 * @returns {string} an absolute path that does not yet exist.
 */
function freeName(backupDir) {
	const base = `${PREFIX}${stamp()}`;
	let candidate = join(backupDir, `${base}${SUFFIX}`);
	let counter = 2;
	while (existsSync(candidate)) {
		candidate = join(backupDir, `${base}-${counter}${SUFFIX}`);
		counter += 1;
	}
	return candidate;
}

/**
 * Snapshot the current configuration into the backup directory.
 *
 * The workspace is included when one is known, because a pull can overwrite
 * workspace files too — so a backup that covered only the harness home would
 * leave those changes unrecoverable, which is the one promise a backup makes.
 *
 * @param {{dshHome: string, profile: string, backupDir: string, device: string, version?: number, reason: string, workspace?: string}} options - inputs.
 * @returns {{path: string, fileCount: number}} the written backup.
 */
export function createBackup(options) {
	const { dshHome, profile, backupDir, device, version = 0, reason, workspace } = options;
	const collected = collectAll({
		dshHome,
		profile,
		workspace,
		collectHome: collect,
	});
	const envelope = buildSnapshot({
		version,
		device,
		profile,
		files: collected.files,
		absent: collected.absent,
		preferences: repositoryPreferences(collected.repositories),
		reason,
	});
	mkdirSync(backupDir, { recursive: true });
	const path = freeName(backupDir);
	writeFileSync(path, stableStringify(envelope), { encoding: 'utf8', mode: 0o600 });
	return { path, fileCount: Object.keys(collected.files).length };
}

/**
 * List backups newest first.
 *
 * Two backups taken inside the same minute share a timestamp, so the numeric
 * suffix `freeName` adds is used as the tiebreaker: it increases with creation
 * order, which keeps "the newest one" well defined even then.
 *
 * @param {string} backupDir - the backup directory.
 * @returns {{path: string, name: string, mtimeMs: number, sequence: number, bytes: number, version: number, reason: string, device: string, fileCount: number}[]} the listing.
 */
export function listBackups(backupDir) {
	if (!existsSync(backupDir)) return [];
	const entries = readdirSync(backupDir)
		.filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
		.map((name) => {
			const path = join(backupDir, name);
			const stats = statSync(path);
			const sequenced = /-(\d+)\.json$/.exec(name);
			/** @type {{version?: number, reason?: string, device?: string, files?: Record<string, string>}} */
			let meta = {};
			try {
				meta = parseSnapshot(readFileSync(path, 'utf8'));
			} catch {
				// A corrupt backup still lists, so it can be seen and removed.
			}
			return {
				path,
				name,
				mtimeMs: stats.mtimeMs,
				sequence: sequenced === null ? 1 : Number.parseInt(sequenced[1], 10),
				bytes: stats.size,
				version: meta.version ?? -1,
				reason: meta.reason ?? '',
				device: meta.device ?? '',
				fileCount: meta.files === undefined ? 0 : Object.keys(meta.files).length,
			};
		});
	return entries.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.sequence - a.sequence));
}

/**
 * Delete the oldest backups beyond the retention count.
 *
 * @param {string} backupDir - the backup directory.
 * @param {number} [keep] - how many to retain.
 * @returns {string[]} the names removed.
 */
export function pruneBackups(backupDir, keep = DEFAULT_KEEP) {
	const entries = listBackups(backupDir);
	const doomed = entries.slice(Math.max(keep, 1));
	for (const entry of doomed) rmSync(entry.path, { force: true });
	return doomed.map((entry) => entry.name);
}

/**
 * Read one backup envelope.
 *
 * @param {string} path - the backup file.
 * @returns {object} the envelope.
 */
export function readBackup(path) {
	return parseSnapshot(readFileSync(path, 'utf8'));
}

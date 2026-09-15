/**
 * Write a snapshot back onto this machine.
 *
 * This is the only module that writes harness configuration, and it treats its
 * input as hostile: a snapshot arrives from a Git remote, so every path is
 * re-validated against the whitelist and every write is atomic.
 *
 * @module deepseek-harness-sync/core/apply
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { assertManaged } from './manifest.js';
import { nativePath } from './collect.js';

/** Default permissions for a written file that does not already exist. */
const DEFAULT_MODE = 0o644;

/** Permissions for the settings document, which the harness keeps owner-only. */
const SETTINGS_MODE = 0o600;

/**
 * Read a file's current text, or undefined when it is absent or not a file.
 *
 * @param {string} abs - native absolute path.
 * @returns {string|undefined} the text.
 */
function readIfFile(abs) {
	if (!existsSync(abs)) return undefined;
	if (!statSync(abs).isFile()) return undefined;
	return readFileSync(abs, 'utf8');
}

/**
 * Write one file atomically: render to a sibling temp file, then rename.
 *
 * A rename within one directory is atomic on every supported platform, so a
 * crash or a full disk can never leave a half-written `settings.yaml` behind —
 * which matters because the harness fails loudly on an unparsable document.
 *
 * @param {string} abs - native absolute destination.
 * @param {string} text - verbatim content.
 */
function writeAtomic(abs, text) {
	mkdirSync(dirname(abs), { recursive: true });
	const existing = existsSync(abs) ? statSync(abs).mode & 0o777 : undefined;
	const mode = existing ?? (abs.endsWith('settings.yaml') ? SETTINGS_MODE : DEFAULT_MODE);
	const tmp = join(dirname(abs), `.${Date.now()}-${process.pid}-harness-sync.tmp`);
	try {
		writeFileSync(tmp, text, { encoding: 'utf8', mode });
		renameSync(tmp, abs);
	} catch (error) {
		// Leave nothing behind if the rename never happened.
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* best effort */
		}
		throw error;
	}
	// `mode` on write only applies at creation; an existing file keeps its own
	// permissions, and the harness expects settings to stay owner-only.
	if (existing !== undefined && abs.endsWith('settings.yaml') && (existing & 0o077) !== 0) chmodSync(abs, SETTINGS_MODE);
}

/**
 * Work out what applying a snapshot would do, without changing anything.
 *
 * Existence is read from the filesystem rather than taken from a caller-supplied
 * map: a deletion must be decided by what is actually there, not by what some
 * earlier step believed was there.
 *
 * @param {{dshHome: string, profile: string, envelope: object}} options - inputs.
 * @returns {{written: string[], unchanged: string[], deleted: string[], notes: string[]}} the plan.
 */
export function planApply(options) {
	const { dshHome, profile, envelope } = options;
	/** @type {string[]} */
	const written = [];
	/** @type {string[]} */
	const unchanged = [];
	/** @type {string[]} */
	const deleted = [];
	/** @type {string[]} */
	const notes = [];
	for (const [rel, text] of Object.entries(envelope.files)) {
		try {
			assertManaged(rel, profile);
		} catch (error) {
			notes.push(error.message);
			continue;
		}
		if (readIfFile(nativePath(dshHome, rel)) === text) unchanged.push(rel);
		else written.push(rel);
	}
	for (const rel of envelope.absent ?? []) {
		try {
			assertManaged(rel, profile);
		} catch (error) {
			notes.push(error.message);
			continue;
		}
		if (rel in envelope.files) continue;
		if (existsSync(nativePath(dshHome, rel))) deleted.push(rel);
	}
	return { written, unchanged, deleted, notes };
}

/**
 * Apply a snapshot to this machine.
 *
 * Files listed in `absent` are deleted, which is how a removal propagates.
 * `absent` can only ever name fixed whitelist files, because `collect()` builds
 * it that way and `assertManaged()` re-checks it here.
 *
 * Every entry is validated before anything is written, and a single rejected
 * entry aborts the whole apply. A snapshot is untrusted input from a Git remote,
 * so a path outside the whitelist means the snapshot is malformed or hostile —
 * applying the rest of it quietly would be the wrong answer.
 *
 * @param {{dshHome: string, profile: string, envelope: object, dryRun?: boolean}} options - inputs.
 * @returns {{written: string[], unchanged: string[], deleted: string[], notes: string[]}} what happened.
 * @throws {Error} when any entry is rejected.
 */
export function applySnapshot(options) {
	const { dshHome, profile, envelope, dryRun = false } = options;
	const plan = planApply({ dshHome, profile, envelope });
	if (plan.notes.length > 0) {
		throw new Error(
			`refusing to apply this snapshot: ${plan.notes.length} entr${plan.notes.length === 1 ? 'y was' : 'ies were'} rejected, so nothing was written.\n  - ${plan.notes.join('\n  - ')}`,
		);
	}
	if (dryRun) return plan;
	for (const rel of plan.written) {
		assertManaged(rel, profile);
		writeAtomic(nativePath(dshHome, rel), envelope.files[rel]);
	}
	for (const rel of plan.deleted) {
		assertManaged(rel, profile);
		rmSync(nativePath(dshHome, rel), { force: true });
	}
	return plan;
}

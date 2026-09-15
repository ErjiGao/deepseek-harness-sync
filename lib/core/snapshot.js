/**
 * The snapshot envelope: what actually travels to the configuration repository.
 *
 * A snapshot stores each harness file as **verbatim text**. It is never parsed
 * and re-serialized, because `settings.yaml` is a comment- and anchor-preserving
 * document — round-tripping it through a structured representation would destroy
 * the user's comments. This plugin syncs configuration; it does not interpret it.
 *
 * @module deepseek-harness-sync/core/snapshot
 */

import { createHash } from 'node:crypto';

/** Envelope format version, bumped only for an incompatible layout change. */
export const SCHEMA_VERSION = 1;

/** Repository-relative path of the snapshot inside the configuration repository. */
export const SNAPSHOT_PATH = 'config/harness-config.json';

/** Repository-relative path of the small index beside the snapshot. */
export const METADATA_PATH = 'metadata.json';

/**
 * Serialize a value as deterministic JSON: keys sorted at every level, two-space
 * indent, trailing newline. Determinism matters because snapshots are committed
 * to Git — an unstable key order would produce a spurious diff on every push.
 *
 * @param {unknown} value - any JSON-compatible value.
 * @returns {string} stable JSON text.
 */
export function stableStringify(value) {
	return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

/**
 * Recursively sort object keys.
 *
 * @param {unknown} value - any JSON-compatible value.
 * @returns {unknown} the same value with object keys in sorted order.
 */
function sortDeep(value) {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value === null || typeof value !== 'object') return value;
	const out = {};
	for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
	return out;
}

/**
 * SHA-256 of a text value, in the `sha256:<hex>` form used inside metadata.
 *
 * @param {string} text - the text to hash.
 * @returns {string} the digest.
 */
export function hashText(text) {
	return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Build the per-file digest map recorded in `metadata.json`.
 *
 * @param {Record<string, string>} files - relative path to verbatim text.
 * @returns {Record<string, string>} relative path to digest.
 */
export function hashFiles(files) {
	const out = {};
	for (const rel of Object.keys(files).sort()) out[rel] = hashText(files[rel]);
	return out;
}

/**
 * Assemble a snapshot envelope.
 *
 * `absent` names whitelisted files that were confirmed **not** to exist at
 * snapshot time. Recording absence is what lets `pull` and `rollback` restore a
 * deletion instead of leaving a stale file behind. It only ever contains fixed
 * whitelist paths, never discovered ones.
 *
 * @param {{version: number, device: string, profile: string, files: Record<string, string>, absent?: string[], updatedAt?: string, preferences?: Record<string, unknown>, reason?: string}} input - snapshot content.
 * @returns {object} the envelope.
 */
export function buildSnapshot(input) {
	return {
		schema: SCHEMA_VERSION,
		version: input.version,
		updated_at: input.updatedAt ?? new Date().toISOString(),
		device: input.device,
		profile: input.profile,
		files: input.files,
		absent: [...(input.absent ?? [])].sort(),
		preferences: input.preferences ?? {},
		// Present on local backups so `rollback --list` can say why one was taken.
		// A backup is an ordinary envelope, so it can be applied directly.
		...(input.reason !== undefined ? { reason: input.reason } : {}),
	};
}

/**
 * Parse and validate a snapshot that arrived from the repository.
 *
 * A snapshot is untrusted input: it comes over the network from a Git remote.
 * Every structural claim is checked here so that later stages can rely on the
 * shape, and `applySnapshot` still re-checks each path against the whitelist.
 *
 * @param {string} text - raw snapshot text.
 * @returns {object} the validated envelope.
 * @throws {Error} when the text is not a well-formed snapshot.
 */
export function parseSnapshot(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`snapshot is not valid JSON: ${error.message}`);
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('snapshot must be a JSON object');
	}
	if (raw.schema !== SCHEMA_VERSION) {
		throw new Error(`unsupported snapshot schema ${JSON.stringify(raw.schema)}; this build understands schema ${SCHEMA_VERSION}`);
	}
	if (!Number.isInteger(raw.version) || raw.version < 0) {
		throw new Error(`snapshot version must be a non-negative integer, got ${JSON.stringify(raw.version)}`);
	}
	if (typeof raw.device !== 'string' || raw.device === '') throw new Error('snapshot device must be a non-empty string');
	if (typeof raw.profile !== 'string' || raw.profile === '') throw new Error('snapshot profile must be a non-empty string');
	if (raw.files === null || typeof raw.files !== 'object' || Array.isArray(raw.files)) {
		throw new Error('snapshot files must be an object');
	}
	for (const [rel, content] of Object.entries(raw.files)) {
		if (typeof content !== 'string') throw new Error(`snapshot file ${rel} must hold text`);
	}
	const absent = raw.absent ?? [];
	if (!Array.isArray(absent) || absent.some((entry) => typeof entry !== 'string')) {
		throw new Error('snapshot absent must be an array of strings');
	}
	return {
		schema: raw.schema,
		version: raw.version,
		updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
		device: raw.device,
		profile: raw.profile,
		files: raw.files,
		absent,
		preferences: raw.preferences && typeof raw.preferences === 'object' ? raw.preferences : {},
		...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
	};
}

/**
 * A single digest over a whole file set.
 *
 * Two machines agree when their digests match, which is cheaper and more precise
 * than comparing text file by file.
 *
 * @param {Record<string, string>} files - relative path to verbatim text.
 * @returns {string} the digest.
 */
export function contentDigest(files) {
	return hashText(JSON.stringify(hashFiles(files)));
}

/**
 * Build the small index written beside the snapshot.
 *
 * `status` reads this instead of the full snapshot when it only needs the
 * version and a content fingerprint, which keeps the common path cheap.
 *
 * @param {object} envelope - a snapshot envelope.
 * @returns {object} the metadata document.
 */
export function buildMetadata(envelope) {
	const hashes = hashFiles(envelope.files);
	return {
		schema: SCHEMA_VERSION,
		version: envelope.version,
		updated_at: envelope.updated_at,
		device: envelope.device,
		profile: envelope.profile,
		fileCount: Object.keys(envelope.files).length,
		contentHash: contentDigest(envelope.files),
		hashes,
	};
}

/**
 * Compare two file sets.
 *
 * @param {Record<string, string>} local - the local files.
 * @param {Record<string, string>} remote - the remote files.
 * @returns {{added: string[], removed: string[], changed: string[], same: string[]}} the comparison.
 */
export function diffFileSets(local, remote) {
	const added = [];
	const removed = [];
	const changed = [];
	const same = [];
	for (const rel of Object.keys(local).sort()) {
		if (!(rel in remote)) added.push(rel);
		else if (local[rel] !== remote[rel]) changed.push(rel);
		else same.push(rel);
	}
	for (const rel of Object.keys(remote).sort()) {
		if (!(rel in local)) removed.push(rel);
	}
	return { added, removed, changed, same };
}

/**
 * A one-line human summary of a comparison.
 *
 * @param {{added: string[], removed: string[], changed: string[], same: string[]}} diff - a comparison.
 * @returns {string} e.g. `2 changed, 1 added`.
 */
export function summarizeDiff(diff) {
	const parts = [];
	if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`);
	if (diff.added.length > 0) parts.push(`${diff.added.length} added`);
	if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
	if (parts.length === 0) parts.push(`${diff.same.length} unchanged`);
	return parts.join(', ');
}

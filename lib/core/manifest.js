/**
 * The whitelist of harness paths this plugin is allowed to read or write.
 *
 * This is a whitelist and NOT a blacklist on purpose, and the reason is a
 * concrete hazard rather than a style preference: a third-party plugin can keep
 * a plaintext copy of the credential store inside its own private directory
 * under the harness home. A collector that walked `$DSH_HOME` and filtered out
 * `*.credentials.yaml` would still upload such a copy. Nothing here ever
 * enumerates the harness home; every path is named explicitly, and
 * `assertManaged()` re-checks every incoming snapshot entry against this list
 * before a single byte is written.
 *
 * @module deepseek-harness-sync/core/manifest
 */

import { posix } from 'node:path';

/** Largest text file this plugin will put in a snapshot (1 MiB). */
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Files at the harness-home root that carry user configuration.
 *
 * `settings.yaml` is the user-settings document; `AGENTS.md` is the
 * user-global agent instruction baseline; `cordis.patch.yml` is the home-level
 * patch layer, which outranks any per-profile patch.
 *
 * `.env` is deliberately absent: the harness allows proxy credentials in that
 * file and nothing else, so it is never synced. See README "Troubleshooting".
 */
export const HOME_FILES = ['settings.yaml', 'AGENTS.md', 'cordis.patch.yml'];

/**
 * Files inside one profile directory that carry user configuration.
 *
 * `cordis.yml` is a template the launcher expects to exist even when empty;
 * `pnpm-workspace.yaml` holds linker and `allowBuilds` policy;
 * `pnpm-lock.yaml` holds exact versions; `.dsh-market/state.json` holds which
 * bundles the user disabled.
 *
 * @param {string} profile - the profile name, e.g. `web`.
 * @returns {string[]} harness-relative POSIX paths.
 */
export function profileFiles(profile) {
	const base = posix.join('profiles', profile);
	return [
		posix.join(base, 'package.json'),
		posix.join(base, 'cordis.patch.yml'),
		posix.join(base, 'cordis.yml'),
		posix.join(base, 'pnpm-workspace.yaml'),
		posix.join(base, 'pnpm-lock.yaml'),
		posix.join(base, '.dsh-market', 'state.json'),
	];
}

/** Directory trees that are user configuration and are walked only when present. */
export const TREE_ROOTS = ['.agent-presets', 'skills'];

/** Directory names never descended into, even inside a whitelisted tree root. */
export const TREE_SKIP_DIRS = new Set(['node_modules', '.git', '.cache']);

/**
 * Every fixed (non-tree) path this plugin manages for a profile.
 *
 * @param {string} profile - the profile name.
 * @returns {string[]} harness-relative POSIX paths.
 */
export function managedFiles(profile) {
	return [...HOME_FILES, ...profileFiles(profile)];
}

/**
 * Convert a native path fragment to the POSIX form used inside snapshots.
 *
 * Snapshots must be platform-independent: a snapshot written on Windows has to
 * apply byte-identically on macOS and Linux.
 *
 * @param {string} value - any path fragment.
 * @returns {string} the POSIX form.
 */
export function toPosix(value) {
	return value.split('\\').join('/');
}

/**
 * Whether a harness-relative POSIX path is inside this plugin's whitelist.
 *
 * @param {string} rel - harness-relative POSIX path.
 * @param {string} profile - the profile name.
 * @returns {boolean} true when the path may be read or written.
 */
export function isManaged(rel, profile) {
	if (managedFiles(profile).includes(rel)) return true;
	return TREE_ROOTS.some((root) => rel.startsWith(`${root}/`));
}

/**
 * Reject anything that is not a safe, whitelisted, harness-relative path.
 *
 * This is the guard that stands between a snapshot — which arrives from a Git
 * repository and is therefore untrusted input — and the filesystem. It refuses
 * absolute paths, drive letters, UNC paths, `..` traversal, NUL bytes, and any
 * path outside the whitelist.
 *
 * @param {string} rel - a candidate harness-relative POSIX path.
 * @param {string} profile - the profile name.
 * @returns {string} the validated path, unchanged.
 * @throws {Error} when the path is unsafe or unmanaged.
 */
export function assertManaged(rel, profile) {
	if (typeof rel !== 'string' || rel === '') throw new Error(`refusing empty path in snapshot`);
	if (rel.includes('\0')) throw new Error(`refusing path containing a NUL byte: ${JSON.stringify(rel)}`);
	if (rel.includes('\\')) throw new Error(`refusing path with a backslash (snapshots are POSIX): ${rel}`);
	if (posix.isAbsolute(rel)) throw new Error(`refusing absolute path in snapshot: ${rel}`);
	if (/^[A-Za-z]:/.test(rel)) throw new Error(`refusing drive-letter path in snapshot: ${rel}`);
	const segments = rel.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		throw new Error(`refusing path with an empty or traversal segment: ${rel}`);
	}
	if (!isManaged(rel, profile)) {
		throw new Error(`refusing path outside the sync whitelist: ${rel}`);
	}
	return rel;
}

/**
 * Categories that must never reach the configuration repository. Exported for
 * documentation, tests, and the guard's error messages — not used for filtering,
 * because filtering is exactly the approach this module rejects.
 */
export const NEVER_SYNC = {
	secrets: ['.credentials.yaml', '.anonymous-user-id', '.env', 'dsh-pocket/token', 'dsh-pocket/token-lan'],
	runtimeState: ['sessions/', 'attachments/', 'storages/', 'llm-deepseek/', 'tokenledger.sqlite', 'bin/'],
	thirdPartyData: ['dsh-config-manager/', '.src/', 'integrations/', 'profiles/node_modules/', 'profiles/*/node_modules/'],
	workspaceSecrets: ['**/.env', '**/.credentials.*', '**/id_rsa', '**/*.pem', '**/*.key', '**/secrets/**'],
};

// ---------------------------------------------------------------------------
// Two roots
//
// A snapshot covers two directories: the harness home, and the session
// workspace. They are validated by different rules — the home by the finite
// whitelist above, the workspace by the pattern allowlist in `workspace.js` —
// because the home's contents are known and a workspace's are not.
//
// A path in a snapshot says which root it belongs to by its prefix. Home files
// have kept their bare historical form so that a snapshot written by an earlier
// build still applies unchanged; workspace files carry `workspace/`.
// ---------------------------------------------------------------------------

/** The prefix marking a snapshot entry as workspace-relative. */
export const WORKSPACE_PREFIX = 'workspace';

/**
 * Split a snapshot path into the root it names and the path inside that root.
 *
 * @param {string} rel - a snapshot-relative POSIX path.
 * @returns {{target: 'home'|'workspace', path: string}} the split.
 */
export function splitSnapshotPath(rel) {
	if (typeof rel !== 'string') return { target: 'home', path: '' };
	if (rel === WORKSPACE_PREFIX) return { target: 'workspace', path: '' };
	if (rel.startsWith(`${WORKSPACE_PREFIX}/`)) {
		return { target: 'workspace', path: rel.slice(WORKSPACE_PREFIX.length + 1) };
	}
	return { target: 'home', path: rel };
}

/**
 * Validate a snapshot path against the rules for whichever root it names.
 *
 * This is the single entry point a writer should use, so that a workspace path
 * can never be validated by the home's rules or the other way round.
 *
 * @param {string} rel - a snapshot-relative POSIX path.
 * @param {string} profile - the profile name.
 * @param {(workspaceRel: string) => string} assertWorkspacePath - the workspace validator.
 * @returns {{target: 'home'|'workspace', path: string}} the validated split.
 * @throws {Error} when the path is unsafe or outside the relevant whitelist.
 */
export function assertSnapshotPath(rel, profile, assertWorkspacePath) {
	if (typeof assertWorkspacePath !== 'function') {
		throw new Error('assertSnapshotPath requires the workspace validator; refusing to guess');
	}
	const split = splitSnapshotPath(rel);
	if (split.target === 'workspace') {
		if (split.path === '') throw new Error(`refusing the bare workspace prefix as a path: ${rel}`);
		assertWorkspacePath(split.path);
		return split;
	}
	assertManaged(split.path, profile);
	return split;
}

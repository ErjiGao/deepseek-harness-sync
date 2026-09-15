/**
 * Where things live: the DeepSeek Harness home, and this plugin's private root.
 *
 * Resolution deliberately mirrors `@deepseek-ai/dsh-home-paths` so this plugin
 * agrees with the rest of the harness without depending on it:
 *
 *   explicit override  >  $DSH_HOME  >  ~/.dsh
 *
 * A blank or whitespace-only value is treated as unset, so a stray empty
 * environment variable can never resolve the home to the current directory.
 *
 * @module deepseek-harness-sync/core/paths
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Directory name this plugin owns under the harness home. */
export const DATA_DIR_NAME = 'harness-sync';

/** Environment variable that overrides the plugin's private data root. */
export const DATA_ROOT_ENV = 'HARNESS_SYNC_HOME';

/**
 * Expand a leading `~`, `~/` or `~\` against the operating-system home.
 * Named-user forms such as `~alice/...` are left untouched, matching the
 * harness helper's deliberately narrow behaviour.
 *
 * @param {string} value - the path to expand.
 * @returns {string} the expanded path.
 */
function expandTilde(value) {
	if (value === '~') return homedir();
	if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
	return value;
}

/** @param {unknown} value @returns {boolean} whether the value is a usable non-blank string. */
function isSet(value) {
	return typeof value === 'string' && value.trim() !== '';
}

/**
 * Resolve the harness home directory.
 *
 * @param {string|undefined} explicit - a configured path, which wins outright.
 * @param {NodeJS.ProcessEnv} [env] - environment to read `$DSH_HOME` from.
 * @returns {string} an absolute, normalized home path.
 */
export function resolveDshHome(explicit, env = process.env) {
	for (const candidate of [explicit, env.DSH_HOME]) {
		if (isSet(candidate)) return resolve(expandTilde(candidate.trim()));
	}
	return resolve(join(homedir(), '.dsh'));
}

/**
 * Render a home path symbolically so output never leaks an absolute machine path
 * unnecessarily. Matches the harness convention: default home shows as `~/.dsh`,
 * anything else as `$DSH_HOME`.
 *
 * @param {string} dshHome - the resolved home.
 * @param {NodeJS.ProcessEnv} [env] - environment to compare against.
 * @returns {string} a display form.
 */
export function dshHomeDisplay(dshHome, env = process.env) {
	const defaultHome = resolve(join(homedir(), '.dsh'));
	return resolve(dshHome) === defaultHome ? '~/.dsh' : '$DSH_HOME';
}

/**
 * Resolve this plugin's private data root.
 *
 * `$HARNESS_SYNC_HOME` wins when set; otherwise the root is a directory named
 * after this plugin under the harness home. Tests point this at a temporary
 * directory so they never touch a real installation.
 *
 * @param {string} dshHome - the resolved harness home.
 * @param {NodeJS.ProcessEnv} [env] - environment to read the override from.
 * @returns {string} an absolute data root.
 */
export function resolveDataRoot(dshHome, env = process.env) {
	const override = env[DATA_ROOT_ENV];
	if (isSet(override)) return resolve(expandTilde(override.trim()));
	return join(dshHome, DATA_DIR_NAME);
}

/**
 * The individual paths under the data root.
 *
 * @param {string} dataRoot - the resolved data root.
 * @returns {{root: string, state: string, repo: string, backup: string, exports: string}} the paths.
 */
export function dataPaths(dataRoot) {
	return {
		root: dataRoot,
		/** This plugin's own configuration (structurally holds no token). */
		state: join(dataRoot, 'config.json'),
		/** The working clone of the configuration repository. */
		repo: join(dataRoot, 'repo'),
		/** Local rotation backup directory — pruned to the retention count. */
		backup: join(dataRoot, 'backup'),
		/** Snapshots a person asked for explicitly; never rotated away. */
		exports: join(dataRoot, 'exports'),
	};
}

/**
 * Build the full path set from a CLI/plugin configuration.
 *
 * @param {{root?: string, dshHome?: string, dataRoot?: string, env?: NodeJS.ProcessEnv}} [options] - overrides.
 * @returns {{dshHome: string, dataRoot: string, state: string, repo: string, backup: string, exports: string}} resolved paths.
 */
export function resolvePaths(options = {}) {
	const env = options.env ?? process.env;
	const dshHome = resolveDshHome(options.dshHome, env);
	const dataRoot = options.dataRoot !== undefined
		? resolve(expandTilde(options.dataRoot))
		: resolveDataRoot(dshHome, env);
	return { dshHome, dataRoot, ...dataPaths(dataRoot) };
}

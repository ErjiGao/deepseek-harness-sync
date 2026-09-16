/**
 * Installing the plugin set a snapshot describes.
 *
 * A snapshot carries the profile manifest — the dependency list and the ordered
 * `dsh.profile.bundles` — but never `node_modules`, because it is large and
 * reproducible. That leaves a gap a pull alone cannot close: the new machine has
 * the right plugin *list* and none of the plugin *code*, and the launcher aborts
 * the boot outright when a listed bundle cannot be resolved
 * (`@deepseek-ai/dsh-app-boot`: "profile bundle … declares no dsh.bundle").
 *
 * So a pull that actually changed the plugin set runs the install itself, and the
 * order stops mattering for the user.
 *
 * Two deliberate restraints:
 *
 * - **Only when the set changed.** Re-running an install on every pull would make
 *   a routine sync take as long as a cold install for no reason.
 * - **Never fatal to the pull.** The configuration is already applied by the time
 *   this runs; an install failure is reported and handed back, not rolled into a
 *   failed pull that would tempt someone to re-run and clobber their files.
 *
 * @module deepseek-harness-sync/core/profile-install
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Ceiling on captured installer output (8 MiB). */
export const MAX_INSTALL_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The package names a profile manifest implies: its dependencies plus every
 * bundle in the layer stack.
 *
 * Both matter. A dependency that is not a bundle is still needed on disk, and a
 * bundle that is not a dependency is an in-box layer the profile template
 * supplies — including it costs nothing because install leaves it alone.
 *
 * @param {string|undefined} text - the manifest text, if it exists.
 * @returns {Set<string>} the package names.
 */
export function manifestPackages(text) {
	/** @type {Set<string>} */
	const names = new Set();
	if (typeof text !== 'string' || text.trim() === '') return names;
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		return names;
	}
	for (const name of Object.keys(json?.dependencies ?? {})) names.add(name);
	for (const name of json?.dsh?.profile?.bundles ?? []) names.add(name);
	return names;
}

/**
 * Decide whether a pull changed which packages the profile needs.
 *
 * @param {string|undefined} before - the manifest as it was.
 * @param {string|undefined} after - the manifest the snapshot supplies.
 * @returns {{changed: boolean, beforeCount: number, afterCount: number, added: string[], removed: string[]}} the comparison.
 */
export function diffManifests(before, after) {
	const a = manifestPackages(before);
	const b = manifestPackages(after);
	const added = [...b].filter((name) => !a.has(name)).sort();
	const removed = [...a].filter((name) => !b.has(name)).sort();
	return {
		changed: added.length > 0 || removed.length > 0,
		beforeCount: a.size,
		afterCount: b.size,
		added,
		removed,
	};
}

/**
 * The default runner: `pnpm` in the profile directory.
 *
 * `shell` is needed on Windows, where pnpm is a `.cmd` shim — the same reason
 * `dsh plugin` itself uses it.
 *
 * @param {string[]} args - pnpm arguments after the executable.
 * @param {{cwd: string, env: NodeJS.ProcessEnv}} options - invocation options.
 * @returns {{status: number|null, stdout: string, stderr: string, error?: Error}} the result.
 */
function defaultRunner(args, options) {
	return spawnSync('pnpm', args, {
		cwd: options.cwd,
		env: options.env,
		encoding: 'utf8',
		shell: process.platform === 'win32',
		windowsHide: true,
		maxBuffer: MAX_INSTALL_OUTPUT_BYTES,
	});
}

/**
 * Run the install for a profile directory.
 *
 * A lockfile that cannot be honoured is the one failure worth retrying: a
 * snapshot can carry a lockfile written against paths this machine does not have,
 * and pnpm then refuses a frozen install. Resolving from the manifest instead is
 * the right recovery, and it is announced rather than done silently.
 *
 * @param {{profileDir: string, runner?: Function, env?: NodeJS.ProcessEnv, log?: (message: string) => void}} options - inputs.
 * @returns {{ok: boolean, code: number|null, output: string, retried: boolean, reason?: string}} the outcome.
 */
export function installProfile(options) {
	const { profileDir, runner = defaultRunner, env = process.env, log = () => {} } = options;
	if (typeof runner !== 'function') {
		return { ok: false, code: null, output: '', retried: false, reason: 'no installer runner was supplied' };
	}
	if (typeof profileDir !== 'string' || profileDir === '') {
		return { ok: false, code: null, output: '', retried: false, reason: 'no profile directory is known' };
	}
	if (!existsSync(join(profileDir, 'package.json'))) {
		return { ok: false, code: null, output: '', retried: false, reason: `no profile manifest at ${profileDir}` };
	}

	const attempt = (args) => runner(args, { cwd: profileDir, env });
	let result = attempt(['install']);
	let retried = false;
	let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

	if (result.error !== undefined) {
		const message = result.error.code === 'ENOENT'
			? 'pnpm is not installed or not on PATH — install pnpm, then run "pnpm install" in the profile directory'
			: `could not run pnpm: ${result.error.message}`;
		return { ok: false, code: null, output, retried, reason: message };
	}

	if ((result.status ?? 1) !== 0 && /frozen[- ]lockfile|lockfile.*not.*up to date|ERR_PNPM_OUTDATED_LOCKFILE/i.test(output)) {
		log('the snapshot\'s lockfile does not match this machine; resolving from the manifest instead');
		result = attempt(['install', '--no-frozen-lockfile']);
		retried = true;
		output = `${output}\n${result.stdout ?? ''}${result.stderr ?? ''}`;
		if (result.error !== undefined) {
			return { ok: false, code: null, output, retried, reason: `could not run pnpm: ${result.error.message}` };
		}
	}

	const code = result.status ?? 1;
	return { ok: code === 0, code, output, retried };
}

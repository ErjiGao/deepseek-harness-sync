/**
 * Tests for installing the plugin set a snapshot describes.
 *
 * The behaviour that matters is the *decision*: an install must run exactly when
 * a pull changed which packages the profile needs, and never otherwise. Running
 * it on every pull makes a routine sync as slow as a cold install; never running
 * it leaves the launcher refusing to boot, because a listed bundle that is not on
 * disk aborts startup.
 *
 * @module deepseek-harness-sync/test/profile-install
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { diffManifests, installProfile, manifestPackages } from '../lib/core/profile-install.js';
import { buildSnapshot, stableStringify } from '../lib/core/snapshot.js';
import { loadContext } from '../lib/commands/shared.js';
import { run as runPull } from '../lib/commands/pull.js';
import { Ui } from '../lib/ui.js';
import { cleanEnv, harnessFiles, makeBareRemote, makeRoot, runCli, seedRemote, tempDir } from './helpers.mjs';

/**
 * A runner that records its calls and answers with a fixed result.
 *
 * @param {{status?: number|null, stdout?: string, stderr?: string, error?: Error}} [answer] - what to return.
 * @returns {{calls: Array<{args: string[], cwd: string}>, runner: Function}} the recorder.
 */
function fakeRunner(answer = {}) {
	/** @type {Array<{args: string[], cwd: string}>} */
	const calls = [];
	return {
		calls,
		runner: (args, options) => {
			calls.push({ args, cwd: options.cwd });
			return { status: answer.status ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', error: answer.error };
		},
	};
}

/** A profile manifest with one more dependency than the fixture below. */
const MANIFEST_WITH_EXTRA = `${JSON.stringify({
	name: 'dsh-profile-web',
	private: true,
	dependencies: { '@deepseek-ai/dsh-base': '^0.1.5-rc.1', 'dsh-gaussian-dft': 'github:ErjiGao/dsh-gaussian-dft' },
	dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gaussian-dft'], patchReload: 'live' } },
}, null, 2)}\n`;

describe('manifest comparison', () => {
	it('unions dependencies and the bundle stack', () => {
		const names = manifestPackages(MANIFEST_WITH_EXTRA);
		assert.ok(names.has('@deepseek-ai/dsh-base'));
		assert.ok(names.has('dsh-gaussian-dft'));
	});

	it('survives a missing or malformed manifest instead of throwing', () => {
		assert.equal(manifestPackages(undefined).size, 0);
		assert.equal(manifestPackages('').size, 0);
		assert.equal(manifestPackages('{ not json').size, 0);
		assert.equal(manifestPackages('[]').size, 0);
	});

	it('reports what a pull would add and remove', () => {
		const before = harnessFiles()['profiles/web/package.json'];
		const added = diffManifests(before, MANIFEST_WITH_EXTRA);
		assert.equal(added.changed, true);
		assert.deepEqual(added.added, ['dsh-gaussian-dft']);
		assert.deepEqual(added.removed, []);

		const removed = diffManifests(MANIFEST_WITH_EXTRA, before);
		assert.equal(removed.changed, true);
		assert.deepEqual(removed.added, []);
		assert.deepEqual(removed.removed, ['dsh-gaussian-dft']);

		assert.equal(diffManifests(before, before).changed, false);
		assert.equal(diffManifests(undefined, undefined).changed, false);
	});
});

describe('installer', () => {
	it('runs pnpm install in the profile directory', () => {
		const profileDir = tempDir('profile');
		makeRoot({ 'package.json': '{}\n' }, profileDir);
		const fake = fakeRunner({ stdout: 'Done in 3.5s' });
		const result = installProfile({ profileDir, runner: fake.runner });
		assert.equal(result.ok, true);
		assert.equal(result.retried, false);
		assert.deepEqual(fake.calls, [{ args: ['install'], cwd: profileDir }]);
		assert.match(result.output, /Done in 3\.5s/);
	});

	it('refuses to run without a profile manifest, and says where it looked', () => {
		const profileDir = tempDir('empty-profile');
		const fake = fakeRunner();
		const result = installProfile({ profileDir, runner: fake.runner });
		assert.equal(result.ok, false);
		assert.match(result.reason, /no profile manifest/);
		assert.deepEqual(fake.calls, [], 'nothing should be executed');
	});

	it('turns a missing pnpm into an instruction, not a crash', () => {
		const profileDir = tempDir('nopnpm');
		makeRoot({ 'package.json': '{}\n' }, profileDir);
		const fake = fakeRunner({ error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) });
		const result = installProfile({ profileDir, runner: fake.runner });
		assert.equal(result.ok, false);
		assert.match(result.reason, /pnpm is not installed/);
	});

	it('retries without the lockfile when the snapshot lockfile does not fit this machine', () => {
		const profileDir = tempDir('frozen');
		makeRoot({ 'package.json': '{}\n' }, profileDir);
		/** @type {string[][]} */
		const seen = [];
		let call = 0;
		const runner = (args) => {
			seen.push(args);
			call += 1;
			return call === 1
				? { status: 1, stdout: '', stderr: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"' }
				: { status: 0, stdout: 'resolved', stderr: '' };
		};
		const result = installProfile({ profileDir, runner });
		assert.equal(result.ok, true);
		assert.equal(result.retried, true);
		assert.deepEqual(seen, [['install'], ['install', '--no-frozen-lockfile']]);
	});

	it('reports a genuine failure with its exit code', () => {
		const profileDir = tempDir('broken');
		makeRoot({ 'package.json': '{}\n' }, profileDir);
		const fake = fakeRunner({ status: 2, stderr: 'ERR_PNPM_NO_MATCHING_VERSION' });
		const result = installProfile({ profileDir, runner: fake.runner });
		assert.equal(result.ok, false);
		assert.equal(result.code, 2);
		assert.match(result.output, /ERR_PNPM_NO_MATCHING_VERSION/);
	});
});

describe('pull installs only when the plugin set changed', () => {
	/**
	 * Seed a remote snapshot whose profile manifest differs from the local one.
	 *
	 * @param {{extraPlugin: boolean}} options - whether the snapshot adds a plugin.
	 * @returns {Promise<{root: string}>} the local harness home.
	 */
	async function pullScenario(options) {
		const parent = tempDir('install-pull');
		const remote = makeBareRemote(parent);
		const localPackage = harnessFiles()['profiles/web/package.json'];
		const files = {
			...harnessFiles(),
			// Always differ in settings.yaml, so the pull has something to apply even
			// when the plugin set is unchanged.
			'settings.yaml': 'agent-default-model:\n  model: from-other-machine\n',
			...(options.extraPlugin ? { 'profiles/web/package.json': MANIFEST_WITH_EXTRA } : { 'profiles/web/package.json': localPackage }),
		};
		seedRemote(remote, { 'config/harness-config.json': stableStringify(buildSnapshot({ version: 1, device: 'other', profile: 'web', files })) });
		const root = makeRoot(harnessFiles(), join(parent, 'local'));
		const initialized = await runCli(['init', '--url', remote, '--branch', 'main'], { root });
		assert.equal(initialized.code, 0, initialized.out);
		return { root };
	}

	/**
	 * Run a pull with an injected installer.
	 *
	 * @param {string} root - the harness home.
	 * @param {{noInstall?: boolean}} [options] - pull overrides.
	 * @returns {Promise<{code: number, out: string, calls: Array<{args: string[], cwd: string}>}>} the run.
	 */
	async function pullWithFakeInstaller(root, options = {}) {
		/** @type {string[]} */
		const chunks = [];
		const sink = { isTTY: false, write: (chunk) => { chunks.push(String(chunk)); return true; } };
		const ui = new Ui({ out: sink, err: sink, color: false, env: {} });
		const ctx = loadContext({ ui, env: cleanEnv(), root, token: null });
		const fake = fakeRunner({ stdout: 'Done in 1.2s' });
		ctx.installRunner = fake.runner;
		const code = await runPull(ctx, options);
		return { code, out: chunks.join(''), calls: fake.calls };
	}

	it('installs when the snapshot adds a plugin', async () => {
		const { root } = await pullScenario({ extraPlugin: true });
		const result = await pullWithFakeInstaller(root);
		assert.equal(result.code, 0, result.out);
		assert.equal(result.calls.length, 1, `expected one install, got ${JSON.stringify(result.calls)}`);
		assert.deepEqual(result.calls[0].args, ['install']);
		assert.equal(result.calls[0].cwd, join(root, 'profiles', 'web'));
		assert.match(result.out, /plugins installed/);
		assert.match(result.out, /added\s+dsh-gaussian-dft/);
	});

	it('does not install when the plugin set is unchanged', async () => {
		const { root } = await pullScenario({ extraPlugin: false });
		const result = await pullWithFakeInstaller(root);
		assert.equal(result.code, 0, result.out);
		assert.deepEqual(result.calls, [], 'a routine sync must not re-run an install');
	});

	it('honours --no-install and says what to run instead', async () => {
		const { root } = await pullScenario({ extraPlugin: true });
		const result = await pullWithFakeInstaller(root, { noInstall: true });
		assert.equal(result.code, 0, result.out);
		assert.deepEqual(result.calls, []);
		assert.match(result.out, /--no-install/);
		assert.match(result.out, /pnpm install/);
	});

	it('does not install during a dry run', async () => {
		const { root } = await pullScenario({ extraPlugin: true });
		const result = await pullWithFakeInstaller(root, { dryRun: true });
		assert.equal(result.code, 0, result.out);
		assert.deepEqual(result.calls, [], 'a dry run must have no side effects');
	});

	it('a failed install does not fail the pull', async () => {
		const { root } = await pullScenario({ extraPlugin: true });
		/** @type {string[]} */
		const chunks = [];
		const sink = { isTTY: false, write: (chunk) => { chunks.push(String(chunk)); return true; } };
		const ui = new Ui({ out: sink, err: sink, color: false, env: {} });
		const ctx = loadContext({ ui, env: cleanEnv(), root, token: null });
		ctx.installRunner = fakeRunner({ status: 1, stderr: 'ERR_PNPM_FETCH_404' }).runner;
		const code = await runPull(ctx);
		assert.equal(code, 0, 'the configuration is already applied; the install is reported, not fatal');
		assert.match(chunks.join(''), /the install did not succeed/);
		assert.match(chunks.join(''), /Do not restart DeepSeek Harness until it succeeds/);
	});
});

/**
 * End-to-end tests against a throwaway Git remote standing in for GitHub.
 *
 * The two-device drill is the important one: it proves the divergence guard
 * actually refuses to overwrite a repository that moved, which is the whole
 * reason `--force` exists as a separate, explicit decision.
 *
 * @module deepseek-harness-sync/test/e2e
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cleanEnv, harnessFiles, listRemote, makeBareRemote, makeRoot, readRel, runCli, seedRemote, tempDir } from './helpers.mjs';

const PROFILE = 'web';

/**
 * Build the two-device scenario: a bare remote plus two independent harness homes.
 *
 * @returns {{remote: string, a: string, b: string}} the paths.
 */
function scenario() {
	const parent = tempDir('e2e');
	const remote = makeBareRemote(parent);
	const a = makeRoot(harnessFiles({ settings: 'agent-default-model:\n  model: device-a\n' }), join(parent, 'a'));
	const b = makeRoot(harnessFiles({ settings: 'agent-default-model:\n  model: device-b\n' }), join(parent, 'b'));
	return { remote, a, b };
}

describe('two-device synchronization', () => {
	it('pushes from one device, pulls on another, and restores the same configuration', async () => {
		const { remote, a, b } = scenario();

		const aInit = await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: a });
		assert.equal(aInit.code, 0, aInit.out);
		assert.match(aInit.out, /not a recognizable GitHub repository URL/);

		const aPush = await runCli(['push'], { root: a });
		assert.equal(aPush.code, 0, aPush.out);
		assert.match(aPush.out, /pushed version 1/);
		// The privacy check could not run without a token, so push must say so
		// rather than claim the repository is private.
		assert.match(aPush.out, /privacy was never verified/);
		assert.doesNotMatch(aPush.out, /confirmed this repository was private/);

		const bInit = await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: b });
		assert.equal(bInit.code, 0, bInit.out);

		const bPull = await runCli(['pull'], { root: b });
		assert.equal(bPull.code, 0, bPull.out);
		assert.match(bPull.out, /applied version 1/);
		assert.equal(readRel(b, 'settings.yaml'), readRel(a, 'settings.yaml'));
		assert.equal(readRel(b, 'profiles/web/package.json'), readRel(a, 'profiles/web/package.json'));

		// The pull wrote a backup before it touched anything.
		assert.match(bPull.out, /backed up current configuration to/);
	});

	it('refuses to overwrite a repository that advanced, and says what to do', async () => {
		const { remote, a, b } = scenario();
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: b });
		assert.equal((await runCli(['push'], { root: a })).code, 0);
		assert.equal((await runCli(['pull'], { root: b })).code, 0);

		// B moves first.
		const bSettings = join(b, 'settings.yaml');
		const { writeFileSync } = await import('node:fs');
		writeFileSync(bSettings, 'agent-default-model:\n  model: device-b-v2\n', 'utf8');
		const bPush = await runCli(['push'], { root: b });
		assert.equal(bPush.code, 0, bPush.out);
		assert.match(bPush.out, /pushed version 2/);

		// A has also moved, without knowing about B.
		writeFileSync(join(a, 'settings.yaml'), 'agent-default-model:\n  model: device-a-v2\n', 'utf8');
		const conflicted = await runCli(['push'], { root: a });
		assert.equal(conflicted.code, 2, conflicted.out);
		assert.match(conflicted.out, /Remote configuration has changed\./);
		assert.match(conflicted.out, /Local:  version 2/);
		assert.match(conflicted.out, /Remote: version 2/);
		assert.match(conflicted.out, /1\. Pull remote configuration/);
		assert.match(conflicted.out, /2\. Force push local configuration/);
		assert.match(conflicted.out, /3\. Show differences/);

		// Nothing was uploaded: B's version is still what the remote holds.
		const bPullAfter = await runCli(['pull', '--dry-run'], { root: b });
		assert.match(bPullAfter.out, /already matches the repository/);

		// The explicit decision goes through.
		const forced = await runCli(['push', '--force'], { root: a });
		assert.equal(forced.code, 0, forced.out);
		assert.match(forced.out, /pushed version 3/);
		assert.match(forced.out, /forcing past a remote that advanced/);

		// And B now receives A's content.
		const bPull = await runCli(['pull'], { root: b });
		assert.equal(bPull.code, 0, bPull.out);
		assert.equal(readRel(b, 'settings.yaml'), 'agent-default-model:\n  model: device-a-v2\n');
	});

	it('reports synchronized once both sides agree', async () => {
		const { remote, a, b } = scenario();
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: b });
		await runCli(['push'], { root: a });
		await runCli(['pull'], { root: b });

		const bStatus = await runCli(['status'], { root: b });
		assert.equal(bStatus.code, 0, bStatus.out);
		assert.match(bStatus.out, /^GitHub repository: connected$/m);
		assert.match(bStatus.out, /^Local config: found$/m);
		assert.match(bStatus.out, /^Remote config: found$/m);
		assert.match(bStatus.out, /^Local version: 1$/m);
		assert.match(bStatus.out, /^Remote version: 1$/m);
		assert.match(bStatus.out, /^Status: synchronized$/m);

		// A local edit shows up as an unpushed change, and the suggested version moves.
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(b, 'settings.yaml'), 'agent-default-model:\n  model: edited\n', 'utf8');
		const dirty = await runCli(['status'], { root: b });
		assert.equal(dirty.code, 1, dirty.out);
		assert.match(dirty.out, /^Local version: 2$/m);
		assert.match(dirty.out, /Status: local configuration has unpushed changes/);
	});

	it('sync never silently overwrites: it asks when both sides have content', async () => {
		const { remote, a, b } = scenario();
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: b });
		await runCli(['push'], { root: a });

		// B has never synced and already has local content. Auto-pushing here
		// would replace the user's real configuration with a fresh install, so
		// sync must stop and ask instead.
		const bSync = await runCli(['sync'], { root: b });
		assert.equal(bSync.code, 2, bSync.out);
		assert.match(bSync.out, /never synced/);
		assert.match(bSync.out, /Remote configuration has changed\./);
		assert.match(bSync.out, /1\. Pull remote configuration/);

		// The explicit choice works, and then the automatic paths take over.
		assert.equal((await runCli(['pull'], { root: b })).code, 0);
		assert.equal(readRel(b, 'settings.yaml'), readRel(a, 'settings.yaml'));

		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(a, 'settings.yaml'), `agent-default-model:\n  model: edited-on-a\n`, 'utf8');
		const aSync = await runCli(['sync'], { root: a });
		assert.equal(aSync.code, 0, aSync.out);
		assert.match(aSync.out, /has unpushed changes; pushing/);

		const bSync2 = await runCli(['sync'], { root: b });
		assert.equal(bSync2.code, 0, bSync2.out);
		assert.match(bSync2.out, /repository is newer; pulling/);
		assert.equal(readRel(b, 'settings.yaml'), 'agent-default-model:\n  model: edited-on-a\n');

		const settled = await runCli(['sync'], { root: b });
		assert.equal(settled.code, 0, settled.out);
		assert.match(settled.out, /already synchronized/);
	});

	it('rolls back to the configuration from before a pull', async () => {
		const { remote, a, b } = scenario();
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: b });
		await runCli(['push'], { root: a });

		const before = readRel(b, 'settings.yaml');
		assert.equal((await runCli(['pull'], { root: b })).code, 0);
		assert.notEqual(readRel(b, 'settings.yaml'), before);

		const listed = await runCli(['rollback', '--list'], { root: b });
		assert.equal(listed.code, 0, listed.out);
		assert.match(listed.out, /before pull to v1/);

		const rolled = await runCli(['rollback'], { root: b });
		assert.equal(rolled.code, 0, rolled.out);
		assert.equal(readRel(b, 'settings.yaml'), before, 'rollback must restore the pre-pull configuration');

		// And the rollback is itself reversible: it saved the state it replaced.
		const after = await runCli(['rollback', '--list'], { root: b });
		assert.match(after.out, /before rollback to/);
	});

	it('refuses to publish a credential found in a synced file', async () => {
		const { remote, a } = scenario();
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(a, 'settings.yaml'), `llm-deepseek:\n  apiKey: ghp_${'B'.repeat(36)}\n`, 'utf8');

		const pushed = await runCli(['push'], { root: a });
		assert.equal(pushed.code, 1, pushed.out);
		assert.match(pushed.out, /refusing to push/);
		assert.ok(!pushed.out.includes('B'.repeat(36)), 'the secret must not appear in the output');
		assert.match(pushed.out, /Nothing was committed or pushed/);
	});

	it('reuses a repository another tool already writes to, without clobbering it', async () => {
		// The real case: reusing a repository that already holds another tool's
		// snapshots and its own README.
		const parent = tempDir('reuse');
		const remote = makeBareRemote(parent);
		const foreignReadme = '# DSH-Sync-Data\n\nManaged by dsh-config-manager.\n';
		seedRemote(remote, {
			'README.md': foreignReadme,
			'.gitignore': '*.tmp\nbuild/\n',
			'snapshots/sync-abc/manifest.json': '{"sections":{}}\n',
		});
		const a = makeRoot(harnessFiles(), join(parent, 'a'));

		const initialized = await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		assert.equal(initialized.code, 0, initialized.out);

		const pushed = await runCli(['push'], { root: a });
		assert.equal(pushed.code, 0, pushed.out);
		assert.match(pushed.out, /kept the repository's own README\.md/);
		assert.match(pushed.out, /appended this plugin's block to the repository's own \.gitignore/);

		const files = listRemote(remote, 'main');
		assert.equal(files['README.md'], foreignReadme, 'a foreign README must survive untouched');
		assert.match(files['.gitignore'], /\*\.tmp/, 'foreign gitignore rules must survive');
		assert.match(files['.gitignore'], /build\//);
		assert.match(files['.gitignore'], /deepseek-harness-sync secrets/, 'our block must be appended');
		assert.ok(files['config/harness-config.json'], 'the snapshot must be present');
		assert.ok(files['metadata.json'], 'the index must be present');
		assert.ok(files['snapshots/sync-abc/manifest.json'], 'unrelated content must be untouched');

		// Pushing again must not append our block a second time.
		assert.equal((await runCli(['push'], { root: a })).code, 0);
		const after = listRemote(remote, 'main');
		const occurrences = (after['.gitignore'].match(/deepseek-harness-sync secrets/g) ?? []).length;
		assert.equal(occurrences, 1, 'the gitignore block must be idempotent');
		assert.equal(after['README.md'], foreignReadme);
	});

	it('exports a snapshot to a file, and restores from it by path', async () => {
		const { remote, a } = scenario();
		await runCli(['init', '--url', remote, '--branch', 'main'], { root: a });
		const before = readRel(a, 'settings.yaml');

		const exported = await runCli(['export'], { root: a });
		assert.equal(exported.code, 0, exported.out);
		assert.match(exported.out, /wrote a restorable snapshot/);

		const dir = join(a, 'harness-sync', 'exports');
		const names = readdirSync(dir);
		assert.equal(names.length, 1);
		assert.match(names[0], /^harness-config-[0-9A-Za-z._-]+\.json$/);

		// An export lives outside the rotation `pull` prunes, and the CLI restores
		// one directly from its path.
		writeFileSync(join(a, 'settings.yaml'), 'wrecked: true\n', 'utf8');
		const restored = await runCli(['rollback', '--to', join(dir, names[0])], { root: a });
		assert.equal(restored.code, 0, restored.out);
		assert.equal(readRel(a, 'settings.yaml'), before);
	});

	it('reports an uninitialized device instead of guessing', async () => {
		const root = makeRoot(harnessFiles());
		const status = await runCli(['status'], { root });
		assert.equal(status.code, 1, status.out);
		assert.match(status.out, /GitHub repository: not configured/);
		assert.match(status.out, /Status: this device is not initialized/);

		const pushed = await runCli(['push'], { root });
		assert.equal(pushed.code, 1, pushed.out);
		assert.match(pushed.out, /not initialized yet/);
	});

	it('refuses an unreachable repository with an actionable message', async () => {
		const root = makeRoot(harnessFiles());
		const bad = join(tempDir('missing'), 'does-not-exist.git');
		const result = await runCli(['init', '--url', bad, '--branch', 'main'], { root });
		assert.equal(result.code, 1, result.out);
		assert.match(result.out, /cannot reach the repository/);
		assert.equal(existsSync(join(root, 'harness-sync', 'config.json')), false);
	});
});

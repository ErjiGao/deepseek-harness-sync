/**
 * Tests for the guard that stops a push from deleting a layer it could not see.
 *
 * The defect this pins is quiet and destructive: a push with no workspace
 * configured publishes a snapshot with no `workspace/` entries, which removes the
 * workspace layer from the repository. The divergence check cannot catch it,
 * because the remote version advanced only through this plugin's own pushes — so
 * the state looks perfectly synchronized while the snapshot silently loses the
 * skills, notes and repositories the workspace carried.
 *
 * @module deepseek-harness-sync/test/workspace-guard
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildSnapshot, stableStringify } from '../lib/core/snapshot.js';
import { writeState } from '../lib/core/state.js';
import { harnessFiles, makeBareRemote, makeRoot, runCli, seedRemote, tempDir } from './helpers.mjs';

/**
 * Seed a remote whose snapshot carries a workspace layer, and a local machine
 * whose state already agrees with it — so only the workspace guard can fire.
 *
 * @returns {Promise<{remote: string, root: string}>} the scenario.
 */
async function scenario() {
	const parent = tempDir('wsguard');
	const remote = makeBareRemote(parent);
	const envelope = buildSnapshot({
		version: 1,
		device: 'other-device',
		profile: 'web',
		files: {
			'settings.yaml': 'agent-default-model:\n  model: deepseek-flash\n',
			'workspace/.dsh/skills/demo/SKILL.md': '---\nname: demo\n---\n',
			'workspace/.dsh/notes.md': 'notes\n',
		},
	});
	seedRemote(remote, {
		'config/harness-config.json': stableStringify(envelope),
		'metadata.json': `${JSON.stringify({ version: 1 })}\n`,
	});

	const root = makeRoot(harnessFiles(), join(parent, 'local'));
	const initialized = await runCli(['init', '--url', remote, '--branch', 'main'], { root });
	assert.equal(initialized.code, 0, initialized.out);

	// `init` records baseVersion 0; agree with the remote so the divergence check
	// stays quiet and the workspace guard is the only thing left that can refuse.
	writeState(join(root, 'harness-sync', 'config.json'), {
		schema: 1,
		repoUrl: remote,
		branch: 'main',
		profile: 'web',
		device: 'this-device',
		localVersion: 1,
		baseVersion: 1,
		keepBackups: 5,
		repoPrivate: 'unverified',
	});
	return { remote, root };
}

describe('workspace-dropping guard', () => {
	it('refuses a push that would delete the workspace layer, and says how to include it', async () => {
		const { root } = await scenario();
		const pushed = await runCli(['push'], { root });
		assert.equal(pushed.code, 2, pushed.out);
		assert.match(pushed.out, /holds 2 workspace file\(s\), but this run collected none/);
		assert.match(pushed.out, /would delete the workspace layer/);
		assert.match(pushed.out, /--workspace <path>/);
		assert.match(pushed.out, /push --force/);
	});

	it('allows the same push when the workspace is configured', async () => {
		const { root } = await scenario();
		const workspace = makeRoot({ '.dsh/skills/demo/SKILL.md': '---\nname: demo\n---\n' }, join(tempDir('ws'), 'work'));
		const pushed = await runCli(['push', '--workspace', workspace], { root });
		assert.equal(pushed.code, 0, pushed.out);
		assert.match(pushed.out, /workspace\/\.dsh\/skills\/demo\/SKILL\.md/);
	});

	it('allows dropping the layer deliberately, with --force', async () => {
		const { root } = await scenario();
		const pushed = await runCli(['push', '--force'], { root });
		assert.equal(pushed.code, 0, pushed.out);
	});

	it('does not fire when the remote carries no workspace at all', async () => {
		const parent = tempDir('nows');
		const remote = makeBareRemote(parent);
		const envelope = buildSnapshot({ version: 1, device: 'd', profile: 'web', files: { 'settings.yaml': 'a: 1\n' } });
		seedRemote(remote, { 'config/harness-config.json': stableStringify(envelope) });
		const root = makeRoot(harnessFiles(), join(parent, 'local'));
		assert.equal((await runCli(['init', '--url', remote, '--branch', 'main'], { root })).code, 0);
		writeState(join(root, 'harness-sync', 'config.json'), {
			schema: 1,
			repoUrl: remote,
			branch: 'main',
			profile: 'web',
			device: 'this-device',
			localVersion: 1,
			baseVersion: 1,
			keepBackups: 5,
			repoPrivate: 'unverified',
		});
		const pushed = await runCli(['push'], { root });
		assert.equal(pushed.code, 0, pushed.out);
	});
});

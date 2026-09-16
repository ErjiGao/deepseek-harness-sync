/**
 * The workspace layer, end to end through a throwaway Git remote.
 *
 * The unit tests prove the allowlist and the path routing. This file proves the
 * thing a user actually cares about: that pointing the tool at a real workspace
 * and pushing puts the right bytes in the repository and leaves the wrong ones
 * out — and that a credential in the workspace stops the push instead of being
 * published.
 *
 * Nothing here touches a real `$DSH_HOME` or a real GitHub repository.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { harnessFiles, listRemote, makeBareRemote, makeRoot, runCli, tempDir } from './helpers.mjs';

const PROFILE = 'web';

/**
 * Build a workspace that exercises every branch of the collector.
 *
 * @param {string} root - where to build it.
 * @returns {string} the workspace root.
 */
function makeWorkspace(root) {
	const put = (rel, text) => {
		const abs = join(root, ...rel.split('/'));
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, text, 'utf8');
	};
	// Should be captured.
	put('.dsh/config.toml', 'theme = "dark"\n');
	put('.dsh/skills/mine/SKILL.md', '# my skill\n');
	put('AGENTS.md', '# workspace baseline\n');
	// Should be refused: an allow pattern matches, but the name is sensitive.
	put('.dsh/.env', 'OPENAI_API_KEY=sk-proj-REALVALUE1234567890abcdefgh\n');
	put('.dsh/credentials.json', '{"token":"REALVALUE"}\n');
	put('notes/server.pem', '-----BEGIN PRIVATE KEY-----\nREALVALUE\n');
	// Should never be looked at: not on the allowlist.
	put('water_density/data.csv', 'x,y\n1,2\n');
	put('src/main.py', 'print(1)\n');
	put('node_modules/pkg/index.js', 'x\n');
	return root;
}

/**
 * Build a workspace containing a real git repository.
 *
 * @param {string} root - where to build it.
 * @param {string} remoteUrl - the URL to record as `origin`.
 * @returns {string} the repository path.
 */
function makeRepo(root, remoteUrl) {
	const repo = join(root, 'my-plugin');
	mkdirSync(repo, { recursive: true });
	execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repo, stdio: 'ignore' });
	writeFileSync(join(repo, 'README.md'), '# plugin README that must not be copied\n', 'utf8');
	writeFileSync(join(repo, 'secret.key'), '-----BEGIN PRIVATE KEY-----\nMUSTNOTAPPEAR\n', 'utf8');
	// Commit, so the branch ref exists. `readRepoInfo` reports only what git has
	// actually written: a repository with no commit has no branch to record, and
	// asserting for one would be asserting a fact git never created.
	execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'add', '-A'], { cwd: repo, stdio: 'ignore' });
	execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
	return repo;
}

describe('workspace synchronization, end to end', () => {
	it('pushes workspace configuration, never the workspace secrets, and never repository contents', async () => {
		const parent = tempDir('ws-e2e');
		const remote = makeBareRemote(parent);
		const home = makeRoot(harnessFiles(), join(parent, 'home'));
		const workspace = makeWorkspace(join(parent, 'workspace'));
		makeRepo(workspace, 'https://example.invalid/my-plugin.git');

		assert.equal((await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: home })).code, 0);
		const push = await runCli(['push', '--workspace', workspace], { root: home });
		assert.equal(push.code, 0, push.out);
		assert.match(push.out, /pushed version 1/);

		const files = listRemote(remote);
		const snapshot = JSON.parse(files['config/harness-config.json']);

		// --- what must be there -------------------------------------------------
		assert.ok('settings.yaml' in snapshot.files, 'the harness home is still covered');
		assert.equal(snapshot.files['workspace/.dsh/config.toml'], 'theme = "dark"\n');
		assert.equal(snapshot.files['workspace/AGENTS.md'], '# workspace baseline\n');
		assert.equal(snapshot.files['workspace/.dsh/skills/mine/SKILL.md'], '# my skill\n');

		// --- what must NOT be there ---------------------------------------------
		const rels = Object.keys(snapshot.files);
		assert.equal(rels.some((rel) => rel.includes('.env')), false, 'a .env must never be uploaded');
		assert.equal(rels.some((rel) => rel.includes('credentials')), false, 'a credentials file must never be uploaded');
		assert.equal(rels.some((rel) => rel.endsWith('.pem')), false, 'a key file must never be uploaded');
		assert.equal(rels.some((rel) => rel.includes('water_density')), false, 'research data must never be uploaded');
		assert.equal(rels.some((rel) => rel.startsWith('workspace/src/')), false, 'an unlisted source file must not be uploaded');
		assert.equal(rels.some((rel) => rel.includes('node_modules')), false, 'node_modules must never be uploaded');
		assert.equal(rels.some((rel) => rel.startsWith('workspace/my-plugin/')), false, 'repository contents must not be copied');

		// --- the whole repository must not contain a secret VALUE ---------------
		const everything = JSON.stringify(files);
		for (const value of ['sk-proj-REALVALUE', 'MUSTNOTAPPEAR', 'REALVALUE']) {
			assert.equal(everything.includes(value), false, `the repository must not contain ${value}`);
		}

		// --- repositories travel as references, plus a runnable script ----------
		const repos = snapshot.preferences.repositories;
		assert.equal(repos.length, 1);
		assert.equal(repos[0].path, 'my-plugin');
		assert.equal(repos[0].remote, 'https://example.invalid/my-plugin.git');
		assert.equal(repos[0].branch, 'main');
		// The commit is recorded too, so a restore can say where the repository
		// stood when the snapshot was taken. It is read from `.git`, not spawned.
		assert.match(repos[0].head, /^[0-9a-f]{40}$/, 'the HEAD commit is recorded');
		assert.ok(files['workspace-repos.sh'].includes("git clone --branch main 'https://example.invalid/my-plugin.git' 'my-plugin'"));
		assert.ok(files['config/workspace-repos.json'].includes('https://example.invalid/my-plugin.git'));
	});

	it('refuses the whole push when the workspace holds a credential, and never echoes it', async () => {
		const parent = tempDir('ws-secret');
		const remote = makeBareRemote(parent);
		const home = makeRoot(harnessFiles(), join(parent, 'home'));
		const workspace = join(parent, 'workspace');
		// A file that IS on the allowlist, holding a live-looking key.
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(workspace, 'AGENTS.md'), 'token: ghp_0123456789abcdefghijklmnopqrstuvwxyz\n', 'utf8');

		await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: home });
		const push = await runCli(['push', '--workspace', workspace], { root: home });
		assert.equal(push.code, 1, 'a credential in the workspace must stop the push');
		assert.match(push.out, /refusing to push/);
		assert.match(push.out, /workspace\/AGENTS\.md/, 'the offending file is named');
		assert.equal(push.out.includes('ghp_0123456789'), false, 'the value must never be echoed');
		// Nothing reached the remote.
		assert.deepEqual(listRemote(remote), {}, 'a refused push must publish nothing');
	});

	it('round-trips the workspace onto a second device', async () => {
		const parent = tempDir('ws-round');
		const remote = makeBareRemote(parent);
		const homeA = makeRoot(harnessFiles(), join(parent, 'a'));
		const wsA = makeWorkspace(join(parent, 'ws-a'));
		await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: homeA });
		const push = await runCli(['push', '--workspace', wsA], { root: homeA });
		assert.equal(push.code, 0, push.out);

		// Device B: a fresh home and a fresh, empty workspace.
		const homeB = makeRoot(harnessFiles(), join(parent, 'b'));
		const wsB = join(parent, 'ws-b');
		mkdirSync(wsB, { recursive: true });
		await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: homeB });
		const pull = await runCli(['pull', '--workspace', wsB], { root: homeB });
		assert.equal(pull.code, 0, pull.out);
		assert.match(pull.out, /workspace\/\.dsh\/config\.toml/, 'the workspace files are reported as written');

		// The workspace arrived, at the right paths, with the right bytes.
		assert.equal(readFileSync(join(wsB, '.dsh', 'config.toml'), 'utf8'), 'theme = "dark"\n');
		assert.equal(readFileSync(join(wsB, 'AGENTS.md'), 'utf8'), '# workspace baseline\n');
		assert.equal(readFileSync(join(wsB, '.dsh', 'skills', 'mine', 'SKILL.md'), 'utf8'), '# my skill\n');
		// And the secrets did not travel.
		assert.equal(existsSync(join(wsB, '.dsh', '.env')), false);
		assert.equal(existsSync(join(wsB, 'notes', 'server.pem')), false);
	});

	it('records the workspace at init, so later commands need no --workspace', async () => {
		const parent = tempDir('ws-record');
		const remote = makeBareRemote(parent);
		const homeA = makeRoot(harnessFiles(), join(parent, 'a'));
		const wsA = makeWorkspace(join(parent, 'ws-a'));
		// A repository, so the reference half of the round trip is exercised too.
		makeRepo(wsA, 'https://example.invalid/recorded.git');

		// The flag is given ONCE, at init.
		const init = await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE, '--workspace', wsA], { root: homeA });
		assert.equal(init.code, 0, init.out);
		assert.match(init.out, /workspace recorded for this device/);

		// From here on, no --workspace: the state remembers it.
		const push = await runCli(['push'], { root: homeA });
		assert.equal(push.code, 0, push.out);
		const snapshot = JSON.parse(listRemote(remote)['config/harness-config.json']);
		assert.equal(snapshot.files['workspace/.dsh/config.toml'], 'theme = "dark"\n', 'the workspace travelled without the flag');
		assert.equal(snapshot.preferences.repositories.length, 1, 'and so did the repository references');

		// A second device records its own workspace, which is a different path.
		const homeB = makeRoot(harnessFiles(), join(parent, 'b'));
		const wsB = join(parent, 'ws-b');
		mkdirSync(wsB, { recursive: true });
		await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE, '--workspace', wsB], { root: homeB });
		const pull = await runCli(['pull'], { root: homeB });
		assert.equal(pull.code, 0, pull.out);
		assert.equal(readFileSync(join(wsB, 'AGENTS.md'), 'utf8'), '# workspace baseline\n', 'device B used its own workspace path');
	});

	it('pull stops, writing nothing, when no workspace is configured but the snapshot has one', async () => {
		const parent = tempDir('ws-nows');
		const remote = makeBareRemote(parent);
		const homeA = makeRoot(harnessFiles(), join(parent, 'a'));
		const wsA = makeWorkspace(join(parent, 'ws-a'));
		await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: homeA });
		assert.equal((await runCli(['push', '--workspace', wsA], { root: homeA })).code, 0);

		const homeB = makeRoot(harnessFiles(), join(parent, 'b'));
		await runCli(['init', '--url', remote, '--branch', 'main', '--profile', PROFILE], { root: homeB });
		// No --workspace on this device.
		const pull = await runCli(['pull'], { root: homeB });
		assert.equal(pull.code, 1, 'an unroutable workspace entry must fail the pull');
		assert.match(pull.out, /no workspace root is configured/);
		// And it must not have half-applied the home half either.
		assert.equal(
			existsSync(join(homeB, 'workspace')),
			false,
			'no workspace directory may be invented',
		);
	});
});

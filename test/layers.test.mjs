/**
 * The seam between the two roots.
 *
 * These tests are about the boundary, not about either side of it: that a
 * workspace path is validated by the workspace rules and a home path by the home
 * rules, that neither can be smuggled through the other's whitelist, and that
 * applying a snapshot writes each file under the root its prefix names.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collect } from '../lib/core/collect.js';
import { applySnapshot, planApply, resolveEntry } from '../lib/core/apply.js';
import { assertSnapshotPath, splitSnapshotPath } from '../lib/core/manifest.js';
import { assertWorkspacePath } from '../lib/core/workspace.js';
import {
	CLONE_SCRIPT_PATH, REPOS_PATH, cloneScriptFor, collectAll, readRepositoriesFile,
	repositoryPreferences, repositoriesFrom, resolveSnapshotPath, validateEnvelopePaths,
} from '../lib/core/layers.js';
import { buildSnapshot } from '../lib/core/snapshot.js';

/**
 * A throwaway pair of roots.
 * @param {(roots: {home: string, workspace: string}) => void} body - the test body.
 */
function withRoots(body) {
	const base = mkdtempSync(join(tmpdir(), 'harness-sync-layers-'));
	const home = join(base, 'home');
	const workspace = join(base, 'workspace');
	mkdirSync(home, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	try {
		body({ home, workspace });
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

/**
 * Write a file under a root, creating parents.
 * @param {string} root - the root directory.
 * @param {string} rel - relative POSIX path.
 * @param {string} text - content.
 */
function put(root, rel, text) {
	const abs = join(root, ...rel.split('/'));
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, text, 'utf8');
}

// ---------------------------------------------------------------------------
// Path splitting
// ---------------------------------------------------------------------------
test('a snapshot path says which root it belongs to', () => {
	assert.deepEqual(splitSnapshotPath('settings.yaml'), { target: 'home', path: 'settings.yaml' });
	assert.deepEqual(splitSnapshotPath('profiles/web/package.json'), { target: 'home', path: 'profiles/web/package.json' });
	assert.deepEqual(splitSnapshotPath('workspace/AGENTS.md'), { target: 'workspace', path: 'AGENTS.md' });
	assert.deepEqual(splitSnapshotPath('workspace/.dsh/config.toml'), { target: 'workspace', path: '.dsh/config.toml' });
	// Legacy snapshots (written before the workspace layer existed) keep working:
	// a bare home path is still a home path.
	assert.equal(splitSnapshotPath('skills/mine/SKILL.md').target, 'home');
	// A file that merely starts with the prefix word but is not the prefix.
	assert.equal(splitSnapshotPath('workspaceX/file').target, 'home');
});

test('each root is validated by its own rules, and neither accepts the other path', () => {
	// A workspace path is checked against the workspace allowlist.
	assert.throws(() => assertSnapshotPath('workspace/water_density/data.csv', 'web', assertWorkspacePath), /workspace whitelist/);
	assert.throws(() => assertSnapshotPath('workspace/.env', 'web', assertWorkspacePath), /sensitive/);
	assert.equal(assertSnapshotPath('workspace/AGENTS.md', 'web', assertWorkspacePath).target, 'workspace');
	// A home path is checked against the home whitelist. `../` inside a workspace
	// entry cannot climb out, because the workspace validator refuses a segment
	// like `..` before any join happens.
	assert.throws(() => assertSnapshotPath('workspace/../settings.yaml', 'web', assertWorkspacePath), /traversal|refusing/);
	assert.throws(() => assertSnapshotPath('not-a-real-home-path', 'web', assertWorkspacePath), /home whitelist|whitelist/);
	assert.equal(assertSnapshotPath('settings.yaml', 'web', assertWorkspacePath).target, 'home');
	// The bare prefix is not a path.
	assert.throws(() => assertSnapshotPath('workspace', 'web', assertWorkspacePath), /bare workspace prefix/);
});

test('resolveSnapshotPath routes each prefix to its own root', () => {
	withRoots(({ home, workspace }) => {
		assert.equal(resolveSnapshotPath({ dshHome: home, workspace, rel: 'settings.yaml' }), join(home, 'settings.yaml'));
		assert.equal(resolveSnapshotPath({ dshHome: home, workspace, rel: 'workspace/.dsh/config.toml' }), join(workspace, '.dsh', 'config.toml'));
		// A workspace entry with no workspace known is refused, not silently skipped.
		assert.throws(() => resolveSnapshotPath({ dshHome: home, rel: 'workspace/AGENTS.md' }), /no workspace root is known/);
	});
});

// ---------------------------------------------------------------------------
// Collecting both roots
// ---------------------------------------------------------------------------
test('collectAll merges the home and the workspace under distinguishable paths', () => {
	withRoots(({ home, workspace }) => {
		put(home, 'settings.yaml', 'theme: dark\n');
		put(home, 'profiles/web/package.json', '{}\n');
		put(workspace, '.dsh/config.toml', 'x = 1\n');
		put(workspace, 'AGENTS.md', '# ws\n');
		put(workspace, 'water_density/data.csv', 'big\n');

		const result = collectAll({ dshHome: home, profile: 'web', workspace, collectHome: collect });
		assert.equal(result.files['settings.yaml'], 'theme: dark\n', 'home files keep their bare path');
		assert.equal(result.files['workspace/.dsh/config.toml'], 'x = 1\n', 'workspace files are prefixed');
		assert.equal(result.files['workspace/AGENTS.md'], '# ws\n');
		assert.equal('workspace/water_density/data.csv' in result.files, false);
		assert.equal(result.workspacePresent, true);
	});
});

test('collectAll works with no workspace, and says so', () => {
	withRoots(({ home }) => {
		put(home, 'settings.yaml', 'a: 1\n');
		const result = collectAll({ dshHome: home, profile: 'web', collectHome: collect });
		assert.equal(result.files['settings.yaml'], 'a: 1\n');
		assert.equal(result.workspacePresent, false);
		assert.ok(result.notes.some((note) => /no workspace was configured/.test(note)));
	});
});

test('collectAll refuses to run without a home collector', () => {
	assert.throws(() => collectAll({ dshHome: '/tmp', profile: 'web' }), /requires a collectHome function/);
});

// ---------------------------------------------------------------------------
// Applying both roots
// ---------------------------------------------------------------------------
test('applying a snapshot writes each file under its own root', () => {
	withRoots(({ home, workspace }) => {
		const envelope = buildSnapshot({
			version: 1,
			device: 'a',
			profile: 'web',
			files: {
				'settings.yaml': 'theme: light\n',
				'workspace/.dsh/config.toml': 'x = 2\n',
				'workspace/AGENTS.md': '# from snapshot\n',
			},
		});
		const plan = applySnapshot({ dshHome: home, profile: 'web', workspace, envelope });
		assert.deepEqual(plan.written.sort(), ['settings.yaml', 'workspace/.dsh/config.toml', 'workspace/AGENTS.md']);
		assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), 'theme: light\n');
		assert.equal(readFileSync(join(workspace, '.dsh', 'config.toml'), 'utf8'), 'x = 2\n');
		assert.equal(readFileSync(join(workspace, 'AGENTS.md'), 'utf8'), '# from snapshot\n');
	});
});

test('a hostile snapshot entry aborts the whole apply, writing nothing', () => {
	withRoots(({ home, workspace }) => {
		const envelope = buildSnapshot({
			version: 1,
			device: 'a',
			profile: 'web',
			files: {
				'settings.yaml': 'theme: light\n',
				'workspace/.env': 'OPENAI_API_KEY=sk-lEAKED\n',
			},
		});
		assert.throws(
			() => applySnapshot({ dshHome: home, profile: 'web', workspace, envelope }),
			/refusing to apply this snapshot/,
		);
		// The good entry before the bad one must not have been written either.
		assert.equal(existsSync(join(home, 'settings.yaml')), false, 'a rejected snapshot writes nothing at all');
		assert.equal(existsSync(join(workspace, '.env')), false);
	});
});

test('a workspace entry with no configured workspace is refused rather than skipped', () => {
	withRoots(({ home }) => {
		const envelope = buildSnapshot({
			version: 1, device: 'a', profile: 'web',
			files: { 'workspace/AGENTS.md': '# x\n' },
		});
		assert.throws(
			() => applySnapshot({ dshHome: home, profile: 'web', envelope }),
			/no workspace root is configured/,
		);
	});
});

test('planApply reports what would change without changing it', () => {
	withRoots(({ home, workspace }) => {
		const envelope = buildSnapshot({
			version: 1, device: 'a', profile: 'web',
			files: { 'workspace/AGENTS.md': '# new\n' },
		});
		const plan = planApply({ dshHome: home, profile: 'web', workspace, envelope });
		assert.deepEqual(plan.written, ['workspace/AGENTS.md']);
		assert.equal(existsSync(join(workspace, 'AGENTS.md')), false, 'planning must not write');
	});
});

test('resolveEntry refuses the bare prefix and unroutable workspace paths', () => {
	withRoots(({ home, workspace }) => {
		assert.throws(() => resolveEntry({ dshHome: home, workspace, profile: 'web', rel: 'workspace' }), /bare workspace prefix/);
		assert.throws(() => resolveEntry({ dshHome: home, workspace, profile: 'web', rel: 'workspace/.env' }), /sensitive/);
		assert.throws(() => resolveEntry({ dshHome: home, profile: 'web', rel: 'workspace/x' }), /no workspace root is configured/);
	});
});

// ---------------------------------------------------------------------------
// Repositories travel as preferences
// ---------------------------------------------------------------------------
test('repository references round-trip through a snapshot', () => {
	const repositories = [
		{ path: 'dsh-qe-dft', remote: 'https://github.com/ErjiGao/dsh-qe-dft.git', branch: 'main', head: 'abc123' },
		{ path: 'local-only' },
	];
	const envelope = buildSnapshot({
		version: 1, device: 'a', profile: 'web', files: {},
		preferences: repositoryPreferences(repositories),
	});
	const back = repositoriesFrom(envelope);
	assert.deepEqual(back, repositories);
});

test('repositoriesFrom tolerates a snapshot with nothing recorded', () => {
	assert.deepEqual(repositoriesFrom({ preferences: {} }), []);
	assert.deepEqual(repositoriesFrom({}), []);
	assert.deepEqual(repositoriesFrom({ preferences: { repositories: 'nonsense' } }), []);
	// A malformed entry is dropped rather than trusted.
	assert.deepEqual(repositoriesFrom({ preferences: { repositories: [{ noPath: true }, { path: 'ok' }] } }), [{ path: 'ok' }]);
});

test('readRepositoriesFile reads the file a snapshot wrote, and survives nonsense', () => {
	const base = mkdtempSync(join(tmpdir(), 'harness-sync-repos-'));
	try {
		assert.deepEqual(readRepositoriesFile(base), [], 'missing file yields an empty list');
		mkdirSync(join(base, 'config'), { recursive: true });
		writeFileSync(join(base, ...REPOS_PATH.split('/')), JSON.stringify({ repositories: [{ path: 'a', remote: 'r' }] }), 'utf8');
		assert.deepEqual(readRepositoriesFile(base), [{ path: 'a', remote: 'r' }]);
		writeFileSync(join(base, ...REPOS_PATH.split('/')), '{ broken', 'utf8');
		assert.deepEqual(readRepositoriesFile(base), [], 'a broken file yields an empty list rather than throwing');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
	assert.equal(CLONE_SCRIPT_PATH, 'workspace-repos.sh');
});

test('cloneScriptFor renders a runnable script from the references', () => {
	const script = cloneScriptFor([{ path: 'p', remote: 'https://example.invalid/p.git', branch: 'main' }]);
	assert.ok(script.startsWith('#!/bin/sh'));
	assert.ok(script.includes("git clone --branch main 'https://example.invalid/p.git' 'p'"));
});

// ---------------------------------------------------------------------------
// Whole-envelope validation
// ---------------------------------------------------------------------------
test('validateEnvelopePaths reports every bad entry and accepts a good envelope', () => {
	const good = { files: { 'settings.yaml': 'a\n', 'workspace/AGENTS.md': 'b\n' }, absent: [] };
	assert.deepEqual(validateEnvelopePaths(good, 'web'), []);

	const bad = {
		files: {
			'settings.yaml': 'ok\n',
			'workspace/.env': 'leak\n',
			'workspace/water_density/x.csv': 'no\n',
			'../escape': 'no\n',
		},
		absent: ['workspace/id_rsa'],
	};
	const problems = validateEnvelopePaths(bad, 'web');
	assert.equal(problems.length, 4, `expected four rejections, got ${JSON.stringify(problems, null, 1)}`);
	assert.ok(problems.every((message) => typeof message === 'string' && message.length > 0));
});

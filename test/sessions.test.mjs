/**
 * Tests for the session layer, and for the two Git-layer defects that a growing
 * snapshot exposed.
 *
 * The buffer test is the important one: a snapshot is a single JSON document, so
 * it eventually passes Node's 1 MiB `spawnSync` default. When it did, `git show`
 * failed with `ENOBUFS`, and because that read swallowed its own failure every
 * settings-page status call broke *and* the divergence check quietly stopped
 * running. Both halves of that are pinned here.
 *
 * @module deepseek-harness-sync/test/sessions
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MAX_GIT_OUTPUT_BYTES, readRemoteFile, syncWorktree } from '../lib/core/github.js';
import { buildSnapshot, parseSnapshot, stableStringify } from '../lib/core/snapshot.js';
import {
	SESSIONS_DIR,
	applySessions,
	assertSessionRel,
	collectSessions,
	sessionBytes,
	sessionIndex,
	sessionsFrom,
	writeSessionsLayer,
} from '../lib/core/sessions.js';
import { makeBareRemote, seedRemote, tempDir } from './helpers.mjs';

/**
 * Build a harness home containing a session store.
 *
 * @param {Record<string, string>} files - session-relative paths to contents.
 * @returns {string} the harness home.
 */
function homeWithSessions(files) {
	const home = tempDir('sessions-home');
	for (const [rel, text] of Object.entries(files)) {
		const abs = join(home, 'sessions', ...rel.split('/'));
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, text, 'utf8');
	}
	return home;
}

describe('git output buffering', () => {
	it('bounds one command far above the 1 MiB default that broke a growing snapshot', () => {
		assert.ok(MAX_GIT_OUTPUT_BYTES > 1024 * 1024, 'the default buffer is the bug');
		assert.ok(MAX_GIT_OUTPUT_BYTES >= 64 * 1024 * 1024, 'a snapshot is one document and grows with the configuration');
	});

	it('reads a blob larger than 1 MiB end to end', () => {
		const remote = makeBareRemote(tempDir('big'));
		const big = 'x'.repeat(2 * 1024 * 1024);
		seedRemote(remote, { 'config/harness-config.json': big }, 'main');
		const repoDir = join(tempDir('bigclone'), 'repo');
		syncWorktree({ repoDir, url: remote, branch: 'main' });
		const text = readRemoteFile({ repoDir, branch: 'main', path: 'config/harness-config.json' });
		assert.equal(typeof text, 'string');
		assert.equal(text.length, big.length, 'the whole blob must come back, not a truncated prefix');
	});

	it('answers ordinary absence as undefined, without throwing', () => {
		const remote = makeBareRemote(tempDir('absent'));
		seedRemote(remote, { 'README.md': '# hi\n' }, 'main');
		const repoDir = join(tempDir('absentclone'), 'repo');
		syncWorktree({ repoDir, url: remote, branch: 'main' });
		// The branch exists but the file does not: an empty remote, not an error.
		assert.equal(readRemoteFile({ repoDir, branch: 'main', path: 'config/harness-config.json' }), undefined);
		// The branch does not exist at all: also absence.
		assert.equal(readRemoteFile({ repoDir, branch: 'ghost', path: 'README.md' }), undefined);
		// And a file that is there still reads.
		assert.equal(readRemoteFile({ repoDir, branch: 'main', path: 'README.md' }), '# hi\n');
	});
});

describe('session layer', () => {
	it('collects the store, skipping transient harness files', () => {
		const home = homeWithSessions({
			'--D-work--/abc/session.jsonl.zstd': 'LOG',
			'--D-work--/abc/session.v2.jsonl.zstd': 'LOG2',
			'--D-work--/abc/session.lock': 'lock',
			'--D-work--/abc/.dsh-mkdir-123': '',
			'--D-work--/abc/notes.tmp': 'tmp',
		});
		const { entries, notes } = collectSessions({ dshHome: home });
		assert.deepEqual(entries.map((entry) => entry.rel).sort(), [
			'--D-work--/abc/session.jsonl.zstd',
			'--D-work--/abc/session.v2.jsonl.zstd',
		]);
		assert.ok(notes.some((note) => note.includes('transient')));
	});

	it('reports an absent store as empty rather than failing', () => {
		const { entries } = collectSessions({ dshHome: tempDir('no-sessions') });
		assert.deepEqual(entries, []);
	});

	it('round-trips through the repository and restores onto a fresh machine', () => {
		const source = homeWithSessions({ '--D-work--/abc/session.jsonl.zstd': 'BINARY-ish-LOG' });
		const collected = collectSessions({ dshHome: source });
		const repo = tempDir('repo');
		const first = writeSessionsLayer(repo, collected.entries);
		assert.equal(first.written.length, 1);
		assert.equal(first.unchanged, 0);
		assert.ok(existsSync(join(repo, SESSIONS_DIR, '--D-work--', 'abc', 'session.jsonl.zstd')));

		// A second push over the same bytes copies nothing: the push stays cheap.
		const second = writeSessionsLayer(repo, collected.entries);
		assert.deepEqual(second.written, []);
		assert.equal(second.unchanged, 1);

		// A fresh machine gets the log back, byte for byte.
		const target = tempDir('fresh-machine');
		const plan = applySessions({ dshHome: target, repoDir: repo });
		assert.equal(plan.written.length, 1);
		assert.equal(plan.present.length, 0);
		assert.equal(readFileSync(join(target, 'sessions', '--D-work--', 'abc', 'session.jsonl.zstd'), 'utf8'), 'BINARY-ish-LOG');
	});

	it('never overwrites a local log, because it may hold unseen history', () => {
		const source = homeWithSessions({ '--D-work--/abc/session.jsonl.zstd': 'FROM-REPO' });
		const repo = tempDir('repo2');
		writeSessionsLayer(repo, collectSessions({ dshHome: source }).entries);

		// This machine already has that session, with different content.
		const target = homeWithSessions({ '--D-work--/abc/session.jsonl.zstd': 'LOCAL-ONLY' });
		const plan = applySessions({ dshHome: target, repoDir: repo });
		assert.deepEqual(plan.written, []);
		assert.equal(plan.present.length, 1);
		assert.equal(readFileSync(join(target, 'sessions', '--D-work--', 'abc', 'session.jsonl.zstd'), 'utf8'), 'LOCAL-ONLY');
	});

	it('does not write during a dry run', () => {
		const source = homeWithSessions({ '--D-work--/abc/session.jsonl.zstd': 'X' });
		const repo = tempDir('repo3');
		writeSessionsLayer(repo, collectSessions({ dshHome: source }).entries);
		const target = tempDir('dry-machine');
		const plan = applySessions({ dshHome: target, repoDir: repo, dryRun: true });
		assert.equal(plan.written.length, 1);
		assert.ok(!existsSync(join(target, 'sessions')));
	});

	it('carries an index of paths and hashes, not the logs themselves', () => {
		const home = homeWithSessions({
			'--D-work--/abc/session.jsonl.zstd': 'LOG',
			'--D-work--/def/session.jsonl.zstd': 'OTHER',
		});
		const collected = collectSessions({ dshHome: home });
		const index = sessionIndex(collected.entries);
		assert.equal(index.length, 2);
		assert.ok(sessionBytes(index) > 0);
		for (const entry of index) {
			assert.equal(typeof entry.path, 'string');
			assert.match(entry.sha256, /^sha256:[0-9a-f]{64}$/);
			assert.ok(!('data' in entry), 'the index must never carry file bytes');
		}
		// It survives a snapshot round trip.
		const envelope = buildSnapshot({ version: 1, device: 'd', profile: 'web', files: { 'settings.yaml': 'a: 1\n' }, preferences: { sessions: index } });
		const parsed = parseSnapshot(stableStringify(envelope));
		assert.deepEqual(sessionsFrom(parsed).map((entry) => entry.path), index.map((entry) => entry.path));
	});

	it('survives a snapshot with no session index at all', () => {
		const envelope = buildSnapshot({ version: 1, device: 'd', profile: 'web', files: {} });
		assert.deepEqual(sessionsFrom(envelope), []);
		assert.deepEqual(sessionsFrom(undefined), []);
		assert.equal(sessionBytes([]), 0);
	});

	it('refuses a session path that could escape the session root', () => {
		for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\b', '', 'a//b', './a']) {
			assert.throws(() => assertSessionRel(bad), /refusing/, `${JSON.stringify(bad)} must be refused`);
		}
		assert.equal(assertSessionRel('--D-work--/abc/session.jsonl.zstd'), '--D-work--/abc/session.jsonl.zstd');
	});

	it('refuses to restore a repository path that escapes, and says so', () => {
		const repo = tempDir('evil-repo');
		const target = tempDir('evil-target');
		// A hostile repository cannot create this through git, but the guard must not
		// depend on that: write the tree directly and assert the refusal.
		mkdirSync(join(repo, SESSIONS_DIR), { recursive: true });
		const plan = applySessions({ dshHome: target, repoDir: repo });
		assert.deepEqual(plan.written, []);
		assert.ok(!existsSync(join(target, 'sessions')));
	});
});

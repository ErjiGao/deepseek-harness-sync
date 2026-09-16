/**
 * The workspace layer.
 *
 * The assertions that matter most here are the negative ones. A workspace is
 * arbitrary user data, so the failure mode to guard against is not "it missed a
 * file" — that is recoverable — but "it captured a credential and pushed it to a
 * Git remote". Most of this file is therefore about what must NOT be collected.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
	ALLOWED_PATTERNS, DENIED_EXTENSIONS, DENIED_NAMES, SKIP_DIRS, WORKSPACE_PREFIX,
	assertWorkspacePath, collectWorkspace, couldContainAllowed, isAllowed, isDeniedName,
	readRepoInfo, readWorkspaceConfig, renderCloneScript,
} from '../lib/core/workspace.js';

/**
 * Build a throwaway workspace and run `body` against it.
 * @param {(root: string) => void} body - the test body.
 */
function withWorkspace(body) {
	const root = mkdtempSync(join(tmpdir(), 'harness-sync-ws-'));
	try {
		body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * Write a file, creating parent directories.
 * @param {string} root - the workspace root.
 * @param {string} rel - workspace-relative POSIX path.
 * @param {string} text - the content.
 */
function put(root, rel, text) {
	const abs = join(root, ...rel.split('/'));
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, text, 'utf8');
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------
test('the workspace allowlist covers the harness config and plain notes', () => {
	assert.equal(isAllowed('.dsh/config.toml'), true);
	assert.equal(isAllowed('.dsh/skills/mine/SKILL.md'), true);
	assert.equal(isAllowed('AGENTS.md'), true);
	assert.equal(isAllowed('README.md'), true);
	assert.equal(isAllowed('NOTES.md'), true);
	assert.equal(isAllowed('.editorconfig'), true);
	assert.equal(WORKSPACE_PREFIX, 'workspace');
	assert.ok(ALLOWED_PATTERNS.includes('.dsh/**'), 'the workspace harness config is allowlisted');
});

test('the workspace allowlist excludes everything not named', () => {
	// Research data, build output and arbitrary files must all be off by default.
	for (const rel of [
		'water_density/data.csv',
		'water_density/run/LOG',
		'src/main.py',
		'output/figure.png',
		'data/results.json',
		'notes_backup.tar.gz',
	]) {
		assert.equal(isAllowed(rel), false, `${rel} must not be allowed`);
	}
});

test('a deny rule beats an allow rule, at any depth', () => {
	// The whole point: `notes/**` would match these, and must not.
	assert.equal(isAllowed('notes/.env'), false);
	assert.equal(isAllowed('notes/.env.local'), false);
	assert.equal(isAllowed('.dsh/.env'), false, 'even inside the harness config directory');
	assert.equal(isAllowed('.dsh/credentials.json'), false);
	assert.equal(isAllowed('.dsh/id_rsa'), false);
	assert.equal(isAllowed('.dsh/secrets'), false);
	assert.equal(isAllowed('notes/server.key'), false);
	assert.equal(isAllowed('notes/cert.pem'), false);
	assert.equal(isAllowed('notes/vault.kdbx'), false);
	assert.equal(isAllowed('notes/backup.age'), false);
	assert.equal(isAllowed('notes/.npmrc'), false);
	assert.equal(isAllowed('notes/.git-credentials'), false);
});

test('a sensitive DIRECTORY name stops the walk even when the file inside looks innocent', () => {
	assert.equal(isAllowed('secrets/notes.md'), false, 'a directory called secrets/ must not be walked');
	assert.equal(isAllowed('credentials/readme.md'), false);
	assert.equal(isAllowed('.dsh/tokens/list.md'), false);
});

test('deny matching is case-insensitive', () => {
	assert.equal(isAllowed('notes/.ENV'), false);
	assert.equal(isAllowed('notes/Secrets/notes.md'), false);
	assert.equal(isAllowed('notes/ID_RSA'), false);
});

test('traversal and absolute forms are refused', () => {
	for (const rel of ['../settings.yaml', 'notes/../../etc/passwd', '/etc/passwd', 'C:/windows/win.ini', 'notes\\file.md', '.dsh/./x', 'notes//x']) {
		assert.equal(isAllowed(rel), false, `${rel} must be refused`);
		assert.throws(() => assertWorkspacePath(rel), /refusing/, `${rel} must throw`);
	}
	assert.equal(isAllowed(''), false);
	assert.equal(isAllowed('notes/\0x'), false);
});

test('the deny sets are documented and non-empty', () => {
	assert.ok(DENIED_NAMES.size > 10);
	assert.ok(DENIED_EXTENSIONS.size > 5);
	assert.ok(SKIP_DIRS.has('node_modules') && SKIP_DIRS.has('.git'));
	assert.equal(isDeniedName('node_modules'), false, 'skip dirs are handled separately from the sensitive list');
});

test('couldContainAllowed prunes data directories but not config ones', () => {
	assert.equal(couldContainAllowed('water_density'), false, 'a data directory is pruned when repositories are off');
	assert.equal(couldContainAllowed('src'), false);
	assert.equal(couldContainAllowed('.dsh'), true);
	assert.equal(couldContainAllowed('.dsh/skills'), true, 'inside an allowed prefix');
	assert.equal(couldContainAllowed(''), true);
	assert.equal(couldContainAllowed('notes', ['notes']), true, 'a user include makes it reachable');
	// A repository is discoverable only by looking, so with repository discovery on
	// every directory is reachable. `nested/project` is a repository that no
	// allowlist mentions, and pruning its parent would lose it.
	assert.equal(couldContainAllowed('water_density', [], true), true, 'repository discovery keeps directories reachable');
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------
test('collect captures the workspace config and skips everything else', () => {
	withWorkspace((root) => {
		put(root, '.dsh/config.toml', 'theme = "dark"\n');
		put(root, '.dsh/skills/mine/SKILL.md', '# mine\n');
		put(root, 'AGENTS.md', '# baseline\n');
		put(root, 'README.md', '# workspace\n');
		put(root, 'water_density/data.csv', 'x,y\n1,2\n');
		put(root, 'src/main.py', 'print(1)\n');
		put(root, 'node_modules/pkg/index.js', 'module.exports={}\n');

		const result = collectWorkspace({ workspace: root });
		assert.deepEqual(Object.keys(result.files).sort(), [
			'.dsh/config.toml', '.dsh/skills/mine/SKILL.md', 'AGENTS.md', 'README.md',
		]);
		assert.equal(result.files['AGENTS.md'], '# baseline\n', 'content is verbatim');
		assert.equal('water_density/data.csv' in result.files, false);
		assert.equal('src/main.py' in result.files, false);
		assert.equal('node_modules/pkg/index.js' in result.files, false);
	});
});

test('collect still refuses a credential that an allow pattern would otherwise match', () => {
	withWorkspace((root) => {
		put(root, '.dsh/config.toml', 'ok\n');
		// `.dsh/**` matches all of these. None may be collected.
		put(root, '.dsh/.env', 'OPENAI_API_KEY=sk-REALVALUE\n');
		put(root, '.dsh/credentials.json', '{"token":"x"}\n');
		put(root, '.dsh/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\n');
		const result = collectWorkspace({ workspace: root });
		assert.deepEqual(Object.keys(result.files), ['.dsh/config.toml']);
		const blob = JSON.stringify(result.files);
		assert.equal(blob.includes('sk-REALVALUE'), false, 'no credential value may appear anywhere in a collection');
		assert.equal(blob.includes('OPENSSH PRIVATE KEY'), false);
		// Every refusal is reported, and the note says why. Assert on the word that
		// both refusal sites share, so a rewording of one of them cannot make this
		// pass by accident — it failed exactly that way once: `.env` said "sensitive
		// name" while `credentials.json` said "sensitive list", and a regex for the
		// shorter phrase matched only because the first file happened to be listed
		// first.
		const refusals = result.notes.filter((note) => /sensitive/.test(note));
		assert.equal(refusals.length, 3, `all three refusals must be reported, got ${JSON.stringify(result.notes)}`);
		for (const rel of ['.dsh/.env', '.dsh/credentials.json', '.dsh/id_rsa']) {
			assert.ok(refusals.some((note) => note.startsWith(`${rel}:`)), `${rel} must be named in a refusal note`);
		}
		assert.equal(result.notes.some((note) => /sk-REALVALUE/.test(note)), false, 'a refusal must never echo the value');
	});
});

test('a large file is skipped rather than shipped', () => {
	withWorkspace((root) => {
		put(root, 'AGENTS.md', 'small\n');
		// 2 MiB, over the 1 MiB ceiling.
		put(root, 'NOTES.md', 'x'.repeat(2 * 1024 * 1024));
		const result = collectWorkspace({ workspace: root });
		assert.equal('NOTES.md' in result.files, false);
		assert.ok(result.notes.some((note) => /exceeds the/.test(note)));
	});
});

test('a binary file is skipped', () => {
	withWorkspace((root) => {
		const abs = join(root, 'NOTES.md');
		mkdirSync(root, { recursive: true });
		writeFileSync(abs, Buffer.from([0x00, 0x01, 0x02, 0x03]));
		const result = collectWorkspace({ workspace: root });
		assert.equal('NOTES.md' in result.files, false);
		assert.ok(result.notes.some((note) => /binary/.test(note)));
	});
});

test('a missing workspace is reported, not thrown', () => {
	const result = collectWorkspace({ workspace: join(tmpdir(), 'definitely-not-here-4f9a2b') });
	assert.deepEqual(result.files, {});
	assert.deepEqual(result.repositories, []);
	assert.ok(result.notes.some((note) => /does not exist/.test(note)));
});

// ---------------------------------------------------------------------------
// User configuration
// ---------------------------------------------------------------------------
test('workspace.sync.json can widen the allowlist, and the deny-list still wins', () => {
	withWorkspace((root) => {
		put(root, '.dsh/sync.json', JSON.stringify({ include: ['src', 'notes/keep.md'], exclude: ['src/vendor'] }));
		put(root, 'src/main.py', 'print(1)\n');
		put(root, 'src/vendor/lib.py', 'x\n');
		put(root, 'notes/keep.md', 'kept\n');
		put(root, 'notes/other.md', 'not kept\n');
		put(root, 'src/.env', 'SECRET=1\n');
		const result = collectWorkspace({ workspace: root });
		assert.equal('src/main.py' in result.files, true, 'an include prefix is honoured');
		assert.equal('notes/keep.md' in result.files, true, 'a single-file include is honoured');
		assert.equal('src/vendor/lib.py' in result.files, false, 'an exclude prefix is honoured');
		assert.equal('notes/other.md' in result.files, false, 'outside both allowlist and includes');
		assert.equal('src/.env' in result.files, false, 'an include does not override the deny-list');
	});
});

test('a malformed workspace.sync.json falls back to the safe defaults', () => {
	withWorkspace((root) => {
		put(root, '.dsh/sync.json', '{ this is not json');
		put(root, 'src/main.py', 'x\n');
		const config = readWorkspaceConfig(root);
		assert.deepEqual(config.include, [], 'a broken config must not widen what is synced');
		assert.deepEqual(config.exclude, []);
		assert.equal(config.repositories, true);
		const result = collectWorkspace({ workspace: root });
		assert.equal('src/main.py' in result.files, false);
	});
});

test('readWorkspaceConfig reports its defaults when no config exists', () => {
	withWorkspace((root) => {
		assert.deepEqual(readWorkspaceConfig(root), { include: [], exclude: [], repositories: true });
	});
});

// ---------------------------------------------------------------------------
// Repositories are recorded, not copied
// ---------------------------------------------------------------------------
test('a git repository is recorded as a reference and its files are not captured', () => {
	withWorkspace((root) => {
		const repo = join(root, 'my-plugin');
		mkdirSync(repo, { recursive: true });
		execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/my-plugin.git'], { cwd: repo, stdio: 'ignore' });
		writeFileSync(join(repo, 'README.md'), '# plugin\n');
		writeFileSync(join(repo, 'secret.key'), 'nope\n');

		const result = collectWorkspace({ workspace: root });
		assert.equal(result.repositories.length, 1);
		assert.equal(result.repositories[0].path, 'my-plugin');
		assert.equal(result.repositories[0].remote, 'https://github.com/example/my-plugin.git');
		assert.equal(result.repositories[0].branch, 'main');
		assert.equal('my-plugin/README.md' in result.files, false, 'repository content is not copied');
		assert.equal('my-plugin/secret.key' in result.files, false);
		assert.equal(JSON.stringify(result.files).includes('nope'), false);
	});
});

test('a repository with no origin is recorded but flagged as not reproducible', () => {
	withWorkspace((root) => {
		const repo = join(root, 'local-only');
		mkdirSync(repo, { recursive: true });
		execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
		const result = collectWorkspace({ workspace: root });
		assert.equal(result.repositories.length, 1);
		assert.equal(result.repositories[0].remote, undefined);
		assert.ok(result.notes.some((note) => /no "origin" remote/.test(note)), 'the limitation is stated');
	});
});

test('readRepoInfo reads what git wrote, without spawning git', () => {
	withWorkspace((root) => {
		const repo = join(root, 'r');
		mkdirSync(repo, { recursive: true });
		execFileSync('git', ['init', '-b', 'trunk'], { cwd: repo, stdio: 'ignore' });
		execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/r.git'], { cwd: repo, stdio: 'ignore' });
		const info = readRepoInfo(repo);
		assert.equal(info.remote, 'https://example.invalid/r.git');
		assert.equal(info.branch, 'trunk');
	});
	assert.deepEqual(readRepoInfo(tmpdir()), {}, 'a non-repository yields nothing rather than throwing');
});

test('nested repositories are each recorded at their own path', () => {
	withWorkspace((root) => {
		for (const name of ['a', 'nested/b']) {
			const repo = join(root, ...name.split('/'));
			mkdirSync(repo, { recursive: true });
			execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
			execFileSync('git', ['remote', 'add', 'origin', `https://example.invalid/${name.replace('/', '-')}.git`], { cwd: repo, stdio: 'ignore' });
		}
		const result = collectWorkspace({ workspace: root });
		assert.deepEqual(result.repositories.map((r) => r.path).sort(), ['a', 'nested/b']);
	});
});

// ---------------------------------------------------------------------------
// The clone script
// ---------------------------------------------------------------------------
test('the clone script clones by URL, skips what exists, and never executes anything', () => {
	const script = renderCloneScript([
		{ path: 'my-plugin', remote: 'https://github.com/example/my-plugin.git', branch: 'main', head: 'abcdef1234567890' },
		{ path: 'local-only' },
	]);
	assert.ok(script.startsWith('#!/bin/sh'), 'it is a shell script');
	assert.ok(script.includes("git clone --branch main 'https://github.com/example/my-plugin.git' 'my-plugin'"));
	assert.ok(script.includes('if [ -e'), 'it checks before cloning');
	assert.ok(script.includes('NOT REPRODUCIBLE: local-only'), 'the uncapturable repo is called out');
	assert.ok(script.includes('# it was at abcdef123456'), 'the recorded commit is noted');
	assert.equal(script.includes('rm -rf'), false, 'a restore script must never delete');
});

test('the clone script quotes awkward paths safely', () => {
	const script = renderCloneScript([{ path: "wei'rd dir", remote: 'https://example.invalid/x.git', branch: 'main' }]);
	// The single quote must be escaped, not left to break out of the quoting.
	assert.ok(script.includes(`'wei'\\''rd dir'`), 'a single quote in a path is escaped');
});

test('the clone script handles an empty repository list', () => {
	const script = renderCloneScript([]);
	assert.ok(script.includes('No repositories were recorded'));
	assert.ok(script.startsWith('#!/bin/sh'));
});

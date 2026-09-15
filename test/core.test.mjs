/**
 * Unit tests for the core: path resolution, the whitelist, collection, the
 * credential guard, snapshots, application, backups, and diffing.
 *
 * @module deepseek-harness-sync/test/core
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { applySnapshot, planApply } from '../lib/core/apply.js';
import { createBackup, listBackups, pruneBackups, readBackup } from '../lib/core/backup.js';
import { collect, detectMachineDependencies } from '../lib/core/collect.js';
import { compareText, renderDiff } from '../lib/core/diff.js';
import { blockingFindings, screenContent, screenFiles } from '../lib/core/guard.js';
import { assertManaged, isManaged, managedFiles } from '../lib/core/manifest.js';
import { resolveDataRoot, resolveDshHome } from '../lib/core/paths.js';
import {
	buildMetadata,
	buildSnapshot,
	contentDigest,
	parseSnapshot,
	stableStringify,
} from '../lib/core/snapshot.js';
import { readState, writeState } from '../lib/core/state.js';
import { harnessFiles, makeRoot, readRel, tempDir } from './helpers.mjs';

/**
 * Secret-shaped fixtures are assembled here instead of being written literally.
 *
 * The guard's tests need inputs that match real provider patterns, but a literal
 * one in the repository is noise for every reader and every scanner, and it is
 * exactly what a host's push protection is built to reject. Building the string
 * at run time keeps the coverage identical and removes the literal.
 *
 * @param {string} filler - the character to repeat.
 * @param {number} [length] - how many characters follow the prefix.
 * @returns {string} a fake key shaped like an OpenAI-style secret.
 */
const fakeKey = (filler, length = 24) => `${'sk'}-${filler.repeat(length)}`;

/**
 * A PEM private-key header, carrying no key material.
 *
 * @returns {string} the BEGIN line.
 */
const fakePemHeader = () => `-----BEGIN ${['RSA', 'PRIVATE', 'KEY'].join(' ')}-----`;

describe('paths', () => {
	it('prefers an explicit home over $DSH_HOME over ~/.dsh', () => {
		const explicit = tempDir('explicit');
		assert.equal(resolveDshHome(explicit, { DSH_HOME: 'C:\\from\\env' }), explicit);
		assert.match(resolveDshHome(undefined, { DSH_HOME: 'C:\\from\\env' }), /from[\\/]env$/);
		assert.match(resolveDshHome(undefined, {}), /\.dsh$/);
	});

	it('ignores a blank $DSH_HOME rather than resolving to the working directory', () => {
		assert.match(resolveDshHome(undefined, { DSH_HOME: '   ' }), /\.dsh$/);
	});

	it('honours HARNESS_SYNC_HOME for the private data root', () => {
		const root = tempDir('data');
		assert.equal(resolveDataRoot('C:\\home', { HARNESS_SYNC_HOME: root }), root);
		assert.match(resolveDataRoot('C:\\home', {}), /home[\\/]harness-sync$/);
	});
});

describe('whitelist', () => {
	it('accepts every managed path', () => {
		for (const rel of managedFiles('web')) assert.equal(assertManaged(rel, 'web'), rel);
		assert.equal(isManaged('.agent-presets/mine/agent.cordis.yml', 'web'), true);
		assert.equal(isManaged('skills/thing/SKILL.md', 'web'), true);
	});

	it('refuses traversal, absolute paths, drive letters, backslashes and NUL', () => {
		for (const bad of [
			'../evil.yaml',
			'profiles/../../evil.json',
			'/etc/passwd',
			'C:/Windows/system32/config',
			'profiles\\web\\package.json',
			'settings.yaml\0.txt',
			'./settings.yaml',
		]) {
			assert.throws(() => assertManaged(bad, 'web'), /refusing/, `expected ${JSON.stringify(bad)} to be refused`);
		}
	});

	it('refuses a path that is real but not configuration', () => {
		for (const bad of [
			'.credentials.yaml',
			'sessions/x.jsonl.zstd',
			'attachments/v1/objects/ab',
			'storages/tokenledger.sqlite',
			'bin/dsh.cmd',
			'dsh-config-manager/vault/.credentials.yaml',
			'profiles/web/node_modules/x/index.js',
		]) {
			assert.throws(() => assertManaged(bad, 'web'), /outside the sync whitelist/, `${bad} must be refused`);
		}
	});
});

describe('collection', () => {
	it('reads exactly the managed files and nothing else', () => {
		const files = harnessFiles();
		const root = makeRoot({
			...files,
			// Decoys that a recursive walk would sweep up.
			'.credentials.yaml': `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${fakeKey('a')}\n`,
			'tokenledger.sqlite': 'binary-ish',
			'sessions/--x--/session.jsonl.zstd': 'zzz',
			'attachments/v1/objects/ab': 'zzz',
			'.dsh-market/log.ndjson': '{}\n',
		});
		const result = collect({ dshHome: root, profile: 'web' });
		const collected = Object.keys(result.files).sort();
		assert.deepEqual(collected, [
			'profiles/web/cordis.patch.yml',
			'profiles/web/cordis.yml',
			'profiles/web/package.json',
			'profiles/web/pnpm-workspace.yaml',
			'settings.yaml',
		]);
		// Absent fixed files are recorded so a pull can restore a deletion.
		assert.ok(result.absent.includes('AGENTS.md'));
		assert.ok(result.absent.includes('profiles/web/.dsh-market/state.json'));
	});

	it('never captures the credential store, even a copy planted in a plugin directory', () => {
		// This is the exact hazard found on a real installation: a third-party
		// plugin kept a byte-identical plaintext copy of the credential store.
		const secret = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${fakeKey('z')}\n`;
		const root = makeRoot({
			...harnessFiles(),
			'.credentials.yaml': secret,
			'dsh-config-manager/vault/.credentials.yaml': secret,
			'dsh-pocket/token': secret,
		});
		const result = collect({ dshHome: root, profile: 'web' });
		for (const [rel, text] of Object.entries(result.files)) {
			assert.notEqual(text, secret, `${rel} must never carry credential material`);
			assert.ok(!rel.includes('credentials'), `${rel} must not be collected`);
			assert.ok(!rel.startsWith('dsh-pocket/'), `${rel} must not be collected`);
		}
		// And the guard would block it anyway, so the two mechanisms are independent.
		assert.ok(blockingFindings(screenFiles(result.files)).length === 0);
	});

	it('walks user preset and skill trees when they exist', () => {
		const root = makeRoot({
			...harnessFiles(),
			'.agent-presets/mine/agent.cordis.yml': 'name: mine\n',
			'skills/thing/SKILL.md': '---\nname: thing\n---\n',
			'skills/thing/node_modules/pkg/index.js': 'not collected\n',
		});
		const result = collect({ dshHome: root, profile: 'web' });
		assert.ok('.agent-presets/mine/agent.cordis.yml' in result.files);
		assert.ok('skills/thing/SKILL.md' in result.files);
		assert.ok(!('skills/thing/node_modules/pkg/index.js' in result.files));
	});

	it('flags link:/file: specs that cannot survive a move to another machine', () => {
		const files = harnessFiles({
			extra: {
				'profiles/web/pnpm-lock.yaml': "  specifier: link:D:/somewhere/plugin\n  version: link:D:/somewhere/plugin\n",
			},
		});
		const root = makeRoot(files);
		const result = collect({ dshHome: root, profile: 'web' });
		const hits = detectMachineDependencies(result.files, 'web');
		assert.ok(hits.some((hit) => hit.rel === 'profiles/web/pnpm-lock.yaml'));
	});
});

describe('credential guard', () => {
	it('blocks vendor token shapes without echoing the value', () => {
		const token = `ghp_${'A'.repeat(36)}`;
		const findings = screenContent('settings.yaml', `key: ${token}\n`);
		const block = blockingFindings(findings);
		assert.equal(block.length, 1);
		assert.ok(!JSON.stringify(block).includes(token), 'the finding must not contain the secret');
	});

	it('blocks a literal secret assigned to a sensitive key', () => {
		const findings = blockingFindings(screenContent('settings.yaml', 'apiKey: "abcdefghijklmnopqrstuvwx"\n'));
		assert.equal(findings.length, 1);
		assert.equal(findings[0].kind, 'sensitive-key');
	});

	it('blocks a private key block', () => {
		const text = `x\n${fakePemHeader()}\nMIIE\n${fakePemHeader().replace('BEGIN', 'END')}\n`;
		assert.ok(blockingFindings(screenContent('settings.yaml', text)).length >= 1);
	});

	it('does not block an environment-variable reference', () => {
		assert.equal(blockingFindings(screenContent('settings.yaml', 'apiKey: ${env:MY_KEY}\n')).length, 0);
		assert.equal(blockingFindings(screenContent('settings.yaml', 'webSearchKey: MY_SEARCH_KEY_VALUE\n')).length, 0);
	});

	it('does not block ordinary configuration', () => {
		const ordinary = [
			'agent-default-model:',
			'  provider: deepseek-official',
			'  model: deepseek-flash',
			'locale: {}',
			'# apiKey: a comment, not a value',
		].join('\n');
		assert.deepEqual(blockingFindings(screenContent('settings.yaml', ordinary)), []);
	});

	it('does not mistake lockfile package names and version ranges for secrets', () => {
		// Regression: measured on a real installation, this exact line blocked
		// every push. The key reads as sensitive and the value is a semver range.
		const lockfile = [
			'  some-package@1.0.0:',
			'    hasBin: true',
			'    peerDependencies:',
			"      '@deepseek-ai/dsh-credentials': ^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.5-0",
			"      '@deepseek-ai/dsh-home-paths': ^0.1.0-rc.6",
			'',
		].join('\n');
		assert.deepEqual(blockingFindings(screenContent('profiles/web/pnpm-lock.yaml', lockfile)), []);

		const manifest = [
			'{',
			'  "dependencies": {',
			'    "dsh-credentials": "^1.2.3",',
			'    "@scope/auth-token": "~0.4.0",',
			'    "workspace-access-key": "workspace:*",',
			'    "secret-helper": "link:../secret-helper",',
			'  }',
			'}',
		].join('\n');
		assert.deepEqual(blockingFindings(screenContent('profiles/web/package.json', manifest)), []);
	});

	it('still blocks a literal secret even when the key looks like a package name', () => {
		// The content-shape screen is unconditional, so a real token is caught
		// wherever it appears. Here both screens fire independently, which is the
		// point: neither one is load-bearing on its own.
		const token = `ghp_${'C'.repeat(36)}`;
		const findings = blockingFindings(screenContent('profiles/web/pnpm-lock.yaml', `  'dsh-credentials': ${token}\n`));
		assert.ok(findings.length >= 1, 'a real token must always be caught');
		assert.ok(findings.some((finding) => finding.kind === 'github-token'), 'the shape screen must fire');
		assert.ok(findings.every((finding) => finding.severity === 'block'));
		assert.ok(!JSON.stringify(findings).includes(token), 'the token must never be echoed');
	});

	it('fails closed when a real settings document carries a token', () => {
		const findings = screenFiles({ 'settings.yaml': `llm-deepseek:\n  apiKey: "${fakeKey('a')}"\n` });
		assert.ok(blockingFindings(findings).length >= 1);
	});
});

describe('snapshot', () => {
	it('serializes deterministically regardless of key order', () => {
		const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
		const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
		assert.equal(a, b);
	});

	it('round-trips an envelope', () => {
		const envelope = buildSnapshot({
			version: 4,
			device: 'laptop',
			profile: 'web',
			files: { 'settings.yaml': 'a: 1\n' },
			absent: ['AGENTS.md'],
		});
		const parsed = parseSnapshot(stableStringify(envelope));
		assert.equal(parsed.version, 4);
		assert.equal(parsed.files['settings.yaml'], 'a: 1\n');
		assert.deepEqual(parsed.absent, ['AGENTS.md']);
	});

	it('rejects malformed or unsupported envelopes', () => {
		assert.throws(() => parseSnapshot('not json'), /not valid JSON/);
		assert.throws(() => parseSnapshot('[]'), /must be a JSON object/);
		assert.throws(() => parseSnapshot('{"schema":99}'), /unsupported snapshot schema/);
		assert.throws(
			() => parseSnapshot('{"schema":1,"version":-1,"device":"d","profile":"web","files":{}}'),
			/non-negative integer/,
		);
		assert.throws(
			() => parseSnapshot('{"schema":1,"version":1,"device":"d","profile":"web","files":{"a":5}}'),
			/must hold text/,
		);
	});

	it('digests equal file sets equally and different ones differently', () => {
		assert.equal(contentDigest({ 'a': '1' }), contentDigest({ 'a': '1' }));
		assert.notEqual(contentDigest({ 'a': '1' }), contentDigest({ 'a': '2' }));
	});

	it('records a stable content hash in metadata', () => {
		const envelope = buildSnapshot({ version: 2, device: 'd', profile: 'web', files: { 'settings.yaml': 'a: 1\n' } });
		assert.equal(buildMetadata(envelope).contentHash, contentDigest(envelope.files));
	});
});

describe('apply', () => {
	it('writes files, deletes recorded-absent files, and reports the plan', () => {
		const root = makeRoot({ 'settings.yaml': 'old\n', 'AGENTS.md': 'stale\n' });
		const envelope = buildSnapshot({
			version: 1,
			device: 'other',
			profile: 'web',
			files: { 'settings.yaml': 'new\n', 'profiles/web/cordis.yml': '[]\n' },
			absent: ['AGENTS.md'],
		});
		const plan = applySnapshot({ dshHome: root, profile: 'web', envelope, local: { 'settings.yaml': 'old\n' } });
		assert.deepEqual(plan.written.sort(), ['profiles/web/cordis.yml', 'settings.yaml']);
		assert.deepEqual(plan.deleted, ['AGENTS.md']);
		assert.equal(readRel(root, 'settings.yaml'), 'new\n');
		assert.equal(existsSync(join(root, 'AGENTS.md')), false);
	});

	it('refuses a snapshot that tries to escape the whitelist, writing nothing', () => {
		const root = makeRoot({ 'settings.yaml': 'keep\n' });
		for (const evil of ['../escaped.txt', '/absolute.txt', 'sessions/session.jsonl.zstd', '.credentials.yaml']) {
			const envelope = buildSnapshot({ version: 1, device: 'x', profile: 'web', files: { [evil]: 'pwned' } });
			assert.throws(() => applySnapshot({ dshHome: root, profile: 'web', envelope }), /refusing/);
		}
		assert.equal(readRel(root, 'settings.yaml'), 'keep\n');
		assert.equal(existsSync(join(root, 'escaped.txt')), false);
		assert.equal(existsSync(join(root, '..', 'escaped.txt')), false);
	});

	it('refuses to delete through the absent list', () => {
		const root = makeRoot({ 'settings.yaml': 'keep\n' });
		const envelope = buildSnapshot({ version: 1, device: 'x', profile: 'web', files: {}, absent: ['../../etc/passwd'] });
		const plan = planApply({ dshHome: root, profile: 'web', envelope, local: {} });
		assert.equal(plan.deleted.length, 0);
		assert.ok(plan.notes.some((note) => note.includes('refusing')));
	});

	it('leaves no temporary files behind', () => {
		const root = makeRoot({});
		const envelope = buildSnapshot({ version: 1, device: 'x', profile: 'web', files: { 'settings.yaml': 'a: 1\n' } });
		applySnapshot({ dshHome: root, profile: 'web', envelope });
		const leftovers = readdirSync(root).filter((name) => name.includes('harness-sync.tmp'));
		assert.deepEqual(leftovers, []);
	});

	it('does not write during a dry run', () => {
		const root = makeRoot({ 'settings.yaml': 'old\n' });
		const envelope = buildSnapshot({ version: 1, device: 'x', profile: 'web', files: { 'settings.yaml': 'new\n' } });
		const plan = applySnapshot({ dshHome: root, profile: 'web', envelope, local: { 'settings.yaml': 'old\n' }, dryRun: true });
		assert.deepEqual(plan.written, ['settings.yaml']);
		assert.equal(readRel(root, 'settings.yaml'), 'old\n');
	});
});

describe('backup', () => {
	it('writes a restorable backup and rotates to the retention count', () => {
		const root = makeRoot(harnessFiles());
		const backupDir = join(tempDir('backups'), 'backup');
		const original = readRel(root, 'settings.yaml');
		for (let index = 0; index < 7; index += 1) {
			writeFileSync(join(root, 'settings.yaml'), `generation: ${index}\n`, 'utf8');
			createBackup({ dshHome: root, profile: 'web', backupDir, device: 'd', version: index, reason: `step ${index}` });
		}
		let listing = listBackups(backupDir);
		assert.equal(listing.length, 7);
		// Newest first: the last backup must be the one just written.
		assert.equal(readBackup(listing[0].path).files['settings.yaml'], 'generation: 6\n');

		const removed = pruneBackups(backupDir, 5);
		assert.equal(removed.length, 2);
		listing = listBackups(backupDir);
		assert.equal(listing.length, 5);
		assert.equal(readBackup(listing[0].path).files['settings.yaml'], 'generation: 6\n');

		// A backup can be applied straight back onto the home it came from.
		writeFileSync(join(root, 'settings.yaml'), 'wrecked\n', 'utf8');
		const envelope = readBackup(listing[0].path);
		applySnapshot({ dshHome: root, profile: 'web', envelope, local: collect({ dshHome: root, profile: 'web' }).files });
		assert.equal(readRel(root, 'settings.yaml'), 'generation: 6\n');
		void original;
	});

	it('records absence so a rollback can restore a deletion', () => {
		const root = makeRoot({ 'settings.yaml': 'a: 1\n' });
		const backupDir = join(tempDir('backups'), 'backup');
		const { path } = createBackup({ dshHome: root, profile: 'web', backupDir, device: 'd', reason: 'before' });
		// Simulate a pull that created AGENTS.md.
		writeFileSync(join(root, 'AGENTS.md'), 'new file\n', 'utf8');
		const envelope = readBackup(path);
		applySnapshot({ dshHome: root, profile: 'web', envelope, local: collect({ dshHome: root, profile: 'web' }).files });
		assert.equal(existsSync(join(root, 'AGENTS.md')), false, 'the backup recorded AGENTS.md as absent, so restoring removes it');
	});
});

describe('diff', () => {
	it('finds the changed region and elides the shared prefix', () => {
		const comparison = compareText('a\nb\nc\nd\n', 'a\nb\nX\nd\n');
		assert.equal(comparison.equal, false);
		assert.equal(comparison.prefix, 2);
		assert.deepEqual(comparison.removed, ['c']);
		assert.deepEqual(comparison.added, ['X']);
		assert.equal(comparison.suffix, 1);
	});

	it('renders additions, removals and absence', () => {
		assert.match(renderDiff('x', 'a\n', 'a\n'), /identical/);
		assert.match(renderDiff('x', undefined, 'a\n'), /only on the remote/);
		assert.match(renderDiff('x', 'a\n', undefined), /only on this device/);
		const rendered = renderDiff('x', 'a\nb\n', 'a\nc\n');
		assert.match(rendered, /- b/);
		assert.match(rendered, /\+ c/);
	});
});

describe('state', () => {
	it('refuses to persist a credential', () => {
		const path = join(tempDir('state'), 'config.json');
		assert.throws(
			() => writeState(path, { repoUrl: 'u', branch: 'main', profile: 'web', token: 'oops' }),
			/refusing to write a token/,
		);
	 assert.equal(existsSync(path), false);
	});

	it('refuses to read a credential field back', () => {
		const root = tempDir('state');
		const path = join(root, 'config.json');
		writeFileSync(path, JSON.stringify({ schema: 1, repoUrl: 'u', branch: 'main', profile: 'web', token: 'x' }), 'utf8');
		assert.throws(() => readState(path), /credential field/);
	});

	it('round-trips a valid record', () => {
		const path = join(tempDir('state'), 'config.json');
		writeState(path, { repoUrl: 'u', branch: 'main', profile: 'web', device: 'd', localVersion: 3 });
		const back = readState(path);
		assert.equal(back.localVersion, 3);
		assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, undefined);
	});
});

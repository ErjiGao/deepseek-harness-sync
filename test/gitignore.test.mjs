/**
 * Tests for folding this plugin's rules into the configuration repository's
 * `.gitignore`.
 *
 * This exists because the first attempt got it wrong in a way nothing caught: it
 * compared the existing file against the *current* template to decide whether the
 * file was ours, so an older version of our own block read as foreign and was
 * left alone forever. The rule dropping `sessions/` therefore never reached the
 * real repository, the session tree stayed ignored, and every push reported logs
 * it had silently not committed.
 *
 * @module deepseek-harness-sync/test/gitignore
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIG_REPO_GITIGNORE, GITIGNORE_BEGIN, GITIGNORE_END, mergeGitignore } from '../lib/commands/shared.js';

/**
 * A block as an earlier build would have written it: the old code only ever
 * *appended* its block, so a legacy block always sits at the end of the file and
 * carries no closing fence.
 */
const LEGACY_BLOCK = `${GITIGNORE_BEGIN}\n.credentials.yaml\nsessions/\nattachments/\n`;

/** A fenced block, which is the shape written from here on. */
const FENCED_OLD_BLOCK = `${GITIGNORE_BEGIN}\n.credentials.yaml\nsessions/\nattachments/\n${GITIGNORE_END}\n`;

describe('config-repo .gitignore', () => {
	it('writes the current block into an absent file', () => {
		const out = mergeGitignore('');
		assert.ok(out.includes(GITIGNORE_BEGIN));
		assert.ok(out.includes(GITIGNORE_END));
		assert.ok(!/^sessions\//m.test(out), 'sessions are a synced layer and must not be ignored');
	});

	it('replaces an older block of our own so a rule change reaches the repository', () => {
		for (const stale of [LEGACY_BLOCK, FENCED_OLD_BLOCK]) {
			assert.ok(/^sessions\//m.test(stale), 'the fixture must actually carry the stale rule');
			const out = mergeGitignore(stale);
			assert.ok(!/^sessions\//m.test(out), 'the stale rule must be gone after the merge');
			assert.ok(out.includes('attachments/'), 'the rest of the block is renewed too');
			assert.ok(out.includes(GITIGNORE_END));
		}
	});

	it('leaves rules written outside the fence exactly where they were', () => {
		const before = '*.tmp\nbuild/\n';
		const after = 'mine/\n';
		const out = mergeGitignore(`${before}${FENCED_OLD_BLOCK}${after}`);
		assert.ok(out.startsWith(before), 'rules before our block survive');
		assert.ok(out.trimEnd().endsWith('mine/'), 'rules after our block survive');
		assert.ok(!/^sessions\//m.test(out));
	});

	it('appends the block to a foreign file with no fence at all', () => {
		const out = mergeGitignore('*.tmp\n');
		assert.ok(out.startsWith('*.tmp\n'));
		assert.ok(out.includes(GITIGNORE_BEGIN));
		assert.ok(out.includes('*.token'));
	});

	it('recovers from a legacy block, which always sat at the end of the file', () => {
		// A pre-fence build appended its block, so anything before the opening marker
		// is someone else's and anything after it was ours to replace.
		const out = mergeGitignore(`*.tmp\n\n${LEGACY_BLOCK}`);
		assert.ok(out.startsWith('*.tmp\n'), 'the foreign rule survives');
		assert.ok(out.includes(GITIGNORE_END), 'the fence is closed again');
		assert.ok(!/^sessions\//m.test(out));
	});

	it('is idempotent, so a second push changes nothing', () => {
		for (const input of ['', LEGACY_BLOCK, FENCED_OLD_BLOCK, `*.tmp\n${FENCED_OLD_BLOCK}`, '*.tmp\n', `${GITIGNORE_BEGIN}\npartial`]) {
			const once = mergeGitignore(input);
			assert.equal(mergeGitignore(once), once, `merging twice must equal merging once for ${JSON.stringify(input.slice(0, 24))}`);
		}
		assert.equal(mergeGitignore(CONFIG_REPO_GITIGNORE), CONFIG_REPO_GITIGNORE);
	});
});

/**
 * `harness-sync sync` — pull, look at the difference, then synchronize.
 *
 * The one rule this command exists to enforce: when both sides have moved, it
 * stops and asks. It never picks a winner silently.
 *
 * @module deepseek-harness-sync/commands/sync
 */

import { choose } from './shared.js';
import { assess, classify } from './situation.js';
import { divergenceHeader, divergenceMessage } from './shared.js';
import { run as runDiff } from './diff.js';
import { run as runPull } from './pull.js';
import { run as runPush } from './push.js';

/**
 * Run `sync`.
 *
 * @param {object} ctx - the execution context.
 * @param {{dryRun?: boolean}} [options] - overrides.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx, options = {}) {
	const { ui } = ctx;
	const situation = assess(ctx);
	const verdict = classify(situation);

	if (verdict.code === 'unreachable') {
		ui.fail(verdict.message);
		if (situation.remoteFetchError !== '') ui.write(situation.remoteFetchError);
		return 1;
	}

	if (verdict.code === 'synchronized') {
		ui.ok('already synchronized; nothing to do');
		ui.kv('Version', situation.remoteVersion);
		return 0;
	}

	if (verdict.code === 'local-only' || verdict.code === 'local-ahead') {
		ui.write(`Local configuration ${verdict.code === 'local-only' ? 'has never been pushed' : 'has unpushed changes'}; pushing.`);
		return runPush(ctx, options);
	}

	if (verdict.code === 'remote-ahead') {
		ui.write('The repository is newer; pulling.');
		return runPull(ctx, options);
	}

	// Diverged: both sides changed. Stop, and let the user decide.
	const versions = { localVersion: situation.displayLocalVersion, remoteVersion: situation.remoteVersion };
	if (situation.state.baseVersion === 0 && situation.state.lastSyncAt === '') {
		// The commonest way to arrive here: a brand-new device whose local
		// configuration is simply whatever the installer left, while the
		// repository already holds the real configuration.
		ui.write('This device has never synced, and the repository already carries a configuration.');
		ui.write('Its local files are whatever is installed here right now, so they are not treated as an edit worth uploading.');
		ui.write();
	}
	if (process.stdin.isTTY !== true) {
		ui.write(divergenceMessage(versions));
		return 2;
	}
	const choice = await choose(ctx, divergenceHeader(versions), [
		{ label: 'Pull remote configuration' },
		{ label: 'Force push local configuration' },
		{ label: 'Show differences' },
	]);
	if (choice === 1) return runPull(ctx, options);
	if (choice === 2) return runPush(ctx, { ...options, force: true });
	if (choice === 3) return runDiff(ctx, options);
	ui.write(divergenceMessage(versions));
	return 2;
}

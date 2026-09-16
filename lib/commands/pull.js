/**
 * `harness-sync pull` — apply the repository's configuration to this device.
 *
 * A pull is the only operation that can destroy local configuration, so it backs
 * up first, every time, without asking.
 *
 * @module deepseek-harness-sync/commands/pull
 */

import { applySnapshot } from '../core/apply.js';
import { createBackup, pruneBackups } from '../core/backup.js';
import { contentDigest } from '../core/snapshot.js';
import { writeState } from '../core/state.js';
import { assess } from './situation.js';
import { reportMachineDependencies } from './shared.js';

/**
 * Run `pull`.
 *
 * @param {object} ctx - the execution context.
 * @param {{dryRun?: boolean}} [options] - overrides.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx, options = {}) {
	const { ui } = ctx;
	const dryRun = options.dryRun ?? ctx.flags.dryRun ?? false;

	const situation = assess(ctx);
	const { state } = situation;

	if (!situation.remoteExists) {
		ui.fail('the repository carries no configuration snapshot yet.');
		ui.write('      Run "harness-sync push" on the device that already has your configuration, then pull here.');
		return 1;
	}
	if (situation.remoteDigest === situation.localDigest) {
		ui.ok('this device already matches the repository; nothing to apply');
		return 0;
	}

	const envelope = situation.remoteEnvelope;
	if (envelope.profile !== ctx.profile) {
		ui.warn(`the snapshot was taken on profile "${envelope.profile}" but this device is syncing profile "${ctx.profile}"`);
		ui.write('         Profile-scoped files will be written to the path this device is configured for.');
	}

	ui.head('Pull');
	ui.kv('Repository', state.repoUrl);
	ui.kv('Branch', state.branch);
	ui.kv('Remote version', envelope.version);
	ui.kv('Taken by', envelope.device);
	ui.kv('Taken at', envelope.updated_at || 'unknown');
	ui.write();

	// Back up before touching anything. This is not optional and not prompted.
	const backup = createBackup({
		dshHome: ctx.paths.dshHome,
		profile: ctx.profile,
		workspace: ctx.workspace,
		backupDir: ctx.paths.backup,
		device: ctx.device,
		version: state.localVersion,
		reason: `before pull to v${envelope.version}`,
	});
	const removed = pruneBackups(ctx.paths.backup, state.keepBackups ?? 5);
	ui.ok(`backed up current configuration to ${backup.path}`);
	if (removed.length > 0) ui.dim(`     pruned ${removed.length} old backup(s)`);

	const plan = applySnapshot({
		dshHome: ctx.paths.dshHome,
		profile: ctx.profile,
		workspace: ctx.workspace,
		envelope,
		dryRun,
	});

	for (const rel of plan.written) ui.write(`  written  ${rel}`);
	for (const rel of plan.deleted) ui.write(`  deleted  ${rel}`);
	for (const rel of plan.unchanged) ui.dim(`  same     ${rel}`);
	if (plan.notes.length > 0) {
		ui.warn('some entries in the snapshot were refused:');
		for (const note of plan.notes) ui.write(`         ${note}`);
	}

	if (dryRun) {
		ui.write();
		ui.warn('dry run: nothing was written');
		return 0;
	}

	writeState(ctx.paths.state, {
		...state,
		profile: ctx.profile,
		localVersion: envelope.version,
		baseVersion: envelope.version,
		localHash: contentDigest(envelope.files),
		remoteHash: contentDigest(envelope.files),
		lastSyncAt: new Date().toISOString(),
		lastSyncKind: 'pull',
	});

	ui.ok(`applied version ${envelope.version}`);

	reportMachineDependencies(ctx, situation.machine);

	if (plan.written.some((rel) => rel.startsWith('profiles/'))) {
		ui.write();
		ui.warn('profile files changed — restart DeepSeek Harness for the new bundle list to take effect.');
		ui.write('         If the profile gained or lost plugin bundles, run "pnpm install" in the profile directory');
		ui.write('         (or "dsh plugin --profile <name> install") first.');
	}
	ui.write();
	ui.dim(`Roll back with: harness-sync rollback --to ${backup.path.split(/[\\/]/).pop()}`);
	return 0;
}

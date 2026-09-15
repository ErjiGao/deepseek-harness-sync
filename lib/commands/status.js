/**
 * `harness-sync status` — compare this device against the configuration repository.
 *
 * The first block is the exact shape the specification asks for; everything
 * after it is detail for a human who wants to know why.
 *
 * @module deepseek-harness-sync/commands/status
 */

import { assess, classify } from './situation.js';
import { readLocal, reportMachineDependencies } from './shared.js';

/**
 * Run `status`.
 *
 * @param {object} ctx - the execution context.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx) {
	const { ui } = ctx;

	if (ctx.state === undefined) {
		const present = readLocal(ctx);
		const tracked = Object.keys(present.files).sort();
		ui.write('GitHub repository: not configured');
		ui.write(`Local config: ${tracked.length > 0 ? 'found' : 'not found'}`);
		ui.write('Remote config: unknown');
		ui.write();
		ui.write('Status: this device is not initialized');
		// The first question anyone asks is "what would you upload?" — answer it
		// before they connect a repository, not after.
		if (tracked.length > 0) {
			ui.write();
			ui.head(`These ${tracked.length} file(s) in profile "${ctx.profile}" would be synced`);
			for (const rel of tracked) ui.write(`       ${rel}`);
		}
		if (present.absent.length > 0) {
			ui.write();
			ui.dim(`       (not present here, and recorded as such: ${present.absent.join(', ')})`);
		}
		if (present.notes.length > 0) {
			ui.write();
			ui.head('Collection notes');
			for (const note of present.notes) ui.write(`       ${note}`);
		}
		ui.write();
		reportMachineDependencies(ctx, present.machine);
		ui.write();
		ui.dim(`Run "harness-sync init" to connect a private repository. (looked for ${ctx.paths.state})`);
		return 1;
	}

	const situation = assess(ctx);
	const verdict = classify(situation);
	const { state } = situation;

	ui.write(`GitHub repository: ${situation.remoteReachable ? 'connected' : 'unreachable'}`);
	ui.write(`Local config: ${Object.keys(situation.localFiles).length > 0 ? 'found' : 'not found'}`);
	ui.write(`Remote config: ${situation.remoteExists ? 'found' : 'not found'}`);
	ui.write();
	ui.write(`Local version: ${situation.displayLocalVersion}`);
	ui.write(`Remote version: ${situation.remoteExists ? situation.remoteVersion : 'none'}`);
	ui.write();
	ui.write(`Status: ${verdict.message}`);

	if (!situation.remoteReachable && situation.remoteFetchError !== '') {
		ui.write();
		ui.fail(situation.remoteFetchError);
	}

	ui.write();
	ui.head('Detail');
	ui.kv('Repository', state.repoUrl);
	ui.kv('Branch', state.branch);
	ui.kv('Profile', ctx.profile);
	ui.kv('Device', state.device);
	ui.kv('Authentication', ctx.token === undefined ? 'Git credential helper' : 'token from environment or gh CLI');
	ui.kv('Repository privacy', state.repoPrivate === 'yes' ? 'confirmed private by GitHub at init' : 'never verified — confirm it yourself');
	ui.kv('Last synced version', state.baseVersion);
	ui.kv('Last synced at', state.lastSyncAt === '' ? 'never' : state.lastSyncAt);
	ui.kv('Local files', `${Object.keys(situation.localFiles).length} tracked`);
	if (situation.remoteExists) {
		ui.kv('Remote snapshot', `version ${situation.remoteVersion}, from ${situation.remoteEnvelope?.device ?? 'unknown device'}`);
		ui.kv('Remote updated', situation.remoteEnvelope?.updated_at ?? 'unknown');
	}
	for (const rel of Object.keys(situation.localFiles).sort()) ui.write(`       ${rel}`);
	if (situation.localAbsent.length > 0) {
		ui.write(`       (absent here: ${situation.localAbsent.join(', ')})`);
	}

	if (situation.notes.length > 0) {
		ui.write();
		ui.head('Collection notes');
		for (const note of situation.notes) ui.write(`       ${note}`);
	}

	reportMachineDependencies(ctx, situation.machine);

	if (verdict.exitCode !== 0) {
		ui.write();
		ui.head('Suggested next step');
		if (verdict.code === 'diverged') ui.write('  harness-sync sync      (asks you to choose: pull, force-push, or diff)');
		else if (verdict.code === 'remote-ahead') ui.write('  harness-sync pull      (apply the repository\'s configuration here)');
		else if (verdict.code === 'local-ahead' || verdict.code === 'local-only') ui.write('  harness-sync push      (upload this device\'s configuration)');
		else if (verdict.code === 'unreachable') ui.write('  Check the network or proxy settings, then run "harness-sync status" again.');
		else ui.write('  harness-sync diff      (see what differs)');
	}

	return verdict.exitCode;
}

/**
 * `harness-sync rollback` — restore a local backup.
 *
 * A rollback is itself reversible: the current configuration is backed up before
 * the chosen backup is applied, so a rollback taken by mistake can be undone the
 * same way.
 *
 * @module deepseek-harness-sync/commands/rollback
 */

import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { applySnapshot } from '../core/apply.js';
import { createBackup, listBackups, pruneBackups, readBackup } from '../core/backup.js';
import { assess } from './situation.js';

/**
 * Run `rollback`.
 *
 * @param {object} ctx - the execution context.
 * @param {{list?: boolean, to?: string, dryRun?: boolean}} [options] - overrides.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx, options = {}) {
	const { ui } = ctx;
	const dryRun = options.dryRun ?? ctx.flags.dryRun ?? false;
	const backups = listBackups(ctx.paths.backup);

	if (options.list === true) {
		if (backups.length === 0) {
			ui.write(`no backups yet in ${ctx.paths.backup}`);
			return 0;
		}
		ui.head(`Backups in ${ctx.paths.backup} (newest first)`);
		backups.forEach((entry, index) => {
			const when = new Date(entry.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
			const reason = entry.reason === '' ? '' : `  ${entry.reason}`;
			ui.write(`  ${index + 1}. ${entry.name}  v${entry.version}  ${entry.fileCount} file(s)  ${when}${reason}`);
		});
		return 0;
	}

	// Only an implicit rollback needs the rotation to be non-empty. An explicit
	// `--to` may name an exported snapshot, which lives outside it — so this check
	// must not pre-empt the resolution below.
	if (backups.length === 0 && options.to === undefined) {
		ui.fail(`no backups to restore in ${ctx.paths.backup}`);
		ui.write('      A backup is written automatically before every pull.');
		ui.write('      Export one now with: harness-sync export');
		return 1;
	}

	/** @type {typeof backups[number]|undefined} */
	let target;
	if (options.to === undefined) {
		target = backups[0];
	} else {
		const index = Number.parseInt(options.to, 10);
		target = Number.isInteger(index) && String(index) === options.to
			? backups[index - 1]
			: backups.find((entry) => entry.name === options.to || entry.path === options.to);
		// An exported snapshot lives outside the rotation, so accept a direct path
		// to one. This is the local-operator form only: the HTTP bridge restricts
		// `to` to an index or a bare file name.
		if (target === undefined && existsSync(options.to) && statSync(options.to).isFile()) {
			try {
				const envelope = readBackup(options.to);
				target = {
					path: options.to,
					name: basename(options.to),
					mtimeMs: statSync(options.to).mtimeMs,
					bytes: statSync(options.to).size,
					version: envelope.version,
					reason: envelope.reason ?? 'exported snapshot',
					device: envelope.device,
					fileCount: Object.keys(envelope.files).length,
				};
			} catch {
				// Not a snapshot after all; fall through to the error below.
			}
		}
	}
	if (target === undefined) {
		ui.fail(`no backup matches "${options.to}"`);
		ui.write('      List them with: harness-sync rollback --list');
		return 1;
	}

	const envelope = readBackup(target.path);
	const situation = assess(ctx);

	ui.head('Rollback');
	ui.kv('Backup', target.name);
	ui.kv('Taken', new Date(target.mtimeMs).toISOString());
	ui.kv('Recorded version', envelope.version);
	ui.kv('Files', Object.keys(envelope.files).length);
	if (target.reason !== '') ui.kv('Reason', target.reason);
	ui.write();

	// Keep the rollback itself reversible.
	const safety = createBackup({
		dshHome: ctx.paths.dshHome,
		profile: ctx.profile,
		workspace: ctx.workspace,
		backupDir: ctx.paths.backup,
		device: ctx.device,
		version: situation.state.localVersion,
		reason: `before rollback to ${basename(target.path)}`,
	});
	pruneBackups(ctx.paths.backup, situation.state.keepBackups ?? 5);
	ui.ok(`saved the current configuration to ${safety.path}`);

	const plan = applySnapshot({
		dshHome: ctx.paths.dshHome,
		profile: ctx.profile,
		workspace: ctx.workspace,
		envelope,
		dryRun,
	});
	for (const rel of plan.written) ui.write(`  restored ${rel}`);
	for (const rel of plan.deleted) ui.write(`  deleted  ${rel}`);
	for (const rel of plan.unchanged) ui.dim(`  same     ${rel}`);
	if (plan.notes.length > 0) {
		ui.warn('some entries were refused:');
		for (const note of plan.notes) ui.write(`         ${note}`);
	}
	if (dryRun) {
		ui.write();
		ui.warn('dry run: nothing was written');
		return 0;
	}
	ui.write();
	ui.ok('rollback complete — restart DeepSeek Harness if profile files changed');
	ui.dim('note: the rollback restore only rewinds local files; it does not push anything');
	return 0;
}

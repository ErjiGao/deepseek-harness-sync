/**
 * `harness-sync export` — write a restorable snapshot of this device to a file.
 *
 * An export is an ordinary snapshot envelope, so it can be inspected and applied
 * with the same tooling as any other. It lives in its own directory, outside the
 * rotation `pull` maintains: `rollback` prunes its backups to the retention
 * count, and an export a person deliberately asked for must not be silently
 * deleted by the next pull.
 *
 * @module deepseek-harness-sync/commands/export
 */

import { basename } from 'node:path';

import { createBackup } from '../core/backup.js';

/**
 * Run `export`.
 *
 * @param {object} ctx - the execution context.
 * @param {{onCreated?: (result: {path: string, fileCount: number}) => void}} [options] - an optional sink for the created file, so a caller can surface it structurally instead of parsing the printed text.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx, options = {}) {
	const { ui } = ctx;
	const version = ctx.state?.localVersion ?? 0;
	const result = createBackup({
		dshHome: ctx.paths.dshHome,
		profile: ctx.profile,
		backupDir: ctx.paths.exports,
		device: ctx.device,
		version,
		reason: 'manual export',
	});
	options.onCreated?.(result);

	ui.head('Export');
	ui.kv('File', basename(result.path));
	ui.kv('Location', result.path);
	ui.kv('Files', String(result.fileCount));
	ui.kv('Profile', ctx.profile);
	ui.kv('Device', ctx.device);
	ui.kv('Version', String(version));
	ui.write();
	ui.ok('wrote a restorable snapshot of this device');
	ui.dim('exports are never rotated away; restore one with "harness-sync rollback --to <path>"');
	return 0;
}

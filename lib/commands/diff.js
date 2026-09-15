/**
 * `harness-sync diff` — show what differs between this device and the repository.
 *
 * @module deepseek-harness-sync/commands/diff
 */

import { renderDiff } from '../core/diff.js';
import { assess } from './situation.js';

/**
 * Run `diff`.
 *
 * @param {object} ctx - the execution context.
 * @returns {Promise<number>} 0 when the two sides match, 1 when they differ.
 */
export async function run(ctx) {
	const { ui } = ctx;
	const situation = assess(ctx);

	if (!situation.remoteExists) {
		ui.write('the repository carries no configuration snapshot yet, so there is nothing to compare against');
		if (Object.keys(situation.localFiles).length > 0) {
			ui.write();
			ui.write(`this device has ${Object.keys(situation.localFiles).length} tracked file(s):`);
			for (const rel of Object.keys(situation.localFiles).sort()) ui.write(`  ${rel}`);
			ui.write();
			ui.dim('run "harness-sync push" to publish them');
		}
		return 1;
	}

	if (situation.remoteDigest === situation.localDigest) {
		ui.ok(`identical to the repository (version ${situation.remoteVersion})`);
		return 0;
	}

	ui.head(`Differences — left is this device, right is ${situation.remoteEnvelope?.device ?? 'the repository'}`);
	ui.dim('  "-" lines are only here, "+" lines are only in the repository');
	ui.write();

	const rels = [...new Set([...Object.keys(situation.localFiles), ...Object.keys(situation.remoteFiles)])].sort();
	let differing = 0;
	for (const rel of rels) {
		const local = situation.localFiles[rel];
		const remote = situation.remoteFiles[rel];
		if (local === remote) {
			ui.dim(renderDiff(rel, local, remote));
			continue;
		}
		differing += 1;
		ui.write(renderDiff(rel, local, remote));
	}

	// A file deliberately absent on one side is a difference too.
	const onlyLocalAbsent = situation.localAbsent.filter((rel) => rel in situation.remoteFiles);
	const onlyRemoteAbsent = (situation.remoteEnvelope?.absent ?? []).filter((rel) => rel in situation.localFiles);
	if (onlyLocalAbsent.length > 0) {
		ui.write();
		ui.write(`absent here, present in the repository: ${onlyLocalAbsent.join(', ')}`);
	}
	if (onlyRemoteAbsent.length > 0) {
		ui.write();
		ui.write(`present here, recorded absent in the repository: ${onlyRemoteAbsent.join(', ')}`);
	}

	ui.write();
	ui.write(`Local version: ${situation.displayLocalVersion}   Remote version: ${situation.remoteVersion}`);
	ui.write(`Status: ${differing} file(s) differ`);
	ui.write();
	ui.write('  harness-sync pull          take the repository\'s version');
	ui.write('  harness-sync push          upload this device\'s version');
	ui.write('  harness-sync push --force  overwrite the repository even if it advanced');
	return 1;
}

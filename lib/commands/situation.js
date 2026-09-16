/**
 * A shared reading of the local-vs-remote situation.
 *
 * `status`, `push`, `pull`, `sync` and `diff` all begin by answering the same
 * question — has either side moved since this device last synced — so the
 * judgement lives in one place rather than in five.
 *
 * @module deepseek-harness-sync/commands/situation
 */

import { contentDigest } from '../core/snapshot.js';
import { readLocal, readRemote, requireState } from './shared.js';

/**
 * @typedef {object} Situation
 * @property {object} state - the device state record.
 * @property {Record<string, string>} localFiles - this device's files.
 * @property {string[]} localAbsent - whitelisted files confirmed absent here.
 * @property {string} localDigest - digest of `localFiles`.
 * @property {boolean} localDirty - whether this device changed since the last sync.
 * @property {number} displayLocalVersion - the version this device would push as.
 * @property {boolean} remoteConsulted - whether the repository was contacted at all.
 * @property {object|undefined} remoteEnvelope - the remote snapshot, when one exists.
 * @property {Record<string, string>} remoteFiles - the remote files (empty when none).
 * @property {string|undefined} remoteDigest - digest of the remote files.
 * @property {boolean} remoteExists - whether the remote carries a snapshot.
 * @property {number} remoteVersion - the remote snapshot version, 0 when absent.
 * @property {string[]} notes - collection notes.
 * @property {{rel: string, line: number, spec: string}[]} machine - machine-local dependency specs.
 */

/**
 * Determine where this device and the remote stand.
 *
 * `remote: false` skips the fetch entirely. The Settings page uses that for its
 * first paint so opening the page never waits on the network; the remote half is
 * asked for separately afterwards.
 *
 * @param {object} ctx - the execution context.
 * @param {{remote?: boolean}} [options] - whether to consult the repository.
 * @returns {Situation} the situation.
 */
export function assess(ctx, options = {}) {
	const consultRemote = options.remote !== false;
	const state = requireState(ctx);
	const local = readLocal(ctx);
	const localDigest = contentDigest(local.files);
	// With no recorded digest, treat any local content as "changed": a first push
	// must not be mistaken for a no-op.
	const localDirty = state.localHash === undefined || state.localHash === '' ? Object.keys(local.files).length > 0 : localDigest !== state.localHash;

	const remote = consultRemote
		? readRemote(ctx)
		: { fetched: true, fetchError: '', branchExists: false };
	const remoteFiles = remote.envelope?.files ?? {};
	const remoteDigest = remote.envelope === undefined ? undefined : contentDigest(remoteFiles);
	const remoteVersion = remote.envelope?.version ?? 0;

	return {
		state,
		localFiles: local.files,
		localAbsent: local.absent,
		localRepositories: local.repositories ?? [],
		localWorkspacePresent: local.workspacePresent === true,
		localDigest,
		localDirty,
		displayLocalVersion: localDirty ? state.localVersion + 1 : state.localVersion,
		remoteConsulted: consultRemote,
		remoteReachable: remote.fetched === true,
		remoteFetchError: remote.fetchError ?? '',
		remoteEnvelope: remote.envelope,
		remoteFiles,
		remoteDigest,
		remoteExists: remote.envelope !== undefined,
		remoteVersion,
		notes: local.notes,
		machine: local.machine,
	};
}

/**
 * Classify a situation into one of the states `status` reports.
 *
 * @param {Situation} situation - the situation.
 * @returns {{code: string, message: string, exitCode: number}} the verdict.
 */
export function classify(situation) {
	if (situation.remoteConsulted === false) {
		return {
			code: 'local-not-checked',
			message: situation.localDirty ? 'local configuration has unsynced changes' : 'local configuration unchanged',
			exitCode: 1,
		};
	}
	if (!situation.remoteReachable) {
		return { code: 'unreachable', message: 'the configuration repository could not be reached', exitCode: 1 };
	}
	if (!situation.remoteExists) {
		return {
			code: 'local-only',
			message: situation.localDirty ? 'local configuration not pushed yet' : 'nothing to sync yet',
			exitCode: situation.localDirty ? 1 : 0,
		};
	}
	if (situation.remoteDigest === situation.localDigest) {
		return { code: 'synchronized', message: 'synchronized', exitCode: 0 };
	}
	const remoteAhead = situation.remoteVersion > situation.state.baseVersion;
	if (situation.localDirty && remoteAhead) {
		return { code: 'diverged', message: 'diverged — both sides changed', exitCode: 2 };
	}
	if (remoteAhead) {
		return { code: 'remote-ahead', message: 'remote configuration is newer', exitCode: 1 };
	}
	if (situation.localDirty) {
		return { code: 'local-ahead', message: 'local configuration has unpushed changes', exitCode: 1 };
	}
	return { code: 'unknown', message: 'the two sides differ, but neither moved since the last sync — run "harness-sync diff"', exitCode: 2 };
}

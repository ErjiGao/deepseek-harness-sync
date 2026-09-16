/**
 * `harness-sync push` — upload this device's configuration.
 *
 * `push` never writes to the harness configuration; it only reads it. The one
 * thing it must never do is overwrite a remote that moved since this device last
 * synced, so that check runs before anything is staged.
 *
 * @module deepseek-harness-sync/commands/push
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { commitAll, pushBranch } from '../core/github.js';
import { blockingFindings, formatFindings, screenFiles } from '../core/guard.js';
import { CLONE_SCRIPT_PATH, REPOS_PATH, cloneScriptFor, repositoriesFrom } from '../core/layers.js';
import { SESSIONS_DIR, collectSessions, sessionBytes, sessionIndex, writeSessionsLayer } from '../core/sessions.js';
import { METADATA_PATH, SNAPSHOT_PATH, buildMetadata, contentDigest, stableStringify } from '../core/snapshot.js';
import { writeState } from '../core/state.js';
import { assess } from './situation.js';
import {
	CONFIG_REPO_GITIGNORE,
	CONFIG_REPO_README,
	GITIGNORE_BEGIN,
	divergenceMessage,
	makeEnvelope,
	mergeGitignore,
	reportMachineDependencies,
} from './shared.js';

/** A string that only ever appears in a file this plugin wrote. */
const MARKER = 'deepseek-harness-sync';

/** Marker inside the appended `.gitignore` block, used to append it only once. */
const GITIGNORE_MARKER = 'deepseek-harness-sync secrets';

/**
 * Classify an existing repository file.
 *
 * Reusing a repository that another tool already writes to is supported, so a
 * file this plugin did not create must never be overwritten.
 *
 * @param {string} abs - native absolute path.
 * @returns {'absent'|'ours'|'foreign'} the classification.
 */
function ownership(abs) {
	if (!existsSync(abs)) return 'absent';
	try {
		return readFileSync(abs, 'utf8').includes(MARKER) ? 'ours' : 'foreign';
	} catch {
		return 'foreign';
	}
}

/**
 * Render the configuration repository's working tree.
 *
 * `config/harness-config.json` and `metadata.json` are ours alone and are always
 * rewritten. `README.md` and `.gitignore` are shared namespace: a README written
 * by some other tool is left untouched, and an existing `.gitignore` has this
 * plugin's block appended rather than replacing whatever was already there.
 *
 * @param {string} repoDir - the working clone.
 * @param {{envelope: object, metadata: object}} content - what to write.
 * @returns {{written: string[], kept: string[], appended: string[]}} what happened to which file.
 */
function writeRepoTree(repoDir, content) {
	/** @type {string[]} */
	const written = [];
	/** @type {string[]} */
	const kept = [];
	/** @type {string[]} */
	const appended = [];
	const put = (rel, text) => {
		const abs = join(repoDir, ...rel.split('/'));
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text, 'utf8');
		written.push(rel);
	};

	for (const [rel, text] of [
		[SNAPSHOT_PATH, stableStringify(content.envelope)],
		[METADATA_PATH, stableStringify(content.metadata)],
	]) {
		put(rel, text);
	}

	// The repository list and the clone script are generated from the snapshot's
	// own preferences, so they are derived artefacts rather than a second source
	// of truth. They are written as convenience: a person restoring a machine can
	// read the list, or run the script, without parsing the snapshot by hand.
	const repositories = repositoriesFrom(content.envelope);
	put(REPOS_PATH, stableStringify({ generated_at: content.envelope.updated_at, repositories }));
	put(CLONE_SCRIPT_PATH, cloneScriptFor(repositories));

	const readmeAbs = join(repoDir, 'README.md');
	if (ownership(readmeAbs) === 'foreign') kept.push('README.md');
	else put('README.md', CONFIG_REPO_README);

	// `.gitignore` is shared namespace. `mergeGitignore` replaces this plugin's
	// fenced block and leaves anything outside it alone, which is what lets a rule
	// change reach a repository that already carries an older block — the earlier
	// "append once, then never touch it again" behaviour meant dropping `sessions/`
	// from the rules never reached the real repository, so the session tree stayed
	// ignored and every push reported logs it had silently not committed.
	const ignoreAbs = join(repoDir, '.gitignore');
	const current = existsSync(ignoreAbs) ? readFileSync(ignoreAbs, 'utf8') : undefined;
	const merged = current === undefined ? CONFIG_REPO_GITIGNORE : mergeGitignore(current);
	if (current === merged) {
		kept.push('.gitignore');
	} else {
		put('.gitignore', merged);
		// Distinguish "added our block to someone else's file" from "renewed our own",
		// because that is the difference a reader cares about.
		if (current !== undefined && !current.includes(GITIGNORE_BEGIN)) appended.push('.gitignore');
	}

	return { written, kept, appended };
}

/**
 * Run `push`.
 *
 * @param {object} ctx - the execution context.
 * @param {{force?: boolean, dryRun?: boolean}} [options] - overrides.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx, options = {}) {
	const { ui } = ctx;
	const force = options.force ?? ctx.flags.force ?? false;
	const dryRun = options.dryRun ?? ctx.flags.dryRun ?? false;

	const situation = assess(ctx);
	const { state } = situation;

	// 1. Refuse to publish credentials, before anything else happens.
	const findings = screenFiles(situation.localFiles);
	const blocks = blockingFindings(findings);
	if (blocks.length > 0) {
		ui.fail(`refusing to push: ${blocks.length} credential-like value(s) found in the files that would be uploaded.`);
		ui.write(formatFindings(blocks));
		ui.write();
		ui.write('Nothing was committed or pushed. Remove the value from the harness configuration (prefer an');
		ui.write('environment variable the harness reads at run time), then run "harness-sync push" again.');
		return 1;
	}
	const warns = findings.filter((finding) => finding.severity === 'warn');
	if (warns.length > 0) ui.write(formatFindings(warns));

	reportMachineDependencies(ctx, situation.machine);

	// 2. Never overwrite a remote that advanced since this device last synced.
	if (situation.remoteVersion > state.baseVersion && !force) {
		ui.write(divergenceMessage({ localVersion: situation.displayLocalVersion, remoteVersion: situation.remoteVersion }));
		return 2;
	}
	if (situation.remoteVersion > state.baseVersion && force) {
		ui.warn(`forcing past a remote that advanced (remote version ${situation.remoteVersion}, base ${state.baseVersion})`);
	}

	// 3. The next version is always ahead of everything this device has seen.
	const version = Math.max(state.localVersion, situation.remoteVersion) + 1;
	// Session logs are collected here rather than folded into the snapshot: they are
	// binary and large, so they travel as real files under `sessions/` in the
	// repository, where Git stores each one as its own blob. Only the index —
	// paths, sizes and hashes — rides inside the snapshot.
	const sessions = collectSessions({ dshHome: ctx.paths.dshHome });
	// `repositories` must be forwarded explicitly. `makeEnvelope` defaults a
	// missing list to empty, so omitting it here does not fail — it silently
	// publishes a snapshot with no repository references at all, which is only
	// visible once someone tries to restore a machine from it.
	const envelope = makeEnvelope(ctx, {
		files: situation.localFiles,
		absent: situation.localAbsent,
		repositories: situation.localRepositories,
		sessions: sessionIndex(sessions.entries),
	}, version);
	const metadata = buildMetadata(envelope);

	ui.head('Push');
	ui.kv('Repository', state.repoUrl);
	ui.kv('Branch', state.branch);
	ui.kv('Device', ctx.device);
	ui.kv('Version', `${state.localVersion} → ${version}`);
	ui.kv('Files', `${Object.keys(situation.localFiles).length}`);
	for (const rel of Object.keys(situation.localFiles).sort()) ui.write(`       ${rel}`);
	if (sessions.entries.length > 0) {
		ui.kv('Sessions', `${sessions.entries.length} file(s), ${(sessionBytes(sessionIndex(sessions.entries)) / 1024 / 1024).toFixed(1)} MB`);
	}
	for (const note of sessions.notes) ui.dim(`     ${note}`);

	if (dryRun) {
		ui.write();
		ui.warn('dry run: nothing was committed or pushed');
		return 0;
	}

	const tree = writeRepoTree(ctx.paths.repo, { envelope, metadata });
	for (const rel of tree.kept) ui.dim(`     kept the repository's own ${rel} (not written by this plugin)`);
	for (const rel of tree.appended) ui.dim(`     appended this plugin's block to the repository's own ${rel}`);

	const sessionTree = writeSessionsLayer(ctx.paths.repo, sessions.entries);
	if (sessionTree.written.length > 0) ui.dim(`     ${sessionTree.written.length} session file(s) copied into ${SESSIONS_DIR}/`);
	else if (sessionTree.unchanged > 0) ui.dim(`     ${sessionTree.unchanged} session file(s) already current in ${SESSIONS_DIR}/`);

	const message = `push v${version} from ${ctx.device}`;
	const committed = commitAll({ repoDir: ctx.paths.repo, message });
	if (!committed.committed) {
		ui.ok('the repository already holds exactly this configuration; nothing to push');
	} else {
		if (committed.author.source === 'default') {
			ui.dim(`     Git has no user.name/user.email configured; committed as ${committed.author.name} <${committed.author.email}> (this clone only)`);
		}
		pushBranch({ repoDir: ctx.paths.repo, branch: state.branch, url: state.repoUrl, token: ctx.token, force: false });
		ui.ok(`pushed version ${version} to ${state.branch}`);
	}

	writeState(ctx.paths.state, {
		...state,
		profile: ctx.profile,
		device: ctx.device,
		localVersion: version,
		baseVersion: version,
		localHash: contentDigest(envelope.files),
		remoteHash: contentDigest(envelope.files),
		lastSyncAt: new Date().toISOString(),
		lastSyncKind: 'push',
	});

	// Say what was actually verified rather than asserting privacy that was
	// never confirmed: the check needs a token, and init may not have had one.
	if (state.repoPrivate === 'yes') {
		ui.dim('     GitHub confirmed this repository was private when "init" ran');
	} else {
		ui.warn('this repository\'s privacy was never verified (no token was available at "init" time).');
		ui.write('         Confirm it is private: GitHub → the repository → Settings → General → Danger Zone.');
	}
	return 0;
}

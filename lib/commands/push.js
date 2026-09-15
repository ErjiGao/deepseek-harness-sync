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
import { METADATA_PATH, SNAPSHOT_PATH, buildMetadata, contentDigest, stableStringify } from '../core/snapshot.js';
import { writeState } from '../core/state.js';
import { assess } from './situation.js';
import {
	CONFIG_REPO_GITIGNORE,
	CONFIG_REPO_README,
	divergenceMessage,
	makeEnvelope,
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

	const readmeAbs = join(repoDir, 'README.md');
	if (ownership(readmeAbs) === 'foreign') kept.push('README.md');
	else put('README.md', CONFIG_REPO_README);

	// `.gitignore` is shared namespace too, and a foreign one may hold rules we
	// must not drop — so our block is appended, exactly once.
	const ignoreAbs = join(repoDir, '.gitignore');
	if (ownership(ignoreAbs) === 'absent') {
		put('.gitignore', CONFIG_REPO_GITIGNORE);
	} else if (readFileSync(ignoreAbs, 'utf8').includes(GITIGNORE_MARKER)) {
		kept.push('.gitignore');
	} else {
		appendFileSync(ignoreAbs, `\n${CONFIG_REPO_GITIGNORE}`, 'utf8');
		appended.push('.gitignore');
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
	const envelope = makeEnvelope(ctx, { files: situation.localFiles, absent: situation.localAbsent }, version);
	const metadata = buildMetadata(envelope);

	ui.head('Push');
	ui.kv('Repository', state.repoUrl);
	ui.kv('Branch', state.branch);
	ui.kv('Device', ctx.device);
	ui.kv('Version', `${state.localVersion} → ${version}`);
	ui.kv('Files', `${Object.keys(situation.localFiles).length}`);
	for (const rel of Object.keys(situation.localFiles).sort()) ui.write(`       ${rel}`);

	if (dryRun) {
		ui.write();
		ui.warn('dry run: nothing was committed or pushed');
		return 0;
	}

	const tree = writeRepoTree(ctx.paths.repo, { envelope, metadata });
	for (const rel of tree.kept) ui.dim(`     kept the repository's own ${rel} (not written by this plugin)`);
	for (const rel of tree.appended) ui.dim(`     appended this plugin's block to the repository's own ${rel}`);

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

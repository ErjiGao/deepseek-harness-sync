/**
 * `harness-sync init` — connect this device to a private configuration repository.
 *
 * @module deepseek-harness-sync/commands/init
 */

import { parseRepoUrl, probeRemote, syncWorktree } from '../core/github.js';
import { checkRepoPrivate } from '../core/guard.js';
import { initialState, writeState } from '../core/state.js';
import { DEFAULT_BRANCH, ask, requireState } from './shared.js';

/**
 * Run `init`.
 *
 * @param {object} ctx - the execution context.
 * @param {{url?: string, user?: string, repo?: string, branch?: string}} [options] - non-interactive inputs.
 * @returns {Promise<number>} the process exit code.
 */
export async function run(ctx, options = {}) {
	const { ui } = ctx;

	let url = options.url;
	let branch = options.branch;
	if (url === undefined) {
		const user = options.user ?? (await ask(ctx, 'GitHub username'));
		const repo = options.repo ?? (await ask(ctx, 'Repository name', { defaultValue: 'deepseek-harness-config' }));
		branch = branch ?? (await ask(ctx, 'Branch', { defaultValue: DEFAULT_BRANCH }));
		if (user === undefined || repo === undefined) {
			ui.fail('no repository configured and no terminal to ask on — pass --url, or --user/--repo/--branch');
			return 1;
		}
		url = `https://github.com/${user}/${repo}.git`;
	}
	branch = branch ?? DEFAULT_BRANCH;

	const parsed = parseRepoUrl(url);

	ui.head('Connecting');
	ui.kv('Repository', parsed === undefined ? url : `${parsed.owner}/${parsed.repo}`);
	ui.kv('URL', url);
	ui.kv('Branch', branch);
	ui.kv('Profile', ctx.profile);
	ui.kv('Device', ctx.device);
	ui.kv('Authentication', ctx.token === undefined ? 'Git credential helper' : 'token from environment or gh CLI');
	ui.write();

	const probe = probeRemote({ url, branch, token: ctx.token });
	if (!probe.ok) {
		ui.fail(`cannot reach the repository.\n${probe.message}`);
		return 1;
	}
	ui.ok(probe.message);
	if (!probe.branchExists) {
		ui.dim(`     a branch that does not exist yet is fine: the first "harness-sync push" creates it.`);
	}

	// The private check fails closed when it can run, and says so loudly when it
	// cannot. A public configuration repository publishes machine names, the
	// plugin list, and the settings document. The verdict is recorded so that
	// later commands can report what was actually verified rather than assert
	// privacy they never confirmed.
	let repoPrivate = 'unverified';
	if (parsed === undefined) {
		ui.warn(`"${url}" is not a recognizable GitHub repository URL, so the private check was skipped.`);
		ui.write('      Make certain the remote is private before pushing configuration into it.');
	} else {
		const privacy = await checkRepoPrivate({ owner: parsed.owner, repo: parsed.repo, token: ctx.token });
		if (privacy.checked && privacy.private === false) {
			ui.fail(privacy.message);
			ui.write('      Make the repository private (GitHub → Settings → General → Danger Zone → Change visibility),');
			ui.write('      then run "harness-sync init" again.');
			return 1;
		}
		if (privacy.checked && privacy.private === true) {
			ui.ok(privacy.message);
			repoPrivate = 'yes';
		} else {
			ui.warn(privacy.message);
		}
	}

	const previous = ctx.state;
	const keepHistory = previous !== undefined && previous.repoUrl === url && previous.branch === branch;
	// The workspace root is recorded per device, never synced: it names a path on
	// THIS machine. Recording it here means later `push`/`pull` calls do not have
	// to repeat `--workspace`, which is the difference between a workflow somebody
	// uses and one they abandon after the third time.
	const workspace = ctx.workspace;
	const withWorkspace = (state) => (typeof workspace === 'string' && workspace !== ''
		? { ...state, workspace }
		: state);
	const next = withWorkspace(keepHistory
		? { ...previous, repoPrivate }
		: { ...initialState({ repoUrl: url, branch, profile: ctx.profile, device: ctx.device }), repoPrivate });
	if (keepHistory) ui.dim('     reusing the version history already recorded for this repository');
	if (typeof workspace === 'string' && workspace !== '') {
		ui.dim(`     workspace recorded for this device: ${workspace}`);
	} else {
		ui.dim('     no workspace recorded; pass --workspace or set $DSH_WORKSPACE to include one');
	}

	writeState(ctx.paths.state, next);
	ctx.state = requireState({ ...ctx, state: next });
	ui.ok(`wrote ${ctx.paths.state}`);
	ui.dim('     this file never holds a token; authentication stays with Git');
	syncWorktree({ repoDir: ctx.paths.repo, url, branch, token: ctx.token, log: (message) => ui.dim(`     ${message}`) });
	ui.ok(`local clone ready at ${ctx.paths.repo}`);

	ui.write();
	ui.head('Next');
	ui.write('  harness-sync push     upload this device\'s configuration');
	ui.write('  harness-sync pull     apply the repository\'s configuration here');
	ui.write('  harness-sync status   compare the two');
	return 0;
}

/**
 * The Settings page's HTTP bridge.
 *
 * The browser half is a static bundle served over `/plugins`, so it cannot call
 * the harness's own `/api` bridge without declaring a typed Remote. Instead this
 * module claims a private route prefix on the loopback web server — the same
 * approach other third-party plugins take — and the page talks to it with plain
 * `fetch` on the same origin.
 *
 * Three guards apply to every request, because a route registered here sits
 * outside the kernel's `/api` cookie fence:
 *
 * 1. the peer socket must be loopback;
 * 2. a present `Origin` must match the request's `Host` (a cross-site form post
 *    would carry the attacker's origin);
 * 3. only `POST` may change anything.
 *
 * No response ever contains a credential. Authentication for Git stays where it
 * belongs: the credential helper, `GH_TOKEN`, or `gh auth token`.
 *
 * @module deepseek-harness-sync/host/api
 */

import { listBackups } from '../core/backup.js';
import { resolveToken } from '../core/github.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { assess, classify } from '../commands/situation.js';
import { loadContext, readLocal } from '../commands/shared.js';
import { run as runExport } from '../commands/export.js';
import { run as runInit } from '../commands/init.js';
import { run as runPull } from '../commands/pull.js';
import { run as runPush } from '../commands/push.js';
import { run as runRollback } from '../commands/rollback.js';
import { run as runSync } from '../commands/sync.js';
import { Ui } from '../ui.js';

/** The route prefix this plugin claims. */
export const API_PREFIX = '/harness-sync/api';

/** Largest accepted request body. */
const MAX_BODY_BYTES = 64 * 1024;

/** A snapshot file name — never a path, so a crafted value cannot escape a directory. */
const SNAPSHOT_NAME = /^harness-config-[0-9A-Za-z._-]+\.json$/;

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {unknown} body - any JSON value.
 */
function sendJson(res, status, body) {
	const text = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text),
	});
	res.end(text);
}

/**
 * Whether a peer address is this machine.
 *
 * @param {string|undefined} address - the socket's remote address.
 * @returns {boolean} true when loopback.
 */
function isLoopback(address) {
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Apply the request guards.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @returns {boolean} true when the request may proceed.
 */
function admitted(req, res) {
	if (!isLoopback(req.socket.remoteAddress)) {
		sendJson(res, 403, { error: 'this endpoint is reachable from this machine only' });
		return false;
	}
	// The browser sets this and a page cannot forge it, so it catches a
	// cross-site post even when Origin happens to be absent.
	if (req.headers['sec-fetch-site'] === 'cross-site') {
		sendJson(res, 403, { error: 'cross-site request refused' });
		return false;
	}
	const origin = req.headers.origin;
	if (typeof origin === 'string' && origin !== '') {
		let originHost;
		try {
			originHost = new URL(origin).host;
		} catch {
			sendJson(res, 403, { error: 'malformed Origin header' });
			return false;
		}
		if (originHost !== req.headers.host) {
			sendJson(res, 403, { error: 'cross-origin request refused' });
			return false;
		}
	}
	return true;
}

/**
 * Read and parse a JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<Record<string, unknown>>} the parsed body, empty when none.
 * @throws {Error} when the body is too large or not JSON.
 */
async function readJson(req) {
	/** @type {Buffer[]} */
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		throw new Error('request body must be a JSON object');
	}
}

/**
 * Build a context whose output is captured instead of printed.
 *
 * @param {object} config - the plugin configuration.
 * @param {Record<string, unknown>} [flags] - command flags from the request.
 * @returns {{ctx: object, text: () => string}} the context and its captured output.
 */
function capturingContext(config, flags = {}) {
	/** @type {string[]} */
	const chunks = [];
	const sink = {
		isTTY: false,
		write(chunk) {
			chunks.push(String(chunk));
			return true;
		},
	};
	const ui = new Ui({ out: sink, err: sink, color: false, env: {} });
	const ctx = loadContext({
		env: process.env,
		ui,
		root: config.root,
		profile: config.profile,
		device: config.device,
		dataRoot: config.dataRoot,
		flags,
	});
	return { ctx, text: () => chunks.join('').replace(/\n+$/, '') };
}

/**
 * The structured status the page renders.
 *
 * `remote: false` answers from local facts alone so the page's first paint never
 * blocks on the network; the page then asks again with the remote consulted.
 *
 * @param {object} config - the plugin configuration.
 * @param {{remote?: boolean}} [options] - whether to contact the repository.
 * @returns {Record<string, unknown>} the status payload.
 */
export function statusPayload(config, options = {}) {
	const consultRemote = options.remote === true;
	const { ctx } = capturingContext(config);
	const token = resolveToken();
	const base = {
		profile: ctx.profile,
		dataRoot: ctx.paths.root,
		authentication: token === undefined ? 'Git credential helper' : 'token from environment or gh CLI',
		remoteChecked: consultRemote,
	};
	if (ctx.state === undefined) {
		// Not initialized: report what *would* be uploaded, so the page can show it
		// before the user connects anything. `assess` cannot be used here because it
		// requires a state record.
		const local = readLocal(ctx);
		return {
			...base,
			initialized: false,
			files: Object.keys(local.files).sort(),
			absent: local.absent,
			machineDeps: local.machine,
			notes: local.notes,
			backups: listBackups(ctx.paths.backup).map(summarizeBackup),
		};
	}
	const situation = assess(ctx, { remote: consultRemote });
	const verdict = classify(situation);
	return {
		...base,
		initialized: true,
		reachable: situation.remoteReachable,
		repoUrl: situation.state.repoUrl,
		branch: situation.state.branch,
		device: situation.state.device,
		privacy: situation.state.repoPrivate ?? 'unverified',
		localVersion: situation.displayLocalVersion,
		remoteVersion: situation.remoteExists ? situation.remoteVersion : undefined,
		localVersionRecorded: situation.state.localVersion,
		baseVersion: situation.state.baseVersion,
		localDirty: situation.localDirty,
		lastSyncAt: situation.state.lastSyncAt,
		lastSyncKind: situation.state.lastSyncKind,
		verdict: verdict.code,
		message: verdict.message,
		exitCode: verdict.exitCode,
		remoteDevice: situation.remoteEnvelope?.device,
		remoteUpdatedAt: situation.remoteEnvelope?.updated_at,
		files: Object.keys(situation.localFiles).sort(),
		absent: situation.localAbsent,
		notes: situation.notes,
		machineDeps: situation.machine,
		fetchError: situation.remoteFetchError,
		backups: listBackups(ctx.paths.backup).map(summarizeBackup),
	};
}

/**
 * Reduce a backup listing entry to what the page shows.
 *
 * @param {object} entry - a `listBackups` entry.
 * @returns {{name: string, version: number, fileCount: number, reason: string, at: string}} the summary.
 */
function summarizeBackup(entry) {
	return {
		name: entry.name,
		version: entry.version,
		fileCount: entry.fileCount,
		reason: entry.reason,
		at: new Date(entry.mtimeMs).toISOString(),
	};
}

/**
 * Run one command and capture its output.
 *
 * @param {object} config - the plugin configuration.
 * @param {string} action - the command to run.
 * @param {Record<string, unknown>} body - the request body.
 * @returns {Promise<{exitCode: number, output: string}>} the captured result.
 */
async function runAction(config, action, body) {
	const flags = {
		force: body.force === true,
		dryRun: body.dryRun === true,
	};
	const { ctx, text } = capturingContext(config, flags);
	try {
		/** @type {number} */
		let exitCode;
		/** @type {{path: string, fileCount: number}|undefined} */
		let created;
		if (action === 'init') {
			exitCode = await runInit(ctx, {
				url: typeof body.url === 'string' && body.url.trim() !== '' ? body.url.trim() : undefined,
				user: typeof body.user === 'string' && body.user.trim() !== '' ? body.user.trim() : undefined,
				repo: typeof body.repo === 'string' && body.repo.trim() !== '' ? body.repo.trim() : undefined,
				branch: typeof body.branch === 'string' && body.branch.trim() !== '' ? body.branch.trim() : undefined,
			});
		} else if (action === 'push') exitCode = await runPush(ctx);
		else if (action === 'pull') exitCode = await runPull(ctx);
		else if (action === 'sync') exitCode = await runSync(ctx);
		else if (action === 'export') {
			exitCode = await runExport(ctx, {
				onCreated: (result) => {
					created = result;
				},
			});
		} else if (action === 'rollback') {
			// `to` arrives from the browser, so it may name a file or an index but
			// never a path: the CLI keeps the path form for a local operator, while
			// the wire form stays inside the directories this plugin owns.
			const to = typeof body.to === 'string' ? body.to.trim() : '';
			if (to !== '' && !/^(\d{1,3}|harness-config-[0-9A-Za-z._-]+\.json)$/.test(to)) {
				return { exitCode: 1, output: 'ERROR "to" must be a backup index or a snapshot file name' };
			}
			exitCode = await runRollback(ctx, {
				list: body.list === true,
				to: to === '' ? undefined : to,
			});
		} else {
			return { exitCode: 1, output: `unknown action "${action}"` };
		}
		return {
			exitCode,
			output: text(),
			...(created === undefined ? {} : { name: basename(created.path), path: created.path, fileCount: created.fileCount }),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: 1, output: `${text()}\nERROR ${message}`.trim() };
	}
}

/**
 * Serve a snapshot file as a download.
 *
 * Only a bare file name is accepted, and only from the two directories this
 * plugin owns, so a crafted `name` can neither traverse upwards nor reach a file
 * the user did not export.
 *
 * @param {object} config - the plugin configuration.
 * @param {URL} url - the request URL.
 * @param {import('node:http').ServerResponse} res - the response.
 */
function serveDownload(config, url, res) {
	const name = url.searchParams.get('name') ?? '';
	if (!SNAPSHOT_NAME.test(name)) {
		sendJson(res, 400, { error: 'name must be a snapshot file name' });
		return;
	}
	const { ctx } = capturingContext(config);
	for (const dir of [ctx.paths.exports, ctx.paths.backup]) {
		const abs = join(dir, name);
		if (!existsSync(abs)) continue;
		const bytes = readFileSync(abs);
		res.writeHead(200, {
			'content-type': 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="${name}"`,
			'content-length': bytes.length,
			'cache-control': 'no-store',
		});
		res.end(bytes);
		return;
	}
	sendJson(res, 404, { error: `no snapshot named "${name}"` });
}

/** Actions that change something, and are therefore POST-only. */
export const MUTATING_ACTIONS = new Set(['init', 'push', 'pull', 'sync', 'rollback', 'export']);

/** Actions that only read, and are therefore GET-only. */
export const READ_ONLY_ACTIONS = new Set(['status', 'download']);

/**
 * Register this plugin's routes on the loopback web server.
 *
 * @param {object} webServer - the `ctx.webServer` service.
 * @param {object} config - the plugin configuration.
 * @returns {Array<() => void>} the route disposers.
 */
export function registerApi(webServer, config) {
	const handler = async (req, res) => {
		if (!admitted(req, res)) return;
		const url = new URL(req.url ?? '/', 'http://x');
		const rest = url.pathname.slice(API_PREFIX.length);
		const action = rest.startsWith('/') ? rest.slice(1) : rest;
		// An unknown endpoint must not fall through to a command and answer 200.
		if (!READ_ONLY_ACTIONS.has(action) && !MUTATING_ACTIONS.has(action)) {
			sendJson(res, 404, { error: `unknown endpoint "${url.pathname}"` });
			return;
		}
		if (MUTATING_ACTIONS.has(action) && req.method !== 'POST') {
			sendJson(res, 405, { error: `${action} must be sent as POST` });
			return;
		}
		if (READ_ONLY_ACTIONS.has(action) && req.method !== 'GET') {
			sendJson(res, 405, { error: `${action} must be sent as GET` });
			return;
		}
		try {
			if (action === 'status') {
				sendJson(res, 200, statusPayload(config, { remote: url.searchParams.get('remote') === '1' }));
				return;
			}
			if (action === 'download') {
				serveDownload(config, url, res);
				return;
			}
			const body = await readJson(req);
			sendJson(res, 200, await runAction(config, action, body));
		} catch (error) {
			sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	};
	// Exactly one prefix route, registered at the BARE prefix with no trailing
	// slash. `dsh-host-webserver` matches a prefix with
	// `pathname === prefix || pathname.startsWith(prefix + '/')`
	// (lib/index.js:327), so a registered path carrying a trailing slash can never
	// match a child path — it would compare against a doubled slash and silently
	// 404 every request. The bare prefix also covers equality, so no separate
	// exact route is needed (and adding one would only risk a duplicate-path throw).
	return [
		webServer.register({
			kind: 'prefix',
			path: API_PREFIX,
			handler,
		}),
	];
}

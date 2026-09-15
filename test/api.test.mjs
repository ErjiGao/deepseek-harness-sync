/**
 * Tests for the Settings page's HTTP bridge.
 *
 * The bridge is the one place this plugin exposes a network-reachable surface, so
 * its guards are tested directly: loopback-only, same-origin, and POST-only for
 * anything that changes state.
 *
 * @module deepseek-harness-sync/test/api
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { API_PREFIX, registerApi, statusPayload } from '../lib/host/api.js';
import { initialState, writeState } from '../lib/core/state.js';
import { harnessFiles, makeRoot, tempDir } from './helpers.mjs';

/**
 * A response recorder standing in for `node:http`.
 *
 * @returns {object} the fake response.
 */
function fakeRes() {
	return {
		status: 0,
		headers: {},
		body: '',
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(text) {
			this.body = text ?? '';
		},
		json() {
			return JSON.parse(this.body);
		},
	};
}

/**
 * A request standing in for `node:http`.
 *
 * @param {{url?: string, method?: string, headers?: object, remoteAddress?: string, body?: string}} [options] - request facts.
 * @returns {object} the fake request.
 */
function fakeReq(options = {}) {
	const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')];
	return {
		url: options.url ?? `${API_PREFIX}/status`,
		method: options.method ?? 'GET',
		headers: options.headers ?? {},
		socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

/**
 * Register the API against a recording web server.
 *
 * @param {object} [config] - the plugin configuration.
 * @returns {{handler: Function, routes: object[], disposers: Function[]}} the harness.
 */
function harness(config) {
	const routes = [];
	const webServer = {
		register(route) {
			routes.push(route);
			return () => {};
		},
	};
	const disposers = registerApi(webServer, config ?? { profile: 'web' });
	// The prefix route is the one a real URL like /harness-sync/api/status hits.
	return { handler: routes[0].handler, routes, disposers };
}

/**
 * A throwaway harness home and data root.
 *
 * @returns {{root: string, dataRoot: string, config: object}} the paths and config.
 */
function isolated() {
	const root = makeRoot(harnessFiles());
	const dataRoot = join(tempDir('api-data'), 'harness-sync');
	return { root, dataRoot, config: { profile: 'web', root, dataRoot } };
}

/**
 * Mirror `WebServer.match` — `dsh-host-webserver/lib/index.js:322-331`.
 *
 * Reproduced here on purpose: the real router's rule is what makes a trailing
 * slash in a registered prefix fatal, and a test that only inspects the route
 * table cannot see that.
 *
 * @param {object[]} routes - registered routes.
 * @param {string} pathname - the request path.
 * @returns {object|undefined} the matching route.
 */
function matchRoute(routes, pathname) {
	const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname);
	if (exact !== undefined) return exact;
	let best;
	for (const route of routes) {
		if (route.kind !== 'prefix') continue;
		const prefix = route.path;
		if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
		if (best === undefined || prefix.length > best.path.length) best = route;
	}
	return best;
}

describe('api registration', () => {
	it('claims one prefix route, at the bare prefix', () => {
		const { routes } = harness();
		assert.equal(routes.length, 1);
		assert.equal(routes[0].kind, 'prefix');
		assert.equal(routes[0].path, API_PREFIX);
		assert.ok(!routes[0].path.endsWith('/'), 'a trailing slash would make the route unmatchable');
		assert.equal(typeof routes[0].handler, 'function');
	});

	it('is matched by every URL the browser half actually requests', () => {
		const { routes } = harness();
		for (const url of [
			`${API_PREFIX}/status`,
			`${API_PREFIX}/status?remote=1`,
			`${API_PREFIX}/init`,
			`${API_PREFIX}/push`,
			`${API_PREFIX}/pull`,
			`${API_PREFIX}/sync`,
			`${API_PREFIX}/rollback`,
			API_PREFIX,
		]) {
			const pathname = url.split('?')[0];
			assert.ok(matchRoute(routes, pathname), `${url} must resolve to our route`);
		}
	});

	it('regression: a trailing-slash prefix matches nothing', () => {
		// This is the exact defect a live run caught: the route was registered but
		// unreachable, so the Settings page showed "host returned HTTP 404".
		const broken = [{ kind: 'prefix', path: `${API_PREFIX}/` }];
		assert.equal(matchRoute(broken, `${API_PREFIX}/status`), undefined);
		assert.equal(matchRoute(broken, API_PREFIX), undefined);
	});

	it('returns a disposer that releases the route', () => {
		const released = [];
		const webServer = {
			register(route) {
				return () => released.push(route.path);
			},
		};
		for (const dispose of registerApi(webServer, { profile: 'web' })) dispose();
		assert.deepEqual(released, [API_PREFIX]);
	});
});

describe('api guards', () => {
	it('refuses a peer that is not this machine', async () => {
		const { handler } = harness();
		const res = fakeRes();
		await handler(fakeReq({ remoteAddress: '192.168.1.20' }), res);
		assert.equal(res.status, 403);
		assert.match(res.json().error, /this machine only/);
	});

	it('accepts every loopback spelling', async () => {
		for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			const { handler } = harness(isolated().config);
			const res = fakeRes();
			await handler(fakeReq({ remoteAddress: address }), res);
			assert.equal(res.status, 200, `${address} must be accepted`);
		}
	});

	it('refuses a cross-origin request', async () => {
		const { handler } = harness();
		const res = fakeRes();
		await handler(fakeReq({ headers: { origin: 'https://evil.example', host: '127.0.0.1:60776' } }), res);
		assert.equal(res.status, 403);
		assert.match(res.json().error, /cross-origin/);
	});

	it('refuses a cross-site request even when Origin is absent', async () => {
		// `Sec-Fetch-Site` is set by the browser and cannot be forged by a page, so
		// it is the check that still works when Origin is missing.
		const { handler } = harness();
		const res = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/push`, method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' }), res);
		assert.equal(res.status, 403);
		assert.match(res.json().error, /cross-site/);
	});

	it('accepts a same-origin request', async () => {
		const { handler } = harness(isolated().config);
		const res = fakeRes();
		await handler(fakeReq({ headers: { origin: 'http://127.0.0.1:60776', host: '127.0.0.1:60776' } }), res);
		assert.equal(res.status, 200);
	});

	it('refuses a malformed Origin rather than ignoring it', async () => {
		const { handler } = harness();
		const res = fakeRes();
		await handler(fakeReq({ headers: { origin: 'not a url', host: '127.0.0.1:1' } }), res);
		assert.equal(res.status, 403);
	});

	it('refuses a mutating action sent as GET', async () => {
		for (const action of ['init', 'push', 'pull', 'sync', 'rollback']) {
			const { handler } = harness(isolated().config);
			const res = fakeRes();
			await handler(fakeReq({ url: `${API_PREFIX}/${action}`, method: 'GET' }), res);
			assert.equal(res.status, 405, `${action} must refuse GET`);
			assert.match(res.json().error, /must be sent as POST/);
		}
	});

	it('refuses status sent as POST', async () => {
		const { handler } = harness(isolated().config);
		const res = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/status`, method: 'POST', body: '{}' }), res);
		assert.equal(res.status, 405);
	});

	it('404s an unknown endpoint and refuses a nested path', async () => {
		const { handler } = harness();
		for (const url of [`${API_PREFIX}/nope`, `${API_PREFIX}/push/extra`, API_PREFIX]) {
			const res = fakeRes();
			await handler(fakeReq({ url }), res);
			assert.equal(res.status, 404, `${url} must 404`);
		}
	});

	it('rejects a non-JSON body instead of guessing', async () => {
		const { handler } = harness(isolated().config);
		const res = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/push`, method: 'POST', body: 'not json' }), res);
		assert.equal(res.status, 400);
		assert.match(res.json().error, /must be a JSON object/);
	});
});

describe('export and download', () => {
	it('treats export as a mutation and download as a read', async () => {
		const { handler } = harness(isolated().config);
		const asGet = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/export`, method: 'GET' }), asGet);
		assert.equal(asGet.status, 405);

		const asPost = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/download`, method: 'POST', body: '{}' }), asPost);
		assert.equal(asPost.status, 405);
	});

	it('writes an export and serves it back as an attachment', async () => {
		const { dataRoot, config } = isolated();
		const { handler } = harness(config);

		const created = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/export`, method: 'POST', body: '{}' }), created);
		assert.equal(created.status, 200);
		const payload = created.json();
		assert.equal(payload.exitCode, 0, payload.output);
		// The structured name is what the page downloads, so it must be present.
		assert.match(payload.name, /^harness-config-[0-9A-Za-z._-]+\.json$/);

		const fetched = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/download?name=${payload.name}` }), fetched);
		assert.equal(fetched.status, 200);
		assert.match(fetched.headers['content-disposition'], /^attachment; filename="harness-config-/);
		assert.equal(fetched.headers['content-type'], 'application/json; charset=utf-8');
		// It is a real snapshot, restorable by the same code path as a backup.
		const envelope = JSON.parse(fetched.body);
		assert.ok(envelope.files['settings.yaml'].includes('agent-default-model'));
		assert.equal(envelope.reason, 'manual export');

		// It lives beside the rotation, not inside it.
		assert.ok(existsSync(join(dataRoot, 'exports', payload.name)));
		assert.ok(!existsSync(join(dataRoot, 'backup', payload.name)));
	});

	it('refuses a download name that is a path or is unknown', async () => {
		const { handler } = harness(isolated().config);
		for (const name of ['../../.credentials.yaml', '..\\..\\.credentials.yaml', '/etc/passwd', 'config.json', '']) {
			const res = fakeRes();
			await handler(fakeReq({ url: `${API_PREFIX}/download?name=${encodeURIComponent(name)}` }), res);
			assert.ok(res.status === 400 || res.status === 404, `${name} must be refused, got ${res.status}`);
		}
		const missing = fakeRes();
		await handler(fakeReq({ url: `${API_PREFIX}/download?name=harness-config-2000-01-01-0000.json` }), missing);
		assert.equal(missing.status, 404);
	});

	it('refuses a rollback target that is a path', async () => {
		const { handler } = harness(isolated().config);
		const res = fakeRes();
		await handler(
			fakeReq({ url: `${API_PREFIX}/rollback`, method: 'POST', body: JSON.stringify({ to: '../../etc/passwd' }) }),
			res,
		);
		assert.equal(res.status, 200);
		assert.equal(res.json().exitCode, 1);
		assert.match(res.json().output, /must be a backup index or a snapshot file name/);
	});
});

describe('status payload', () => {
	it('reports an uninitialized device with the files it would sync', () => {
		const { config } = isolated();
		const payload = statusPayload(config, { remote: false });
		assert.equal(payload.initialized, false);
		assert.ok(Array.isArray(payload.files));
		assert.ok(payload.files.includes('settings.yaml'));
		assert.ok(!payload.files.some((file) => file.includes('credentials')));
		assert.equal(payload.remoteChecked, false);
	});

	it('never carries a credential field', () => {
		const { config } = isolated();
		const text = JSON.stringify(statusPayload(config, { remote: false }));
		assert.doesNotMatch(text, /ghp_|github_pat_|sk-[A-Za-z0-9]{20}/);
		assert.equal(JSON.parse(text).token, undefined);
	});

	it('reports an initialized device from local facts without touching the network', () => {
		const { dataRoot, config } = isolated();
		writeState(
			join(dataRoot, 'config.json'),
			initialState({ repoUrl: 'https://github.com/me/repo.git', branch: 'main', profile: 'web', device: 'test-device' }),
		);
		const payload = statusPayload(config, { remote: false });
		assert.equal(payload.initialized, true);
		assert.equal(payload.repoUrl, 'https://github.com/me/repo.git');
		assert.equal(payload.branch, 'main');
		assert.equal(payload.device, 'test-device');
		// Not consulted: the page's first paint must never wait on the network.
		assert.equal(payload.remoteChecked, false);
		assert.equal(payload.remoteVersion, undefined);
		assert.equal(payload.privacy, 'unverified');
		assert.equal(payload.localDirty, true, 'files exist and no digest has been recorded yet');
		assert.ok(Array.isArray(payload.backups));
		assert.ok(payload.files.includes('settings.yaml'));
	});
});

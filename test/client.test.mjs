/**
 * Tests for the browser half.
 *
 * The bundle is loaded exactly the way the client module system loads it — by
 * calling `window.__ModuleLoader__.load(...)` and then the factory with a
 * CommonJS `require` — so the wrapper format, the plugin contract, and the
 * Settings-page registration are all proven without a browser.
 *
 * @module deepseek-harness-sync/test/client
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

/** @type {object|undefined} */
let entry;
/** @type {string[]} */
const required = [];

// The loader facade the browser installs before any bundle runs.
globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			entry = value;
		},
	},
};

await import('../lib/client.js');

/**
 * Build the exported plugin by running the bundle's factory.
 *
 * @returns {object} the module exports the loader would receive.
 */
function loadPlugin() {
	const React = {
		createElement: () => ({}),
		useState: () => [undefined, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
	};
	return entry.factory((specifier) => {
		required.push(specifier);
		if (specifier === 'react') return React;
		throw new Error(`the bundle asked for "${specifier}", which is not in the platform baseline`);
	});
}

describe('client bundle format', () => {
	it('registers itself through the loader facade under the package name', () => {
		assert.ok(entry, 'the bundle must call window.__ModuleLoader__.load');
		assert.equal(typeof entry.factory, 'function');
		// The host serves `<id>/client.js` and the loader keys factories by this id,
		// so it must be the package name exactly.
		assert.equal(entry.id, manifest.name);
	});

	it('requires nothing outside the platform baseline', () => {
		required.length = 0;
		loadPlugin();
		assert.deepEqual([...new Set(required)], ['react']);
	});

	it('exports a cordis plugin the client runtime can mount', () => {
		const plugin = loadPlugin();
		assert.equal(plugin.name, 'harness-sync-client');
		assert.deepEqual(plugin.inject, ['slots']);
		assert.equal(typeof plugin.apply, 'function');
	});

	it('is plain CommonJS inside the factory: no ESM syntax leaked out', () => {
		const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
		assert.match(source, /^window\.__ModuleLoader__\.load\(/m);
		// A stray top-level import/export would break the factory-form CJS loader.
		assert.doesNotMatch(source, /^\s*import\s/m);
		assert.doesNotMatch(source, /^\s*export\s/m);
	});

	it('declares a resolvable client bundle, as the host validator requires', () => {
		// Mirrors dsh-client-modules: platform must be a string, and exports["./client"]
		// must be a string or an object with a string default, resolving to a real file.
		assert.equal(manifest.dsh.client.platform, 'web');
		const spec = manifest.exports['./client'];
		const relative = typeof spec === 'string' ? spec : spec.default;
		assert.equal(typeof relative, 'string');
		const file = join(here, '..', ...relative.replace(/^\.\//, '').split('/'));
		const bytes = readFileSync(file, 'utf8');
		assert.ok(bytes.length > 1000, 'the served bundle must not be an empty placeholder');
		// Anything named in dsh.client.inject must be a real client graph row, or the
		// loader has nothing to order against. The package that declares the
		// `settings.section` slot is ui-settings-general, not the ui-settings domain
		// base, so that is the one worth waiting for.
		assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings-general']);
		for (const name of manifest.dsh.client.inject ?? []) assert.match(name, /^@[a-z0-9-]+\/[a-z0-9-]+$/);
	});
});

describe('client and host agree on the endpoints', () => {
	it('every action the bundle calls is one the host actually serves', async () => {
		// The two halves mirror the endpoint literals by hand, so this is the guard
		// against them drifting apart.
		const { MUTATING_ACTIONS, READ_ONLY_ACTIONS } = await import('../lib/host/api.js');
		const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
		/** @type {Set<string>} */
		const called = new Set();
		for (const match of source.matchAll(/\brequest\('([^']+)'/g)) called.add(match[1].split('?')[0]);
		for (const match of source.matchAll(/\brun\('([a-z]+)'/g)) called.add(match[1]);
		assert.ok(called.size >= 5, `expected several endpoints, found: ${[...called].join(', ')}`);
		for (const action of called) {
			assert.ok(
				MUTATING_ACTIONS.has(action) || READ_ONLY_ACTIONS.has(action),
				`the bundle calls "${action}", which the host does not serve`,
			);
		}
		// The export flow is the newest pair and therefore the easiest to let drift.
		assert.ok(called.has('export'), 'the bundle must still call export');
		assert.ok(READ_ONLY_ACTIONS.has('download'), 'the host must still serve download');
		assert.match(source, /\/download\?name=/, 'the bundle must build the download URL');
	});

	it('paints the primary button with a contrasting label', () => {
		// The regression a screenshot caught: the fill resolved to the near-black
		// brand colour while the label inherited the dark foreground, producing an
		// unreadable black block.
		const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');
		assert.match(source, /--dsw-alias-button-primary-fill/);
		assert.match(source, /--dsw-alias-label-primary-inverted/);
		assert.match(source, /color: props\.primary === true \? T\.onPrimary : 'inherit'/);
	});
});

describe('settings page registration', () => {
	it('contributes exactly one section to settings.section', () => {
		const plugin = loadPlugin();
		/** @type {string[]} */
		const injected = [];
		/** @type {{descriptor: object, component: unknown}[]} */
		const registrations = [];
		const ctx = {
			slots: {
				inject(key, callback) {
					injected.push(key);
					return callback();
				},
				register(descriptor, component) {
					registrations.push({ descriptor, component });
					return () => {};
				},
			},
		};
		plugin.apply(ctx);

		assert.deepEqual(injected, ['settings.section']);
		assert.equal(registrations.length, 1);
		const { descriptor, component } = registrations[0];
		assert.equal(descriptor.name, 'settings.section');
		// Section ids become navigation keys, so they must be plain lowercase ids.
		assert.match(descriptor.id, /^[a-z][a-z0-9-]*$/);
		assert.equal(typeof descriptor.order, 'number');
		assert.equal(typeof descriptor.label, 'function');
		assert.equal(typeof descriptor.label(), 'string');
		assert.ok(descriptor.label().length > 0);
		// The second argument is the page component itself.
		assert.equal(typeof component, 'function');
	});

	it('uses its own id, so it cannot collide with a shipped settings page', () => {
		const plugin = loadPlugin();
		let descriptor;
		plugin.apply({
			slots: {
				inject: (_key, callback) => callback(),
				register: (value) => {
					descriptor = value;
					return () => {};
				},
			},
		});
		for (const shipped of ['general', 'models', 'plugins', 'market', 'archived-sessions']) {
			assert.notEqual(descriptor.id, shipped);
		}
	});

	it('returns a disposer so unloading the plugin removes the page', () => {
		const plugin = loadPlugin();
		let disposed = false;
		/** @type {unknown} */
		let returned;
		plugin.apply({
			slots: {
				// `slots.inject` owns whatever the callback returns, which is how the
				// page is torn down when the plugin fiber unloads.
				inject: (_key, callback) => {
					returned = callback();
					return () => {};
				},
				register: () => () => {
					disposed = true;
				},
			},
		});
		assert.equal(typeof returned, 'function', 'the registration must hand back a disposer');
		returned();
		assert.equal(disposed, true);
	});
});

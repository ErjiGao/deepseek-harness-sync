/**
 * Tests for the DeepSeek Harness plugin half.
 *
 * The plugin is loaded exactly the way the cordis loader loads it — the module's
 * named exports are called with a fake context — so this proves the contract
 * without installing anything into a real profile.
 *
 * @module deepseek-harness-sync/test/plugin
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { apply, inject, name } from '../lib/index.js';
import { harnessFiles, makeRoot, tempDir } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build a context that records registrations, standing in for cordis.
 *
 * Only the parts of the real context this plugin touches are modelled, but the
 * two access rules are modelled *exactly*, because the difference between them
 * is what once took the whole app down:
 *
 * - `ctx.get(name)` answers from anywhere and returns `undefined` when the
 *   service does not exist;
 * - `ctx[name]` answers only inside a context that injected `name`; anywhere
 *   else the read throws, with cordis's own words.
 *
 * A fake that simply spread the services onto `ctx` would hide that, which is
 * precisely how the `commands` crash reached a user.
 *
 * @param {{commands?: boolean, webServer?: boolean}} [options] - which optional services to provide.
 * @returns {{ctx: object, tools: object[], commands: object[], routes: object[], effects: object[], pending: string[], provide: (name: string, impl: object) => void}} the fake context and its records.
 */
function fakeContext(options = {}) {
	/** @type {object[]} */
	const tools = [];
	/** @type {object[]} */
	const commands = [];
	/** @type {object[]} */
	const routes = [];
	/** @type {object[]} */
	const effects = [];
	/** @type {string[]} */
	const pending = [];
	/** @type {Array<{names: string[], callback: (scope: object) => void}>} */
	const waiters = [];
	/** @type {Record<string, object>} */
	const services = {
		tools: {
			register: (definition) => {
				tools.push(definition);
				return () => {};
			},
		},
	};
	if (options.commands !== false) {
		services.commands = {
			register: (definition) => {
				commands.push(definition);
				return () => {};
			},
		};
	}
	if (options.webServer !== false) {
		services.webServer = {
			register: (route) => {
				routes.push(route);
				return () => {};
			},
		};
	}

	/**
	 * Build one context scope.
	 *
	 * @param {string[]} injected - the services this scope resolved, and therefore the only ones readable as properties.
	 * @returns {object} the scope.
	 */
	function scope(injected) {
		/** @type {Record<string, object>} */
		const resolved = Object.create(null);
		for (const name of injected) resolved[name] = services[name];
		const target = {
			get: (name) => services[name],
			effect: (fn, label) => {
				const dispose = fn();
				effects.push({ label, dispose });
				return () => {
					if (typeof dispose === 'function') dispose();
				};
			},
			// Mirrors cordis: the callback runs only once every named service exists,
			// and the scope it receives is the one that can read them.
			inject: (names, callback) => {
				const missing = names.filter((name) => services[name] === undefined);
				if (missing.length > 0) {
					pending.push(...missing);
					waiters.push({ names, callback });
					return () => {};
				}
				callback(scope(names));
				return () => {};
			},
		};
		return new Proxy(target, {
			get: (self, prop, receiver) => {
				if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(self, prop, receiver);
				if (prop in resolved) return resolved[prop];
				if (prop in self) return Reflect.get(self, prop, receiver);
				throw new Error(`cannot get property "${prop}" without inject`);
			},
		});
	}

	/**
	 * Add a service after load, waking every waiter that was blocked on it — the
	 * job cordis's `notify` does for a real fiber.
	 *
	 * @param {string} name - the service name.
	 * @param {object} impl - the service value.
	 * @returns {void}
	 */
	function provide(name, impl) {
		services[name] = impl;
		for (let index = waiters.length - 1; index >= 0; index -= 1) {
			const waiter = waiters[index];
			if (waiter.names.some((blocked) => services[blocked] === undefined)) continue;
			waiters.splice(index, 1);
			waiter.callback(scope(waiter.names));
		}
	}

	// `tools` is declared in the module's `inject`, so the applied context is the
	// one that already resolved it; the optional services are not.
	return { ctx: scope(['tools']), tools, commands, routes, effects, pending, provide };
}

/**
 * Run a body with the harness home pointed at a throwaway directory.
 *
 * @param {string} root - the temporary harness home.
 * @param {() => Promise<void>} body - the work.
 * @returns {Promise<void>} resolves when done.
 */
async function withTempHome(root, body) {
	const saved = { DSH_HOME: process.env.DSH_HOME, HARNESS_SYNC_HOME: process.env.HARNESS_SYNC_HOME };
	process.env.DSH_HOME = root;
	process.env.HARNESS_SYNC_HOME = join(root, 'harness-sync');
	try {
		await body();
	} finally {
		if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = saved.DSH_HOME;
		if (saved.HARNESS_SYNC_HOME === undefined) delete process.env.HARNESS_SYNC_HOME;
		else process.env.HARNESS_SYNC_HOME = saved.HARNESS_SYNC_HOME;
	}
}

describe('plugin contract', () => {
	it('exports the names the cordis loader reads', () => {
		assert.equal(name, 'harness-sync');
		// Only `tools` is a hard dependency: `inject` gates whether apply runs at
		// all, so injecting `commands` would make the plugin silently absent in a
		// profile that does not mount the command registry.
		assert.deepEqual(inject, ['tools']);
		assert.equal(typeof apply, 'function');
	});

	it('declares itself as a profile bundle whose patch file exists', () => {
		const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
		assert.equal(manifest.name, 'deepseek-harness-sync');
		assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
		assert.ok(manifest.exports['./cordis.patch.yml'], 'the patch must be exported so bundlers can find it');
		assert.equal(manifest.bin['harness-sync'], 'bin/harness-sync.js');
		// Zero build step: a `prepare` script would make pnpm refuse a `github:`
		// install until the user hand-edits allowBuilds on every new machine.
		assert.equal(manifest.scripts.prepare, undefined);
		assert.equal(manifest.dependencies, undefined);
		const patch = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
		// The bundle patch inserts this very package at the profile root.
		assert.match(patch, /- insert:/);
		assert.match(patch, /name: 'deepseek-harness-sync'/);
		// The loader's key is `disabled`; `disable` would be copied on and ignored.
		assert.doesNotMatch(patch, /^\s+disable:/m);
	});

	it('registers four tools with a valid output contract', () => {
		const { ctx, tools } = fakeContext();
		apply(ctx, {});
		assert.deepEqual(
			tools.map((tool) => tool.name).sort(),
			['harness_sync_pull', 'harness_sync_push', 'harness_sync_rollback', 'harness_sync_status'],
		);
		for (const tool of tools) {
			assert.equal(typeof tool.description, 'string');
			assert.ok(tool.description.length > 20, `${tool.name} needs a useful description`);
			assert.equal(typeof tool.execute, 'function');
			assert.equal(typeof tool.output.render, 'function');
			assert.equal(tool.output.schema.type, 'object');
			assert.deepEqual(tool.output.schema.required, ['exitCode', 'output']);
			assert.equal(tool.output.schema.additionalProperties, false);
			// The registry does not validate `parameters`, so every tool must
			// still declare a well-formed object schema.
			assert.equal(tool.parameters.type, 'object');
		}
	});

	it('registers the slash command when the command registry is present', () => {
		const withCommands = fakeContext();
		apply(withCommands.ctx, {});
		assert.equal(withCommands.commands.length, 1);
		assert.match(withCommands.commands[0].name, /^[a-z][a-z0-9_-]*$/);
		assert.equal(withCommands.commands[0].name, 'harness-sync');
		assert.equal(typeof withCommands.commands[0].handler, 'function');
	});

	it('loads and registers tools even where no command registry exists', () => {
		const { ctx, tools, commands, routes, pending } = fakeContext({ commands: false });
		apply(ctx, {});
		assert.equal(tools.length, 4, 'tools must still register without ctx.commands');
		assert.equal(commands.length, 0);
		// The command attaches later, once the service appears, instead of
		// preventing the plugin from loading at all.
		assert.ok(pending.includes('commands'), 'the wait must be registered, not skipped');
		assert.equal(routes.length, 1, 'the settings bridge still mounts');
	});

	it('attaches the slash command through an injected child scope, not the outer context', () => {
		// The regression that took the whole app down: probing the service with
		// `ctx.get('commands')` and then reading `ctx.commands` on the context
		// handed to `apply`. In cordis that read throws "cannot get property
		// commands without inject" — inside `apply`, which aborts loading the
		// plugin *and* the server, not just the command. The fake context enforces
		// the same rule, so a relapse fails here.
		const { ctx, tools, commands, routes } = fakeContext();
		assert.doesNotThrow(() => apply(ctx, {}));
		assert.equal(tools.length, 4);
		assert.equal(commands.length, 1);
		assert.equal(routes.length, 1);
	});

	it('attaches an optional service that only appears after load', () => {
		const fake = fakeContext({ commands: false });
		apply(fake.ctx, {});
		assert.equal(fake.commands.length, 0);
		fake.provide('commands', {
			register: (definition) => {
				fake.commands.push(definition);
				return () => {};
			},
		});
		assert.equal(fake.commands.length, 1, 'the waiting child scope must wake and register');
		assert.equal(fake.commands[0].name, 'harness-sync');
	});

	it('mounts the settings-page bridge when a web server exists', () => {
		const { ctx, routes } = fakeContext();
		apply(ctx, {});
		assert.deepEqual(
			routes.map((route) => `${route.kind} ${route.path}`),
			['prefix /harness-sync/api'],
		);
		// The router matches a prefix as `pathname === prefix || pathname.startsWith(prefix + '/')`,
		// so a trailing slash here would register a route that can never match.
		for (const route of routes) {
			assert.ok(!route.path.endsWith('/'), `${route.path} must not end with a slash`);
			assert.equal(typeof route.handler, 'function');
		}
	});

	it('stays loadable where no web server exists, by waiting rather than failing', () => {
		const { ctx, tools, routes, pending } = fakeContext({ webServer: false });
		apply(ctx, {});
		assert.equal(tools.length, 4);
		assert.equal(routes.length, 0);
		assert.ok(pending.includes('webServer'));
	});

	it('rejects a malformed config at load time instead of syncing the wrong thing', () => {
		const { ctx } = fakeContext();
		assert.throws(() => apply(ctx, { profile: 42 }), /config\.profile must be a non-empty string/);
		assert.throws(() => apply(ctx, { dataRoot: '' }), /config\.dataRoot must be a non-empty string/);
	});

	it('runs a tool against the configured home and returns rendered text', async () => {
		const root = makeRoot(harnessFiles());
		await withTempHome(root, async () => {
			const { ctx, tools } = fakeContext();
			apply(ctx, { profile: 'web' });
			const status = tools.find((tool) => tool.name === 'harness_sync_status');
			const result = await status.execute({});
			assert.equal(result.exitCode, 1, 'an uninitialized device exits 1');
			assert.match(result.output, /GitHub repository: not configured/);
			const rendered = status.output.render({}, result);
			assert.equal(rendered[0].type, 'text');
			assert.match(rendered[0].text, /this device is not initialized/);
		});
	});

	it('rejects unknown tool arguments', async () => {
		const root = makeRoot(harnessFiles());
		await withTempHome(root, async () => {
			const { ctx, tools } = fakeContext();
			apply(ctx, {});
			const push = tools.find((tool) => tool.name === 'harness_sync_push');
			await assert.rejects(() => push.execute({ bogus: true }), /unrecognized argument "bogus"/);
			await assert.rejects(() => push.execute({ force: 'yes' }), /"force" must be a boolean/);
		});
	});

	it('answers an unknown slash subcommand without running anything', async () => {
		const { ctx, commands } = fakeContext();
		apply(ctx, {});
		const result = await commands[0].handler({ rawInput: 'frobnicate' });
		assert.equal(result.kind, 'error');
		assert.match(result.text, /unknown subcommand "frobnicate"/);
	});

	it('defaults the slash command to status', async () => {
		const root = tempDir('plugin-default');
		await withTempHome(root, async () => {
			const { ctx, commands } = fakeContext();
			apply(ctx, {});
			const result = await commands[0].handler({ rawInput: '' });
			assert.equal(result.kind, 'error', 'an uninitialized device is not a success');
			assert.match(result.text, /not configured/);
		});
	});
});

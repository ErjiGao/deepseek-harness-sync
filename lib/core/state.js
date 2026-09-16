/**
 * This plugin's own configuration — which repository, which profile, and where
 * this device sits in the version history.
 *
 * The record structurally has no token field, and `readState` rejects one if it
 * ever appears, so no code path can persist a credential here by accident.
 *
 * @module deepseek-harness-sync/core/state
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** State format version. */
export const SCHEMA_VERSION = 1;

/** Keys a state record may carry. */
const ALLOWED_KEYS = new Set([
	'schema',
	'repoUrl',
	'branch',
	'profile',
	'device',
	'repoPrivate',
	// The workspace root recorded for THIS device. It belongs in state rather than
	// in the snapshot for the same reason `bin/dsh.cmd` does: it names a path on
	// this machine, and `/home/alice/work` is meaningless on another one.
	'workspace',
	'localVersion',
	'baseVersion',
	'localHash',
	'remoteHash',
	'lastSyncAt',
	'lastSyncKind',
	'keepBackups',
]);

/**
 * Read the state record.
 *
 * @param {string} statePath - path to `config.json`.
 * @returns {object|undefined} the record, or undefined when this device has not been initialized.
 * @throws {Error} when the record exists but cannot be trusted.
 */
export function readState(statePath) {
	if (!existsSync(statePath)) return undefined;
	let raw;
	try {
		raw = JSON.parse(readFileSync(statePath, 'utf8'));
	} catch (error) {
		throw new Error(`${statePath} is not valid JSON: ${error.message}`);
	}
	if (raw === null || typeof raw !== 'object') throw new Error(`${statePath} must hold a JSON object`);
	if (raw.token !== undefined || raw.pat !== undefined || raw.password !== undefined) {
		throw new Error(`${statePath} contains a credential field. This file must never hold a token — delete that key (authentication belongs to Git's own credential store) and re-run.`);
	}
	if (raw.schema !== SCHEMA_VERSION) {
		throw new Error(`${statePath} has state schema ${JSON.stringify(raw.schema)}; this build understands ${SCHEMA_VERSION}`);
	}
	for (const key of Object.keys(raw)) {
		if (!ALLOWED_KEYS.has(key)) throw new Error(`${statePath} has an unrecognized key "${key}"`);
	}
	if (typeof raw.repoUrl !== 'string' || raw.repoUrl === '') throw new Error(`${statePath} needs a repoUrl`);
	if (typeof raw.branch !== 'string' || raw.branch === '') throw new Error(`${statePath} needs a branch`);
	if (typeof raw.profile !== 'string' || raw.profile === '') throw new Error(`${statePath} needs a profile`);
	if (raw.workspace !== undefined && (typeof raw.workspace !== 'string' || raw.workspace === '')) {
		throw new Error(`${statePath} has a workspace that is not a non-empty string`);
	}
	return raw;
}

/**
 * Write the state record.
 *
 * @param {string} statePath - path to `config.json`.
 * @param {object} state - the record.
 */
export function writeState(statePath, state) {
	// Checked before the key allow-list so a credential is reported as a
	// credential, not as a generic unknown key.
	for (const forbidden of ['token', 'pat', 'password']) {
		if (state[forbidden] !== undefined) {
			throw new Error(`refusing to write a token into the state record ("${forbidden}") — authentication belongs to Git's own credential store`);
		}
	}
	for (const key of Object.keys(state)) {
		if (!ALLOWED_KEYS.has(key)) throw new Error(`refusing to write unrecognized state key "${key}"`);
	}
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ schema: SCHEMA_VERSION, ...state }, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
}

/**
 * Build a fresh state record for a device.
 *
 * @param {{repoUrl: string, branch: string, profile: string, device: string, keepBackups?: number}} input - inputs.
 * @returns {object} the record.
 */
export function initialState(input) {
	return {
		schema: SCHEMA_VERSION,
		repoUrl: input.repoUrl,
		branch: input.branch,
		profile: input.profile,
		device: input.device,
		localVersion: 0,
		baseVersion: 0,
		lastSyncAt: '',
		lastSyncKind: '',
		keepBackups: input.keepBackups ?? 5,
	};
}

/**
 * A short, stable name for this machine, used as the snapshot's `device` field.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment, so a test can pin the value.
 * @returns {string} the device name.
 */
export function deviceName(env = process.env) {
	const override = env.HARNESS_SYNC_DEVICE;
	if (typeof override === 'string' && override.trim() !== '') return override.trim();
	return hostname();
}

/**
 * A local audit: what would a push from this machine actually upload?
 *
 * This is a dry-run harness rather than a test, because it reads the real
 * machine. It prints the exact file list and repository references a snapshot
 * would carry, screens every value for credential shapes, and refuses to write
 * anything.
 *
 *   node test/audit-local.mjs [--workspace <dir>]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { collect } from '../lib/core/collect.js';
import { collectAll } from '../lib/core/layers.js';
import { blockingFindings, screenFiles } from '../lib/core/guard.js';

const args = process.argv.slice(2);
const workspaceIndex = args.indexOf('--workspace');
const workspace = workspaceIndex === -1 ? process.env.DSH_WORKSPACE : args[workspaceIndex + 1];
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

console.log(`harness home : ${dshHome}`);
console.log(`workspace    : ${workspace ?? '(none configured)'}`);
console.log('');

const collected = collectAll({
	dshHome,
	profile: 'web',
	workspace,
	collectHome: collect,
});

const homeFiles = Object.keys(collected.files).filter((rel) => !rel.startsWith('workspace/'));
const workspaceFiles = Object.keys(collected.files).filter((rel) => rel.startsWith('workspace/'));

console.log(`files that would be uploaded: ${Object.keys(collected.files).length}`);
console.log(`  from the harness home: ${homeFiles.length}`);
console.log(`  from the workspace   : ${workspaceFiles.length}`);
console.log('');
console.log('--- harness home ---');
for (const rel of homeFiles.sort()) {
	const bytes = Buffer.byteLength(collected.files[rel], 'utf8');
	console.log(`  ${String(bytes).padStart(7)}  ${rel}`);
}
console.log('');
console.log('--- workspace ---');
for (const rel of workspaceFiles.sort()) {
	const bytes = Buffer.byteLength(collected.files[rel], 'utf8');
	console.log(`  ${String(bytes).padStart(7)}  ${rel}`);
}
console.log('');
console.log(`--- repositories recorded as references (${collected.repositories.length}) ---`);
for (const repo of collected.repositories) {
	console.log(`  ${repo.path || '.'}  ->  ${repo.remote ?? '(no origin remote — NOT reproducible)'}`);
}
console.log('');
const totalBytes = Object.values(collected.files).reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
console.log(`total upload size: ${(totalBytes / 1024).toFixed(1)} KB`);
console.log('');

// The check that matters: does any collected value look like a credential?
const findings = screenFiles(collected.files);
const blocks = blockingFindings(findings);
console.log(`credential screen: ${findings.length} finding(s), ${blocks.length} blocking`);
if (findings.length > 0) {
	for (const finding of findings) {
		// Deliberately prints the location and the reason only — never the value.
		console.log(`  [${finding.severity}] ${finding.rel}${finding.line === undefined ? '' : `:${finding.line}`} — ${finding.reason}`);
	}
}
console.log('');

const noisy = collected.notes.filter((note) => !/skipped \(node_modules\)|skipped \(\.git\)/.test(note));
console.log(`--- notable collection notes (${noisy.length} of ${collected.notes.length}) ---`);
for (const note of noisy.slice(0, 40)) console.log(`  ${note}`);
if (noisy.length > 40) console.log(`  ... and ${noisy.length - 40} more`);

console.log('');
if (blocks.length > 0 || collected.workspacePresent !== true) {
	console.log(blocks.length > 0 ? 'RESULT: a push would be REFUSED (blocking findings above)' : 'RESULT: no workspace was collected');
	process.exit(blocks.length > 0 ? 1 : 0);
}
// A second, independent check: assert no collected value contains a private key.
const joined = JSON.stringify(collected.files);
const keyShaped = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(joined);
const tokenShaped = /(ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/.test(joined);
console.log(`independent scan: private key present = ${keyShaped}, token-shaped string present = ${tokenShaped}`);
process.exit(keyShaped || tokenShaped ? 1 : 0);

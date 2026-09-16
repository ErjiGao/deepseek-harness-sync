/**
 * The credential screen, against workspace-shaped content.
 *
 * The home-screen behaviour is covered by `core.test.mjs`. This file covers what
 * the workspace layer newly exposes it to: real research and scripting files,
 * where a credential can appear inside a `.py`, `.md`, `.json` or `.yml` under
 * `workspace/`, and where a false positive is expensive because it blocks every
 * push.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockingFindings, screenContent, screenFiles } from '../lib/core/guard.js';

/**
 * @param {string} text - file content.
 * @param {string} [rel] - the snapshot path.
 * @returns {ReturnType<typeof screenContent>} the findings.
 */
function screen(text, rel = 'workspace/.dsh/config.toml') {
	return screenContent(rel, text);
}

test('a real key under a workspace path blocks the push, and the value is never echoed', () => {
	const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
	const findings = screen(`api_key = "${secret}"\n`);
	const blocks = blockingFindings(findings);
	// It is caught twice on purpose, by two independent rules: the shape of the
	// value, and the name of the key it is assigned to. Either alone would be
	// enough; both firing is the belt-and-braces case.
	assert.equal(blocks.length, 2, `expected two independent catches, got ${JSON.stringify(blocks.map((b) => b.kind))}`);
	assert.deepEqual(blocks.map((b) => b.kind).sort(), ['openai-style-key', 'sensitive-key']);
	assert.ok(blocks.every((block) => block.severity === 'block'));
	// The finding must name the place and never the value.
	const rendered = JSON.stringify(findings);
	assert.equal(rendered.includes(secret), false, 'the matched value must never appear in a finding');
	assert.equal(rendered.includes('sk-proj'), false, 'not even a prefix of it');
});

test('vendor-prefixed tokens are caught by shape, whatever the key is called', () => {
	// The fixtures are ASSEMBLED rather than written out, and that is not
	// fastidiousness: a literal Slack-token-shaped string in this file was caught
	// by GitHub's push protection and blocked the push. It is a genuine catch —
	// the scanner cannot know the token is fake, and neither can any other
	// scanner, including this plugin's. Building the value at run time keeps the
	// repository clean of anything token-shaped while still exercising the rule.
	const slackFixture = `${'xoxb'}-1234567890-abcdefghijklmnop`;
	for (const [kind, text] of [
		['github-token', 'token_value = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"'],
		['github-pat', 'x = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP"'],
		['aws-access-key-id', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE'],
		['google-api-key', 'key = AIzaSyA1234567890abcdefghijklmnopqrstuv'],
		['slack-token', `slack = ${slackFixture}`],
		['private-key-block', '-----BEGIN RSA PRIVATE KEY-----'],
	]) {
		const blocks = blockingFindings(screen(`${text}\n`));
		assert.ok(blocks.length > 0, `${kind} must block`);
		assert.equal(blocks[0].kind, kind, `expected ${kind}, got ${blocks[0].kind}`);
	}
});

test('one line can be caught by two independent rules, and both are reported', () => {
	// Belt and braces: the value's shape and the key's name. Reporting only the
	// first would hide the fact that two rules agree.
	const findings = screen('api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"\n');
	const kinds = findings.map((finding) => finding.kind).sort();
	assert.deepEqual(kinds, ['openai-style-key', 'sensitive-key']);
});

test('a research script that reads a secret from the environment does not block', () => {
	// The realistic false-positive traps: a template placeholder, and the ordinary
	// ways a program reads an environment variable, which a workspace full of
	// research scripts contains constantly. Missing these made the screen block
	// legitimate code, and a screen that cries wolf on `process.env.X` is a screen
	// the user turns off — after which it catches nothing.
	const safe = [
		'api_key: ${env:OPENAI_API_KEY}',
		'apiKey = process.env.OPENAI_API_KEY',
		'api_key = os.environ["OPENAI_API_KEY"]',
		'token = os.environ.get("GH_TOKEN")',
		'secret = os.getenv("MY_SECRET")',
		'password = ENV["PGPASSWORD"]',
		'# Set api_key in your environment before running',
		'password: USE_KEYRING',
		'apiKey: ""',
		'token: PROCESSING_TOKEN',
		'DFT_QE_PSEUDO_DIR: /opt/qe/pseudo',
	];
	for (const line of safe) {
		const blocks = blockingFindings(screen(`${line}\n`));
		assert.equal(blocks.length, 0, `"${line}" must not block, got ${JSON.stringify(blocks)}`);
	}
	// And recognising all of those must not have weakened the screen: a literal is
	// still a literal.
	const literal = blockingFindings(screen('api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"\n'));
	assert.equal(literal.length, 2, 'a real key is still caught by both rules');
});

test('a bare reference to a store warns; a wrapped one blocks conservatively', () => {
	// A bare `vault:`/`keychain:` value is recognised as a reference.
	for (const line of ['api_key: vault:prod/openai', 'secret: keychain:my-secret']) {
		const findings = screen(`${line}\n`);
		assert.deepEqual(blockingFindings(findings), [], `"${line}" is a reference and must not block`);
		assert.ok(findings.some((finding) => finding.kind === 'sensitive-key-reference'));
	}
	// `get_secret("vault:...")` is NOT recognised, because the right-hand side is a
	// call expression rather than a bare reference. It blocks. That is a false
	// positive, and it is recorded here deliberately rather than tuned away: the
	// screen is a net over a workspace the plugin cannot enumerate, and for a net
	// the safe error is to catch too much. The cost is that a user with such a line
	// has to lift the value into a variable the scanner recognises, or keep the
	// file off the workspace allowlist.
	const wrapped = screen('token = get_secret("vault:my-token")\n');
	assert.equal(blockingFindings(wrapped).length, 1, 'a call-expression value blocks, conservatively');
});

test('dependency names that contain sensitive words are not secrets', () => {
	// This exact shape blocked a real push once, per the module docstring.
	const text = [
		"'@deepseek-ai/dsh-credentials': ^0.1.0-rc.6 || ^0.1.5-0",
		'  dsh-credentials-local: 0.1.5-rc.1',
		'"@deepseek-ai/dsh-secret-store": "link:../x"',
	].join('\n');
	assert.deepEqual(blockingFindings(screen(text, 'workspace/package.json')), []);
});

test('an environment-variable NAME as a value warns but does not block', () => {
	const findings = screen('sync_token: DSH_CONFIG_MANAGER_SYNC_TOKEN\n');
	assert.deepEqual(blockingFindings(findings), [], 'a reference must not block');
	assert.ok(findings.some((finding) => finding.severity === 'warn'));
});

test('screening covers every file in a merged file map, workspace included', () => {
	const files = {
		'settings.yaml': 'theme: dark\n',
		'workspace/AGENTS.md': '# notes\n',
		'workspace/.dsh/config.toml': 'x = 1\n',
		// One bad file, deep in the workspace.
		'workspace/notes/scratch.md': 'export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz\n',
	};
	const findings = screenFiles(files);
	const blocks = blockingFindings(findings);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].rel, 'workspace/notes/scratch.md', 'the offending workspace path is named');
	// Blocks are sorted ahead of warnings so a caller showing the first line shows the worst.
	assert.equal(findings[0].severity, 'block');
});

test('a commented-out key is not treated as a live secret', () => {
	const findings = screen('# api_key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"\n');
	assert.deepEqual(blockingFindings(findings), [], 'a commented line is not a secret in use');
});

test('a JWT is caught wherever it appears', () => {
	const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
	const blocks = blockingFindings(screen(`const t = "${jwt}";\n`));
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].kind, 'jwt');
	assert.equal(JSON.stringify(blocks).includes('dozjgNry'), false, 'the token body must not be echoed');
});

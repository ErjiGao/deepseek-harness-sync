/**
 * Refuse to publish credentials, and refuse to publish to a public repository.
 *
 * Two independent risks are handled here:
 *
 * 1. **Content.** `settings.yaml` is not inherently safe. The settings service
 *    supports `role('secret')` fields and ships a consumer that declares one
 *    (`dsh-web-search-deepseek` declares `apiKey`), and the file-backed provider
 *    has no `${env:VAR}` indirection — so a key typed into the UI lands in the
 *    document in plaintext. Screening is therefore by look *and* by shape.
 * 2. **Destination.** A configuration repository that is public publishes the
 *    user's machine paths, plugin list and settings to the world. The check
 *    fails closed whenever it can be performed.
 *
 * @module deepseek-harness-sync/core/guard
 */

/**
 * Credential material that is unambiguous, so a match is always a hard stop.
 * Each pattern is anchored on a vendor prefix rather than on a generic word,
 * which keeps false positives at zero.
 */
const CREDENTIAL_PATTERNS = [
	{ kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
	{ kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
	{ kind: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	{ kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
	{ kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{ kind: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Key names that suggest a value is a secret rather than a reference to one. */
const SENSITIVE_KEY = /^(.*[_.\-])?(api[_.\-]?key|apikey|secret|token|password|passwd|credential|credentials|private[_.\-]?key|access[_.\-]?key|auth[_.\-]?token)s?$/i;

/** A `key: value` or `"key": "value"` line, tolerant of YAML and JSON. */
const KEY_VALUE_LINE = /^\s*["']?([A-Za-z0-9_.\-[\]@/]+)["']?\s*[:=]\s*(.*)$/;

/**
 * Strip a trailing YAML/JSON comment and surrounding quotes from a value.
 *
 * @param {string} raw - the raw right-hand side.
 * @returns {string} the bare value.
 */
function bareValue(raw) {
	let value = raw.trim().replace(/,\s*$/, '').trim();
	if (value.startsWith('"') || value.startsWith("'")) {
		const quote = value[0];
		const end = value.indexOf(quote, 1);
		value = end === -1 ? value.slice(1) : value.slice(1, end);
	} else {
		const hash = value.search(/\s#/);
		if (hash !== -1) value = value.slice(0, hash);
	}
	return value.trim();
}

/**
 * Whether a value is a dependency specifier or a version range.
 *
 * `pnpm-lock.yaml` and `package.json` are full of lines like
 * `'@deepseek-ai/dsh-credentials': ^0.1.0-rc.6 || ^0.1.5-0`, where the key reads
 * as sensitive and the value is a range. Measured on a real installation, that
 * was a false positive serious enough to block every push, so specifiers are
 * recognised explicitly.
 *
 * @param {string} value - the bare value.
 * @returns {boolean} true when the value is a specifier, not a secret.
 */
function looksLikeSpecifier(value) {
	if (/^(workspace|link|file|catalog|portal|patch|npm|git|github|https?):/i.test(value)) return true;
	// A leading range operator or a bare version, e.g. `^0.1.0-rc.6`, `1.2.3`, `>=2`.
	return /^[\^~>=<v\s]*\d/.test(value);
}

/**
 * Whether a value looks like an environment-variable reference rather than a secret.
 *
 * `DSH_CONFIG_MANAGER_SYNC_TOKEN` and `${env:FOO}` name a secret; they are not one.
 *
 * @param {string} value - the bare value.
 * @returns {boolean} true when the value is a reference.
 */
function looksLikeReference(value) {
	if (value === '') return true;
	if (/^\$\{.*\}$/.test(value)) return true;
	if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) return true;
	if (/^(env|file|secret|vault|keychain|keyring)[:.]/i.test(value)) return true;
	return false;
}

/**
 * Screen one file's text for credential material.
 *
 * @param {string} rel - harness-relative path, for messages.
 * @param {string} text - verbatim file content.
 * @returns {{severity: 'block'|'warn', rel: string, line?: number, kind: string, message: string}[]} findings.
 */
export function screenContent(rel, text) {
	/** @type {{severity: 'block'|'warn', rel: string, line?: number, kind: string, message: string}[]} */
	const findings = [];
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trimStart().startsWith('#')) continue;
		for (const { kind, re } of CREDENTIAL_PATTERNS) {
			if (re.test(line)) {
				findings.push({
					severity: 'block',
					rel,
					line: index + 1,
					kind,
					// The match itself is never echoed: it would put the secret in a
					// terminal, a log, or a model transcript.
					message: `line ${index + 1} contains what looks like a ${kind} (value not shown)`,
				});
			}
		}
		const match = KEY_VALUE_LINE.exec(line);
		if (match === null || !SENSITIVE_KEY.test(match[1])) continue;
		// A key containing `@` or `/` is a package name, not a configuration leaf:
		// a dependency called `dsh-credentials` is not a credential.
		if (match[1].includes('@') || match[1].includes('/')) continue;
		const value = bareValue(match[2]);
		if (looksLikeReference(value) || looksLikeSpecifier(value)) {
			if (value !== '') {
				findings.push({
					severity: 'warn',
					rel,
					line: index + 1,
					kind: 'sensitive-key-reference',
					message: `line ${index + 1} sets "${match[1]}" to a name or reference rather than a literal; fine as long as the value is never inlined`,
				});
			}
			continue;
		}
		findings.push({
			severity: 'block',
			rel,
			line: index + 1,
			kind: 'sensitive-key',
			message: `line ${index + 1} sets "${match[1]}" to what looks like a literal secret (value not shown)`,
		});
	}
	return findings;
}

/**
 * Screen every file in a snapshot.
 *
 * @param {Record<string, string>} files - the snapshot's file map.
 * @returns {{severity: 'block'|'warn', rel: string, line?: number, kind: string, message: string}[]} findings, blocks first.
 */
export function screenFiles(files) {
	/** @type {{severity: 'block'|'warn', rel: string, line?: number, kind: string, message: string}[]} */
	const findings = [];
	for (const rel of Object.keys(files).sort()) findings.push(...screenContent(rel, files[rel]));
	return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
}

/**
 * The findings that must stop a push.
 *
 * @param {{severity: string}[]} findings - all findings.
 * @returns {{severity: string}[]} the blocking subset.
 */
export function blockingFindings(findings) {
	return findings.filter((finding) => finding.severity === 'block');
}

/**
 * Confirm a repository is private, using the GitHub API.
 *
 * Returns `{checked: false}` when no token is available: the API cannot be
 * queried with a credential helper alone, and inventing a verdict would be
 * worse than admitting the check did not run. Callers surface that as a loud
 * warning instead of a silent pass.
 *
 * @param {{owner: string, repo: string, token?: string, fetchImpl?: typeof fetch}} options - the repository and credential.
 * @returns {Promise<{checked: boolean, private?: boolean, status?: number, message: string}>} the verdict.
 */
export async function checkRepoPrivate(options) {
	const { owner, repo, token, fetchImpl = globalThis.fetch } = options;
	if (typeof token !== 'string' || token === '') {
		return {
			checked: false,
			message: 'no token available, so the repository could not be confirmed private — verify it yourself in GitHub → Settings → General → Danger Zone',
		};
	}
	if (typeof fetchImpl !== 'function') {
		return { checked: false, message: 'this Node build has no fetch, so the private check could not run' };
	}
	const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'deepseek-harness-sync',
		},
	});
	if (response.status === 404) {
		return { checked: true, private: undefined, status: 404, message: `${owner}/${repo} is not visible to this token — it is either private and inaccessible, or it does not exist` };
	}
	if (!response.ok) {
		return { checked: true, private: undefined, status: response.status, message: `GitHub API returned ${response.status} for ${owner}/${repo}` };
	}
	const body = await response.json();
	return {
		checked: true,
		private: body.private === true,
		status: response.status,
		message: body.private === true ? `${owner}/${repo} is private` : `${owner}/${repo} is PUBLIC — refusing to sync configuration into a public repository`,
	};
}

/**
 * Render findings for a terminal or a tool result.
 *
 * @param {{severity: string, rel: string, message: string}[]} findings - findings to render.
 * @returns {string} one line per finding.
 */
export function formatFindings(findings) {
	return findings.map((finding) => `${finding.severity === 'block' ? 'BLOCK' : 'warn '}  ${finding.rel}: ${finding.message}`).join('\n');
}

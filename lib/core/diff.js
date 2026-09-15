/**
 * A small line-level difference renderer.
 *
 * Configuration files here are kilobytes, not megabytes, so trimming the common
 * prefix and suffix and showing the remainder is both correct and far simpler
 * than a general-purpose diff algorithm — and it reads well in a terminal and in
 * a model tool result.
 *
 * @module deepseek-harness-sync/core/diff
 */

/** Lines shown after the output is capped. */
const DEFAULT_MAX_LINES = 200;

/**
 * Split text into lines, treating a trailing newline as a terminator not a line.
 *
 * @param {string} text - the text.
 * @returns {string[]} the lines.
 */
export function toLines(text) {
	if (text === '') return [];
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Describe the difference between two texts.
 *
 * @param {string} before - the older text.
 * @param {string} after - the newer text.
 * @returns {{equal: boolean, prefix: number, removed: string[], added: string[], suffix: number}} the difference.
 */
export function compareText(before, after) {
	if (before === after) return { equal: true, prefix: 0, removed: [], added: [], suffix: 0 };
	const a = toLines(before);
	const b = toLines(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix += 1;
	}
	return {
		equal: false,
		prefix,
		removed: a.slice(prefix, a.length - suffix),
		added: b.slice(prefix, b.length - suffix),
		suffix,
	};
}

/**
 * Render a readable difference for one file.
 *
 * @param {string} rel - harness-relative path.
 * @param {string|undefined} before - the local text, or undefined when the file is absent.
 * @param {string|undefined} after - the remote text, or undefined when the file is absent.
 * @param {{maxLines?: number}} [options] - rendering options.
 * @returns {string} the rendered difference.
 */
export function renderDiff(rel, before, after, options = {}) {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	if (before === after) return `${rel}: identical`;
	if (before === undefined) return `${rel}: only on the remote (${toLines(after ?? '').length} lines)`;
	if (after === undefined) return `${rel}: only on this device (${toLines(before).length} lines)`;
	const comparison = compareText(before, after);
	if (comparison.equal) return `${rel}: identical`;
	const out = [`${rel}:`, `  @@ after ${comparison.prefix} unchanged line(s) @@`];
	const removed = comparison.removed.slice(0, maxLines);
	const added = comparison.added.slice(0, maxLines);
	for (const line of removed) out.push(`  - ${line}`);
	for (const line of added) out.push(`  + ${line}`);
	const elided = comparison.removed.length - removed.length + (comparison.added.length - added.length);
	if (elided > 0) out.push(`  … ${elided} further line(s) not shown`);
	if (comparison.suffix > 0) out.push(`  (${comparison.suffix} unchanged line(s) follow)`);
	return out.join('\n');
}

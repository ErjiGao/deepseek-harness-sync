/**
 * Terminal output helpers.
 *
 * Colour is applied only when the destination is a TTY and `NO_COLOR` is unset,
 * so piping output to a file, a tool result, or a log stays clean.
 *
 * @module deepseek-harness-sync/ui
 */

const CODES = {
	reset: 0,
	bold: 1,
	dim: 2,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
};

/**
 * Decide whether to colour a stream.
 *
 * @param {{isTTY?: boolean}} stream - the target stream.
 * @param {NodeJS.ProcessEnv} [env] - environment to consult.
 * @returns {boolean} true when colour should be used.
 */
export function autoColor(stream, env = process.env) {
	if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
	return stream.isTTY === true;
}

/**
 * A tiny output facade shared by the CLI and the plugin tools.
 */
export class Ui {
	/**
	 * @param {{color?: boolean, out?: {write: (text: string) => unknown}, err?: {write: (text: string) => unknown}, env?: NodeJS.ProcessEnv}} [options] - output options.
	 */
	constructor(options = {}) {
		this.out = options.out ?? process.stdout;
		this.err = options.err ?? process.stderr;
		this.color = options.color ?? autoColor(/** @type {{isTTY?: boolean}} */ (this.out), options.env);
	}

	/**
	 * Wrap text in an ANSI code when colour is on.
	 *
	 * @param {keyof typeof CODES} name - the code name.
	 * @param {string} text - the text.
	 * @returns {string} the painted text.
	 */
	paint(name, text) {
		if (!this.color) return text;
		return `\u001B[${CODES[name]}m${text}\u001B[${CODES.reset}m`;
	}

	/** @param {string} text @returns {void} */
	write(text = '') {
		this.out.write(`${text}\n`);
	}

	/** @param {string} text @returns {void} */
	writeError(text = '') {
		this.err.write(`${text}\n`);
	}

	/** @param {string} text @returns {void} */
	head(text) {
		this.write(this.paint('bold', text));
	}

	/** @param {string} text @returns {void} */
	dim(text) {
		this.write(this.paint('dim', text));
	}

	/** @param {string} text @returns {void} */
	ok(text) {
		this.write(`${this.paint('green', 'OK')}    ${text}`);
	}

	/** @param {string} text @returns {void} */
	warn(text) {
		this.write(`${this.paint('yellow', 'WARN')}  ${text}`);
	}

	/** @param {string} text @returns {void} */
	fail(text) {
		this.writeError(`${this.paint('red', 'ERROR')} ${text}`);
	}

	/**
	 * Print an aligned label/value pair.
	 *
	 * @param {string} label - the label.
	 * @param {string} value - the value.
	 * @param {number} [width] - label column width.
	 * @returns {void}
	 */
	kv(label, value, width = 24) {
		this.write(`  ${`${label}:`.padEnd(width)}${value}`);
	}
}

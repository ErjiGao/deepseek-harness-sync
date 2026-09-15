#!/usr/bin/env node
/**
 * The `harness-sync` command-line entry point.
 *
 * This binary is deliberately standalone: it does not need DeepSeek Harness to
 * be running, and it does not import anything from the harness. The DSH plugin
 * in `lib/index.js` shares the same core, so both front doors behave identically.
 *
 * @module deepseek-harness-sync/bin
 */

import { dispatch } from '../lib/run.js';

try {
	process.exitCode = await dispatch(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`harness-sync: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Resolver for running src/cli under vite-node: no app plugins, WASM modules loaded from disk.
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	root: here('../..'),
	logLevel: 'warn',
	resolve: {
		alias: [
			{ find: /^\/wasm\/dsp\/browsdr_dsp\.js$/, replacement: here('./dsp-shim.mjs') },
			{ find: /^\/wasm\/rtl433\/rtl433\.js$/, replacement: here('./rtl433-shim.mjs') },
			{ find: /^@\//, replacement: here('../../src/client/') },
		],
	},
});

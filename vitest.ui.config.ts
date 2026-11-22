import { sourceAlias } from './source-alias.mjs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: { alias: { ...sourceAlias, vue: 'vue/dist/vue.esm-bundler.js' } },
	test: {
		name: 'ui',
		environment: 'jsdom',
		include: ['test/ui/**/*.spec.ts'],
		setupFiles: ['test/ui/helpers/locale.ts'],
		// Node 25 and later define their own localStorage global, undefined without --localstorage-file, and it hides
		// jsdom's. Turning Node's Web Storage off lets the tests use jsdom's storage on every Node version.
		poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] }, threads: { execArgv: ['--no-experimental-webstorage'] } },
	},
});

import { sourceAlias } from './source-alias.mjs';
import { defineConfig, build, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';

// Plugin that runs after the main build to:
// 1. Check that every worker was bundled by Vite (an unbundled one keeps a name that ignores its content)
// 2. Bundle the whisper-worker, which is loaded by a plain URL
// 3. Copy WASM files to dist
function postBuildPlugin(): Plugin {
	return {
		name: 'post-build',
		async closeBundle() {
			const distDir = path.resolve(__dirname, 'dist');
			const assetsDir = path.join(distDir, 'assets');

			// Workers created as `new Worker(new URL('./x.ts', import.meta.url), ...)` are bundled by Vite and named
			// after their whole content. Any other form copies the .ts source as a plain asset named after that file
			// alone: the service worker would then keep serving an old worker after an update.
			const raw = fs.readdirSync(assetsDir).filter((file) => file.endsWith('.ts'));
			if (raw.length) {
				throw new Error(
					`Unbundled worker source in the build: ${raw.join(', ')}. Create workers with ` +
						"`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` so that Vite bundles them.",
				);
			}

			// --- Bundle whisper-worker (loaded via plain URL, not Vite worker syntax) ---
			const whisperEntry = path.resolve(__dirname, 'src/client/transcription/whisper-worker.ts');
			if (fs.existsSync(whisperEntry)) {
				console.log('[post-build] Bundling whisper-worker');
				await build({
					resolve: { alias: sourceAlias },
					configFile: false,
					root: path.resolve(__dirname, 'src/client'),
					build: {
						outDir: distDir,
						emptyOutDir: false,
						lib: {
							entry: whisperEntry,
							formats: ['es'],
							fileName: () => 'whisper-worker.js',
						},
						rollupOptions: {
							external: [
								/^https?:\/\//, // CDN imports stay external
							],
						},
						minify: true,
					},
					logLevel: 'warn',
				});
			}

			// --- Copy WASM files ---
			copyDecoderAssets(distDir);
		},
	};
}

export default defineConfig({
	root: 'src/client',
	build: {
		outDir: path.resolve(__dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			external: [/^\/wasm\//],
		},
	},
	worker: {
		format: 'es',
		rollupOptions: {
			external: [/^\/wasm\//],
		},
	},
	plugins: [
		wasmAssetsPlugin(),
		VitePWA({
			registerType: 'autoUpdate',
			injectRegister: 'script',
			workbox: {
				skipWaiting: true,
				clientsClaim: true,
				globPatterns: ['**/*.{js,css,html,wasm}'],
				navigateFallback: null,
				runtimeCaching: [
					{
						// API routes: network-first (only works online)
						urlPattern: /^.*\/api\/.*/i,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api-cache',
							networkTimeoutSeconds: 5,
							expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 },
						},
					},
				],
			},
			manifest: {
				name: 'BrowSDR – Web SDR Receiver',
				short_name: 'BrowSDR',
				description: 'A blazing-fast browser-based Software Defined Radio receiver.',
				theme_color: '#0f0f1a',
				background_color: '#0f0f1a',
				display: 'standalone',
				start_url: '/',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
				],
			},
		}),
		postBuildPlugin(),
	],
	publicDir: path.resolve(__dirname, 'public'),
	define: {
		__VUE_OPTIONS_API__: true,
		__VUE_PROD_DEVTOOLS__: false,
		__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
	},
	resolve: {
		alias: {
			...sourceAlias,
			vue: 'vue/dist/vue.esm-bundler.js',
		},
	},
	server: {
		proxy: {
			'/api': 'http://localhost:8787',
			'/hf-proxy': 'http://localhost:8787',
		},
	},
});

const wasmAssets = {
	dsp: ['browsdr_dsp.js', 'browsdr_dsp_bg.wasm'],
	mbelib: ['mbelib.js', 'mbelib.wasm', 'COPYRIGHT', 'NOTICE'],
	meteor: ['meteor.js', 'meteor.wasm', 'LICENSE', 'NOTICE'],
	rtl433: ['rtl433.js', 'rtl433.wasm', 'COPYING', 'NOTICE'],
	nrsc5: ['nrsc5.js', 'nrsc5.wasm', 'LICENSE-nrsc5', 'COPYING-faad2', 'COPYING-fftw', 'COPYING.GPL3', 'NOTICE'],
	faad2: ['faad.js', 'faad.wasm', 'COPYING-faad2', 'NOTICE'],
	codec2: ['codec2.js', 'codec2.wasm', 'COPYING'],
};

function copyDecoderAssets(distDir: string) {
	for (const [module, files] of Object.entries(wasmAssets)) {
		const source = path.resolve(__dirname, 'wasm', module, 'pkg');
		const destination = path.resolve(distDir, 'wasm', module);
		fs.mkdirSync(destination, { recursive: true });
		for (const file of files) {
			if (!fs.existsSync(path.join(source, file))) {
				throw new Error(`Missing ${module} asset: ${file}. Restore wasm/${module}/pkg or run npm run build:${module}.`);
			}
			fs.copyFileSync(path.join(source, file), path.join(destination, file));
		}
	}
}

/** Serve the committed bundles unchanged, including dynamically loaded codecs. */
function wasmAssetsPlugin(): Plugin {
	return {
		name: 'wasm-assets',
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
				const match = /^\/wasm\/(dsp|mbelib|meteor|rtl433|nrsc5|faad2|codec2)\/([^/]+)$/.exec(pathname);
				if (!match) return next();
				const module = match[1] as keyof typeof wasmAssets;
				const file = match[2];
				if (!wasmAssets[module].includes(file)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				const source = path.resolve(__dirname, 'wasm', module, 'pkg', file);
				if (!fs.existsSync(source)) {
					response.statusCode = 404;
					response.end();
					return;
				}
				response.setHeader(
					'Content-Type',
					file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'text/javascript' : 'text/plain',
				);
				response.end(fs.readFileSync(source));
			});
		},
	};
}

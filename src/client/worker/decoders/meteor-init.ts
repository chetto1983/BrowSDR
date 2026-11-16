import type { MeteorChannelIndex, MeteorDecoder, MeteorFactory, MeteorModule } from './meteor/types';
import { isRecord } from '@/platform/data';

/*
 * Loads meteor_decode (wasm/meteor). Its C state is global to a module instance, so every Meteor VFO
 * gets an instance of its own. The browser imports /wasm/meteor/meteor.js; Node hosts (browsdr-cli,
 * tests) hand in a factory that reads the committed pkg/ from disk.
 */

let providedFactory: MeteorFactory | null = null;

/** Lets a Node host supply the module factory, since there is no /wasm/ origin to import from. */
export function provideMeteorFactory(factory: MeteorFactory): void {
	providedFactory = factory;
}

async function browserFactory(): Promise<MeteorFactory> {
	const url = new URL('/wasm/meteor/meteor.js', location.origin).href;
	const loaded: unknown = await import(/* @vite-ignore */ url);
	if (!isRecord(loaded) || typeof loaded.default !== 'function') throw new Error('meteor.js did not produce a factory');
	return loaded.default as MeteorFactory;
}

function wrap(module: MeteorModule): MeteorDecoder {
	const inputSize = module._meteor_input_size();
	const width = module._meteor_width();
	return {
		push(symbols) {
			let rows = 0;
			for (let at = 0; at < symbols.length; at += inputSize) {
				const block = symbols.subarray(at, at + inputSize);
				module.HEAP8.set(block, module._meteor_input());
				const added = module._meteor_push(block.length);
				if (added < 0) throw new Error('meteor_decode rejected a symbol block');
				rows += added;
			}
			return rows;
		},
		rows: () => module._meteor_rows(),
		width: () => width,
		channel(index: MeteorChannelIndex) {
			const pointer = module._meteor_channel(index);
			return pointer ? module.HEAPU8.subarray(pointer, pointer + module._meteor_rows() * width) : new Uint8Array(0);
		},
		apid: (index: MeteorChannelIndex) => module._meteor_apid(index),
		stats: () => ({
			rs: module._meteor_rs(),
			vit: module._meteor_vit(),
			vcduSeq: module._meteor_vcdu_seq() >>> 0,
			mpdus: module._meteor_mpdus(),
		}),
		reset: () => module._meteor_reset(),
	};
}

/** A fresh, initialised meteor_decode instance. */
export async function createMeteorDecoder(factory?: MeteorFactory): Promise<MeteorDecoder> {
	const create = factory ?? providedFactory ?? (await browserFactory());
	const module = await create({ locateFile: (path) => '/wasm/meteor/' + path });
	module._meteor_init();
	return wrap(module);
}

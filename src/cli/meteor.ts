import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MeteorImage } from '@/app/decoders/meteor/image';
import type { MeteorFactory } from '@/worker/decoders/meteor/types';
import { provideMeteorFactory } from '@/worker/decoders/meteor-init';
import { isRecord } from '@/platform/data';
import { encodePng } from './png';

/** The committed meteor_decode build, read from disk (there is no /wasm/ origin under Node). */
export async function registerMeteorWasm(): Promise<void> {
	const pkg = (file: string) => fileURLToPath(new URL(`../../wasm/meteor/pkg/${file}`, import.meta.url));
	const loaded: unknown = await import(/* @vite-ignore */ new URL('../../wasm/meteor/pkg/meteor.js', import.meta.url).href);
	if (!isRecord(loaded) || typeof loaded.default !== 'function') throw new Error('wasm/meteor/pkg/meteor.js did not load');
	const factory = loaded.default as MeteorFactory;
	provideMeteorFactory((options) => factory({ ...options, locateFile: pkg }));
}

/** Writes the colour composite as meteor-<UTC yyyymmdd-hhmm>.png in `dir`; returns the path, or null when empty. */
export function writeMeteorPng(image: MeteorImage, dir: string, at: Date, prefix = 'meteor'): string | null {
	if (!image.rows) return null;
	const rgba = image.rgba('rgb');
	const rgb = new Uint8Array(image.rows * image.width * 3);
	for (let p = 0, o = 0; o < rgb.length; p += 4, o += 3) rgb.set(rgba.subarray(p, p + 3), o);
	mkdirSync(dir, { recursive: true });
	const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
	const path = join(dir, `${prefix}-${stamp}.png`);
	writeFileSync(path, encodePng(image.width, image.rows, rgb));
	return path;
}

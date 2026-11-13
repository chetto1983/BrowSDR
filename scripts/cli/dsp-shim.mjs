// Node stand-in for '/wasm/dsp/browsdr_dsp.js': the committed web build, initialised from disk.
import { readFileSync } from 'node:fs';
import * as dsp from '../../wasm/dsp/pkg/browsdr_dsp.js';

const wasm = dsp.initSync({ module: readFileSync(new URL('../../wasm/dsp/pkg/browsdr_dsp_bg.wasm', import.meta.url)) });

export * from '../../wasm/dsp/pkg/browsdr_dsp.js';
export default async function init() {
	return wasm;
}

// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR from OnAir tests/nxdn/test_nxdn_rx.cpp and tests/nxdn/test_nxdn_sens.cpp,
// https://github.com/adswill/OnAir; see third_party/onair.
// Changes: the generated signal goes through BrowSDR's DSD stream at 48 kHz instead of OnAir's NxdnReceiver (NXDN48 by
// the 2400 symbols/s receiver, NXDN96 by the 4800 symbols/s chain), and the transmissions are found in the stream's
// status reports instead of a call log; the voice that reached mbelib is compared with what was sent; the off-centre
// dial cases are left out (BrowSDR's DDC centres the channel); the sensitivity runs the schedule once.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ambeFrame } from '@/worker/decoders/dsd/ambe';
import { DSDStream } from '@/worker/decoders/dsd/dsd-stream';
import { noiseIq } from '../voice-fixtures.js';
import { nxdnSignal, nxdnTestSchedule, tx } from './fixtures.js';

const codec = vi.hoisted(() => ({ frames: [] }));
vi.mock('@/worker/decoders/mbelib-init', () => ({
	ensureMbelibInitialized: async () => {},
	decodeAmbe: (frame) => {
		codec.frames.push(Array.from(frame).join(''));
		return new Float32Array(160);
	},
	decodeAmbe2400: () => new Float32Array(160),
	decodeImbe: () => new Float32Array(160),
	resetMbe: () => {},
	getMbeErrors: () => 0,
}));

beforeEach(() => {
	codec.frames.length = 0;
});

async function run(iq, chunk = 1920) {
	const statuses = [];
	const stream = new DSDStream((status) => statuses.push(status));
	await stream.decoder.mbeInitPromise;
	for (let i = 0; i < iq.length; i += chunk) stream.process(iq.subarray(i, i + chunk));
	for (let i = 0; i < 20; i++) stream.process(new Float32Array(1920)); // the end of the last call
	return { statuses, seen: statuses.filter((s) => s.nxdn).map((s) => s.nxdn) };
}

const find = (seen, kind, src) => seen.filter((s) => s.kind === kind && s.src === src).at(-1);

function schedule({ baud = 0, late = false, noRel = false } = {}) {
	return nxdnTestSchedule()
		.filter((t) => !baud || t.baud === baud)
		.map((t) => (t.kind === 'voice' ? { ...t, noHeader: late, noRelease: noRel } : t));
}

const CASES = [
	['clean', {}],
	['NXDN48 +1 kHz', { baud: 2400, cfoHz: 1000 }],
	['NXDN48 -1 kHz', { baud: 2400, cfoHz: -1000 }],
	['NXDN96 +1 kHz', { baud: 4800, cfoHz: 1000 }],
	['NXDN96 -1 kHz', { baud: 4800, cfoHz: -1000 }],
	['+150 ppm clock', { ppm: 150 }],
	['-150 ppm clock', { ppm: -150 }],
	['16 dB noise', { cnrDb: 16 }],
	['1 % symbol errors', { symErrRate: 0.01 }],
	['joined late, no release', { late: true, noRel: true }],
	['all at once', { cfoHz: -800, ppm: 100, cnrDb: 18, symErrRate: 0.005, late: true }],
];

describe('NXDN through the DSD stream (OnAir test_nxdn_rx)', () => {
	it.each(CASES)('%s: calls, status, short data and the site', async (_name, k) => {
		const { baud = 0, late = false, noRel = false, cnrDb = 40, ...impair } = k;
		const { iq, voice } = nxdnSignal(schedule({ baud, late, noRel }), { cnrDb, ...impair });
		const { seen } = await run(iq);
		if (baud !== 4800) {
			expect(find(seen, 'voice', 1001)).toMatchObject({
				dst: 200,
				callType: 'group',
				ran: 1,
				baud: 2400,
				endSeen: !noRel,
				lateEntry: late,
			});
			expect(find(seen, 'status', 1002)).toMatchObject({ dst: 1001, text: 'status 17', callType: 'individual' });
		}
		if (baud !== 2400) {
			expect(find(seen, 'voice', 2001)).toMatchObject({ dst: 2002, callType: 'individual', baud: 4800 });
			// A clock error of -150 ppm: the 4800 symbols/s chain's clock recovery may still be settling on the first frames
			// of the three-frame short data call, whose header is then lost.
			if (impair.ppm !== -150) expect(find(seen, 'data', 2005)).toMatchObject({ dst: 2001, text: 'HELLO FROM NXDN96' });
			expect(seen.at(-1).site).toMatchObject({ location: 0x0a4c2b, ran: 5 });
		}
		// The voice frames: all of them when the channel is clean.
		if (!impair.symErrRate && cnrDb >= 30) {
			const sent = new Set(voice.map((v) => ambeFrame(v).join('')));
			const known = codec.frames.filter((f) => sent.has(f)).length;
			expect(codec.frames.length - known).toBeLessThanOrEqual(noRel ? 8 : 0);
			expect(known).toBeGreaterThanOrEqual(voice.length - (late ? 16 : 0));
		}
	});

	it('the events: call, release, status, short data and the site', async () => {
		const { seen } = await run(nxdnSignal(schedule(), { cnrDb: 40 }).iq);
		const events = seen.at(-1).events.map((e) => e.text);
		expect(events.some((e) => /^S(ITE|RV)_INFO location 0x0A4C2B \(system 659, site 43\), RAN 5$/.test(e))).toBe(true);
		expect(events).toEqual(
			expect.arrayContaining([
				'VCALL group 1001 → 200',
				'call 1001 → 200 (group), 2.0 s',
				'status 17 from 1002 to 1001',
				'short data 2005 → 2001: HELLO FROM NXDN96',
				'VCALL individual 2001 → 2002',
			]),
		);
	});

	it('an encrypted call is reported and its voice never reaches the codec; a single misparsed cipher is ignored', async () => {
		const txs = [tx({ src: 3001, dst: 300, cipher: 3, durSec: 1 }), tx({ src: 3002, dst: 301, sacchGlitchCipher: 2, durSec: 1.5 })];
		const { seen } = await run(nxdnSignal(txs, { cnrDb: 40 }).iq);
		expect(find(seen, 'voice', 3001)).toMatchObject({ cipher: 3, dst: 300 });
		expect(find(seen, 'voice', 3002)).toMatchObject({ cipher: 0, dst: 301 });
		expect(codec.frames).toHaveLength(80);
	});

	it("NXDN96 with DSD's RDCH sync words still decodes its voice exactly", async () => {
		const t = tx({ baud: 4800, src: 4001, dst: 400, durSec: 1 });
		const { iq, voice } = nxdnSignal([t], { cnrDb: 30, cfoHz: 1000, lich: { rfct: 2, fct: 2, opt: 3, dir: 1 } });
		const { seen, statuses } = await run(iq);
		expect(find(seen, 'voice', 4001)).toMatchObject({ dst: 400, baud: 4800, endSeen: true });
		expect(statuses.some((s) => s.syncName === 'NXDN_BS_VOICE')).toBe(true);
		const sent = new Set(voice.map((v) => ambeFrame(v).join('')));
		expect(codec.frames.filter((f) => sent.has(f)).length).toBe(voice.length);
	});

	it('noise alone gives no sync', async () => {
		const { statuses } = await run(noiseIq(48000 * 6, 0.3, 11));
		expect(statuses.some((s) => s.synced || s.nxdn)).toBe(false);
		expect(codec.frames).toHaveLength(0);
	});
});

describe('NXDN sensitivity (OnAir test_nxdn_sens)', () => {
	const blocks = async (k) => {
		const { seen } = await run(nxdnSignal(schedule({ baud: k.baud }), k).iq);
		return Math.max(0, ...seen.map((s) => s.blocksOk));
	};
	it('NXDN48 in 6.25 kHz: 7 dB decodes nine blocks in ten of 30 dB, 5 dB about half; a 1 kHz offset', async () => {
		const k = { baud: 2400, bandwidthHz: 6250, filterHz: 3600 };
		const ref = await blocks({ ...k, cnrDb: 30 });
		const a = await blocks({ ...k, cnrDb: 7, seed: 21 });
		const b = await blocks({ ...k, cnrDb: 5, seed: 22 });
		const c = await blocks({ ...k, cnrDb: 9, cfoHz: 1000, seed: 23 });
		const d = await blocks({ ...k, cnrDb: 9, cfoHz: -1000, seed: 24 });
		console.log(`NXDN48 blocks: 30 dB ${ref}, 7 dB ${a}, 5 dB ${b}, 9 dB +1 kHz ${c}, -1 kHz ${d}`);
		expect(ref).toBeGreaterThanOrEqual(30);
		expect(a).toBeGreaterThanOrEqual(ref * 0.85);
		expect(b).toBeGreaterThanOrEqual(ref * 0.4);
		expect(c).toBeGreaterThanOrEqual(ref * 0.8);
		expect(d).toBeGreaterThanOrEqual(ref * 0.8);
	});
	it('NXDN96 through the 4800 symbols/s chain: 7 dB and 5 dB in 12.5 kHz', async () => {
		const ref = await blocks({ baud: 4800, cnrDb: 30 });
		const a = await blocks({ baud: 4800, cnrDb: 7, seed: 21 });
		const b = await blocks({ baud: 4800, cnrDb: 5, seed: 22 });
		console.log(`NXDN96 blocks: 30 dB ${ref}, 7 dB ${a}, 5 dB ${b}`);
		expect(ref).toBeGreaterThanOrEqual(70);
		expect(a).toBeGreaterThanOrEqual(ref * 0.85);
		expect(b).toBeGreaterThanOrEqual(ref * 0.4);
	});
});

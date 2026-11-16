import { describe, expect, it } from 'vitest';
import { VDL2_RATE, Vdl2Decoder } from '@/worker/decoders/digimode/vdl2';
import { CTRL_XID, avlcFrame, controlI, getAddr, parseFrame, putAddr } from '@/worker/decoders/digimode/vdl2/avlc';
import { headerDecode, headerWord, layout } from '@/worker/decoders/digimode/vdl2/bits';
import { fcs, fcsOk, hdlcFrames } from '@/worker/decoders/digimode/vdl2/burst';
import { rsDecode, rsEncode } from '@/worker/decoders/digimode/vdl2/rs';
import { noise } from './fixtures';
import {
	vdl2AcarsInfo,
	vdl2HdlcBits,
	vdl2Signal,
	vdl2X25CallRequest,
	vdl2X25ClnpData,
	vdl2XidAircraftLe,
	vdl2XidGsif,
} from './vdl2-fixtures';

const ALL = { addr: 0xffffff, type: 7, status: false };
const GS = { addr: 0x10a000, type: 4, status: false };
const AIR = { addr: 0x4a1234, type: 1, status: false };
const AIR_RESPONSE = { ...AIR, status: true };

const gsif = () => avlcFrame(ALL, GS, CTRL_XID, vdl2XidGsif(51.47, -0.45, 'EGLL EGKK'));
const acarsDown = (text = '#DFB/FUEL 145/ETA 1230 WX REQ EGLL') =>
	avlcFrame(GS, AIR, controlI(2, 1, false), vdl2AcarsInfo('G-EUUA', 'H1', '3', `M07ABA0117${text}`));
const SRC_NSAP = [0x47, 0x00, 0x27, 0x81, 0x41, 0x43, 0x41, 0, 0, 0, 0, 0, 0, 0x4a, 0x12, 0x34, 0, 0, 0, 0x01];
const DST_NSAP = [0x47, 0x00, 0x27, 0x41, 0x47, 0x42, 0x52, 0, 0, 0, 0, 0, 0, 0x10, 0xa0, 0x00, 0, 0, 0, 0x21];
const atnData = () =>
	avlcFrame(GS, AIR, controlI(3, 1, false), vdl2X25ClnpData(1, 3, 1, SRC_NSAP, DST_NSAP, [0xa1, 0x02, 0x03, 0x04, 0x05, 0x06]));
/** An RR acknowledgement and an ACARS block in one burst. */
const ackAndAcars = () => [
	avlcFrame(GS, AIR_RESPONSE, 0x01 | (1 << 5), []),
	avlcFrame(GS, AIR, controlI(4, 1, false), vdl2AcarsInfo('G-EUUA', 'H1', '4', 'M08ABA0117#DFB/STATUS OK')),
];

/** Runs the decoder over `iq` in blocks of `block` samples, or of random sizes (1 - 20000) when `block` is a seed function. */
function receive(iq, block = 4096) {
	const records = [];
	const statuses = [];
	const decoder = new Vdl2Decoder({ record: (r) => records.push(r), status: (message, locked) => statuses.push({ message, locked }) });
	for (let i = 0; i < iq.length;) {
		const n = 2 * (typeof block === 'function' ? 1 + Math.floor((block() + 0.5) * 20000) : block);
		decoder.process(iq.subarray(i, Math.min(iq.length, i + n)));
		i += n;
	}
	return { records, statuses };
}

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('VDL Mode 2 bit layer', () => {
	it('has the X.25 frame check sequence and its residue', () => {
		const text = Uint8Array.from('123456789', (c) => c.charCodeAt(0));
		expect(fcs(text)).toBe(0x906e);
		const frame = Uint8Array.from([...text, 0x6e, 0x90]);
		expect(fcsOk(frame)).toBe(true);
		frame[2] ^= 4;
		expect(fcsOk(frame)).toBe(false);
	});
	it('codes the burst header and corrects one bit of it', () => {
		for (const len of [1, 100, 1234, 0x1fff, 0x3fff]) {
			expect(headerDecode(headerWord(len))).toEqual({ ok: true, corrected: false, len });
			expect(headerDecode(headerWord(len) ^ (1 << 12))).toMatchObject({ ok: len <= 0x1fff, corrected: true, len });
		}
		expect(headerDecode(0).ok).toBe(false);
	});
	it('lays out the Reed-Solomon blocks of a burst', () => {
		expect(layout(8 * 300)).toEqual({ dataOct: 300, blocks: 2, lastLen: 51, lastFec: 4, fecOct: 10 });
		expect(layout(8 * 2)).toBeUndefined(); // under three octets: no parity, not a burst
		expect(layout(8 * 249)).toEqual({ dataOct: 249, blocks: 1, lastLen: 249, lastFec: 6, fecOct: 6 });
	});
	it('corrects three octets of a Reed-Solomon block and refuses too many', () => {
		const cw = new Uint8Array(255);
		for (let i = 0; i < 249; i++) cw[i] = (i * 7 + 3) & 0xff;
		cw.set(rsEncode(cw), 249);
		expect(rsDecode(cw.slice(), 6)).toBe(0);
		const bad = cw.slice();
		bad[5] ^= 0x55;
		bad[200] ^= 0x01;
		bad[251] ^= 0xff;
		expect(rsDecode(bad, 6)).toBe(3);
		expect(bad).toEqual(cw);
		const hopeless = cw.slice();
		for (let i = 0; i < 8; i++) hopeless[i * 11] ^= 0xa5;
		const result = rsDecode(hopeless, 6);
		expect(result === -1 || hopeless.some((v, i) => v !== cw[i])).toBe(true);
	});
	it('fills erased parity octets of a short last block', () => {
		const cw = new Uint8Array(255);
		for (let i = 0; i < 40; i++) cw[i] = i + 1;
		const parity = rsEncode(cw);
		cw.set(parity.subarray(0, 4), 249); // a 40-octet last block keeps four parity octets
		cw[7] ^= 0x10;
		expect(rsDecode(cw, 4)).toBe(1);
		expect(cw[7]).toBe(8);
	});
	it('takes frames from between HDLC flags', () => {
		const frames = [Uint8Array.from([0x7f, 0xff, 0x03]), Uint8Array.from([0x7e, 0x7e, 0x01, 0x02])];
		expect(hdlcFrames(Uint8Array.from(vdl2HdlcBits(frames)))).toEqual(frames);
	});
	it('reads AVLC addresses back', () => {
		const a = { addr: 0xabcdef, type: 5, status: true };
		const o = putAddr(a, true);
		expect(o[3] & 1).toBe(1);
		expect(getAddr(o)).toEqual(a);
	});
});

describe('AVLC frames', () => {
	it('reads a ground station information XID', () => {
		const f = gsif();
		const m = parseFrame(f.subarray(0, f.length - 2));
		expect(m).toMatchObject({ frameKind: 'U', frameName: 'GSIF', fromGround: true, proto: 'XID', hasPos: true });
		expect(m.summary).toBe('GSIF (ground station information)');
		expect(m.lat).toBeCloseTo(51.5, 5);
		expect(m.lon).toBeCloseTo(-0.5, 5);
		expect(m.detail).toContainEqual(['Airport coverage', 'EGLL EGKK']);
	});
	it('reads X.25, CLNP and COTP around ATN application data', () => {
		const f = atnData();
		const m = parseFrame(f.subarray(0, f.length - 2));
		expect(m).toMatchObject({ frameKind: 'I', ns: 3, nr: 1, proto: 'COTP' });
		expect(m.summary).toBe('X.25 data, LCN 1, P(S) 3 P(R) 1: CLNP DT, COTP DT, ATN application data');
		expect(m.detail).toContainEqual(['Destination NSAP', '4700274147425200000000000010A00000000021']);
	});
	it("reads an aircraft's link establishment XID", () => {
		const f = avlcFrame(GS, AIR, CTRL_XID | 0x10, vdl2XidAircraftLe(48.35, 11.79, 36000, 'OMDB'));
		const m = parseFrame(f.subarray(0, f.length - 2));
		expect(m).toMatchObject({ frameName: 'XID_CMD_LE', fromAir: true, pf: true, hasAlt: true, altFt: 36000 });
		expect(m.summary).toBe('XID_CMD_LE (link establishment)');
		expect(m.detail).toContainEqual(['Aircraft location', '48.4N 11.8E 36000 ft']);
		expect(m.detail).toContainEqual(['Destination airport', 'OMDB']);
	});
	it('reads an X.25 call request', () => {
		const f = avlcFrame(GS, AIR, controlI(0, 0, false), vdl2X25CallRequest(1, '', ''));
		const m = parseFrame(f.subarray(0, f.length - 2));
		expect(m.summary).toBe('X.25 call request, LCN 1');
		expect(m.detail).toContainEqual(['Call user data', 'C100 (ICAO SNDCF)']);
	});
	it('reads an ACARS uplink', () => {
		const f = avlcFrame(AIR, GS, controlI(0, 3, false), vdl2AcarsInfo('G-EUUA', 'C1', 'B', 'WX EGLL 24012KT 9999 FEW030'));
		const m = parseFrame(f.subarray(0, f.length - 2));
		expect(m.acars).toMatchObject({ reg: 'G-EUUA', label: 'C1', blockId: 'B', downlink: false, flight: '', crcOk: true });
		expect(m.acars.text).toBe('WX EGLL 24012KT 9999 FEW030');
	});
});

describe('VDL Mode 2 receiver', () => {
	it('decodes bursts in noise 350 Hz off tune', () => {
		const iq = vdl2Signal([{ frames: [gsif()] }, { frames: [acarsDown()] }, { frames: [atnData()] }, { frames: ackAndAcars() }], {
			rate: VDL2_RATE,
			offsetHz: 350,
			snrDb: 20,
		});
		const { records, statuses } = receive(iq);
		expect(records.map((r) => r.text)).toEqual([
			'GS 10A000 → all · GSIF (ground station information)',
			'4A1234 (G-EUUA) → GS 10A000 · I · ACARS H1 (Terminal message) BA0117: #DFB/FUEL 145/ETA 1230 WX REQ EGLL',
			'4A1234 → GS 10A000 · I · X.25 data, LCN 1, P(S) 3 P(R) 1: CLNP DT, COTP DT, ATN application data',
			'4A1234 → GS 10A000 · RR N(R) 1',
			'4A1234 (G-EUUA) → GS 10A000 · I · ACARS H1 (Terminal message) BA0117: #DFB/STATUS OK',
		]);
		expect(records.every((r) => !r.damaged)).toBe(true);
		const signal = field(records[0], 'Signal');
		const cfo = Number(/carrier ([+-]\d+) Hz/.exec(signal)[1]);
		expect(Math.abs(cfo - 350)).toBeLessThan(60);
		expect(statuses.at(-1).message).toMatch(/^5 frame\(s\), last at SNR/);
	});
	it('lists the ACARS fields of a downlink', () => {
		const { records } = receive(vdl2Signal([{ frames: [acarsDown()] }], { offsetHz: -420, snrDb: 22, seed: 9 }));
		expect(records).toHaveLength(1);
		const [record] = records;
		expect(field(record, 'Source')).toBe('4A1234 (aircraft)');
		expect(field(record, 'Destination')).toBe('10A000 (ground station (ADM))');
		expect(field(record, 'Frame')).toBe('I frame, N(S) 2, N(R) 1, 64 octets of information');
		expect(field(record, 'Registration')).toBe('G-EUUA');
		expect(field(record, 'Flight')).toBe('BA0117');
		expect(field(record, 'Label')).toBe('H1 (Terminal message)');
		expect(field(record, 'Block id')).toBe('3');
		expect(field(record, 'Message number')).toBe('M07A');
		expect(field(record, 'Sublabel / MFI')).toBe('DF / -');
		expect(field(record, 'Text')).toBe('#DFB/FUEL 145/ETA 1230 WX REQ EGLL');
		expect(field(record, 'Hex')).toBeUndefined();
	});
	it('shows ATN and XID frames as bytes', () => {
		const { records } = receive(vdl2Signal([{ frames: [gsif()] }, { frames: [atnData()] }], { offsetHz: 200, snrDb: 22 }));
		expect(records).toHaveLength(2);
		const info = gsif().subarray(9, -2);
		expect(field(records[0], 'Information')).toBe(`ATN/XID frame, ${info.length} bytes`);
		expect(field(records[0], 'Hex')).toBe([...info].map((b) => b.toString(16).padStart(2, '0')).join(' '));
		expect(field(records[0], 'Ground station location')).toBe('51.5N 0.5W');
		expect(field(records[1], 'Information')).toBe('ATN/XID frame, 63 bytes');
		expect(field(records[1], 'Hex').startsWith('10 01 26 81 33 01 3c 1c')).toBe(true);
	});
	it('lists an ACARS block whose own check failed as damaged', () => {
		const info = vdl2AcarsInfo('G-EUUA', 'H1', '5', 'M09ABA0117#DFB/TEXT');
		info[info.length - 3] ^= 0x40; // a check byte of the ACARS block; the AVLC frame check stays good
		const { records } = receive(vdl2Signal([{ frames: [avlcFrame(GS, AIR, controlI(5, 1, false), info)] }], { snrDb: 25 }));
		expect(records).toHaveLength(1);
		expect(records[0].damaged).toBe(true);
		expect(field(records[0], 'ACARS')).toBe('mode 2, downlink, check sequence FAILED');
		expect(field(records[0], 'Text')).toBe('#DFB/TEXT');
	});
	it('corrects damaged octets with the Reed-Solomon code and rejects a burst beyond it', () => {
		const long = acarsDown('#DFB/' + 'POSITION REPORT FOLLOWS '.repeat(4));
		// burst bits after the training sequence: the 25 header bits, then the data octets column by column
		const fixable = [41, 42, 43, 44, 90, 91]; // two octets
		const hopeless = Array.from({ length: 60 }, (_, i) => 25 + 8 + i); // eight octets in a row
		const iq = vdl2Signal([{ frames: [long], flip: fixable }, { frames: [long], flip: hopeless }, { frames: [gsif()] }], {
			offsetHz: 150,
			snrDb: 30,
		});
		const { records } = receive(iq);
		expect(records.map((r) => r.text.split(' · ').at(-1).slice(0, 20))).toEqual(['ACARS H1 (Terminal m', 'GSIF (ground station']);
		expect(field(records[0], 'FEC')).toBe('2 octet(s) corrected by Reed-Solomon');
	});
	it('decodes most bursts near the threshold (Es/N0 17 dB) and nothing that was not sent', () => {
		// OnAir's receiver test asks for 90 % at 17 dB and 30 % at 15 dB, the decoding threshold
		const text = 'M01AXX0001#DFB/WEAK STATION TEXT ABOUT FORTY CHARACTERS LONG';
		const bursts = Array.from({ length: 30 }, (_, k) => ({
			frames: [
				avlcFrame(GS, { addr: 0x400001 + k, type: 1, status: false }, controlI(k, 0, false), vdl2AcarsInfo('G-WEAK', 'H1', '1', text)),
			],
		}));
		const { records } = receive(vdl2Signal(bursts, { offsetHz: 300, snrDb: 17, seed: 4 }), noise(4));
		expect(records.length).toBeGreaterThanOrEqual(26);
		const sources = records.map((r) => Number.parseInt(r.text.slice(0, 6), 16));
		expect(new Set(sources).size).toBe(records.length);
		expect(sources.every((a) => a >= 0x400001 && a <= 0x40001e)).toBe(true);
		expect(records.every((r) => r.text.endsWith('#DFB/WEAK STATION TEXT ABOUT FORTY CHARACTERS LONG') && !r.damaged)).toBe(true);
	});
	it('finds nothing in noise alone, nor in broken samples', () => {
		const iq = vdl2Signal([], { snrDb: 10, leadSec: 0.5 });
		iq.fill(Number.NaN, 20000, 20200);
		iq.fill(Number.POSITIVE_INFINITY, 30000, 30010);
		const { records, statuses } = receive(iq);
		expect(records).toHaveLength(0);
		expect(statuses.every((s) => !s.locked)).toBe(true);
	});
});

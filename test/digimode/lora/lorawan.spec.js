import { describe, expect, it } from 'vitest';
import { LorawanDecoder, LORAWAN_MODE, LORAWAN_RATE } from '@/worker/decoders/digimode/lorawan';
import { decodeLorawan } from '@/worker/decoders/digimode/lorawan/proto';
import { network } from '@/worker/decoders/digimode/lorawan/names';
import { lorawanPresets } from '@/worker/decoders/digimode/lora/presets';
import { lorawanBuild, lorawanJoinRequest } from './builders';
import { decodeFrames } from './phy';
import { LW_DEVS, LW_EVENTS, MeshScene, lorawanEu, schedule } from './scene';

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('LoRaWAN headers', () => {
	it('reads data frames, MAC commands and the network of a DevAddr', () => {
		const up = decodeLorawan(
			lorawanBuild({
				mtype: 4,
				devAddr: 0x260b1234,
				fcnt: 7,
				fport: 10,
				frm: new Array(11).fill(0x55),
				fopts: [0x06, 0x4f, 0x0a, 0x02],
				mic: 0x55aa55aa,
				adr: true,
				adrAckReq: true,
			}),
		);
		expect(up).toMatchObject({
			ok: true,
			typeName: 'Confirmed up',
			from: '260B1234',
			fcnt: 7,
			fport: 10,
			frmLen: 11,
			devStatusBattery: 0x4f,
			macNames: ['DevStatusAns', 'LinkCheckReq'],
		});
		expect(up.network.name).toBe('The Things Network');
		expect(up.detail).toBe(
			'ADR, ADRACKReq, DevStatusAns, LinkCheckReq, battery 31 %, margin 10 dB, FPort 10, 11 bytes encrypted, MIC 55AA55AA',
		);
		const down = decodeLorawan(
			lorawanBuild({ mtype: 3, devAddr: 0x260b1234, fcnt: 2001, ack: true, fopts: [0x03, 0x51, 0xff, 0x00, 0x01], mic: 0xc001d00d }),
		);
		expect(down).toMatchObject({ ok: true, uplink: false, fport: -1, note: 'no payload' });
		expect(down.macDetail).toBe('DR5, TX power 1, channel mask 0x00FF');
		expect(network(0x48000a31).name).toBe('Helium');
		expect(network(0xfc014c10).name).toBe('Helium');
		expect(network(0x22a1b2c3).name).toBe('Orange');
	});
	it('reads join requests and rejects what is not LoRaWAN', () => {
		const j = decodeLorawan(lorawanJoinRequest(0xa840410000000101n, 0xa84041000181c61an, 0x1234, 0xdeadbeef));
		expect(j).toMatchObject({ ok: true, mtype: 0, from: 'A84041000181C61A', to: 'A840410000000101', vendor: 'Dragino', devNonce: 0x1234 });
		expect(j.detail).toBe('DevEUI A84041000181C61A (Dragino), JoinEUI A840410000000101, DevNonce 4660, MIC DEADBEEF');
		expect(decodeLorawan(Uint8Array.from([0x40, 1, 2, 3]))).toMatchObject({ ok: false, note: 'data frame of 4 bytes (12 at least)' });
		expect(decodeLorawan(Uint8Array.from([0x44, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toMatchObject({
			ok: false,
			note: 'not LoRaWAN R1 (RFU or major bits set)',
		});
		expect(LORAWAN_MODE.sfs).toEqual([7, 8, 9, 10, 11, 12]);
		expect(lorawanPresets(0).filter((p) => p.bwHz === 125000)).toHaveLength(48);
	});

	it('never throws on garbage', () => {
		let x = 7;
		const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
		for (let k = 0; k < 3000; k++) {
			const b = Uint8Array.from({ length: 1 + (k % 64) }, next);
			const w = decodeLorawan(b);
			if (w.ok) expect(w.typeName).not.toBe('');
		}
	});
});

describe('LoRaWAN receiver', () => {
	it("decodes OnAir's end devices at SF7 to SF12 on one 125 kHz channel", () => {
		const scene = new MeshScene(5);
		const frames = schedule(LW_EVENTS, {
			p: (e) => lorawanEu(LW_DEVS[e.dev].sf),
			bytes: (e) => scene.lorawan(e),
			// the weakest device (an SF7 join request) at -4 dB, well above the SF7 limit
			radio: (e) => scene.radio(`lw${e.dev}`, 6 - 2 * e.dev),
			cfoHz: 1200,
			sroPpm: 8,
			scene,
		});
		const { records, ms, seconds } = decodeFrames(LorawanDecoder, frames, { rate: LORAWAN_RATE, bwHz: 125000 });
		console.log(`LoRaWAN: ${seconds.toFixed(1)} s of signal in ${ms.toFixed(0)} ms`);
		for (const r of records) console.log(r.text);
		expect(records.map((r) => field(r, 'Spreading factor'))).toEqual(frames.map((f) => `SF${f.p.sf}`));
		expect(records.every((r) => !r.damaged)).toBe(true);
		expect(records[0].text).toMatch(
			/^Unconfirmed up · 260B1A2C \(The Things Network\) · FCnt 1200 · ADR, FPort 1, 10 bytes encrypted, MIC [0-9A-F]{8}$/,
		);
		expect(records[1].text).toMatch(
			/^Join request · DevEUI A84041000181C61A \(Dragino\), JoinEUI A840410000000101, DevNonce \d+, MIC [0-9A-F]{8}$/,
		);
		expect(field(records[3], 'MAC commands')).toBe('DevStatusAns (battery 79 %, margin 7 dB)');
		expect(field(records[5], 'Network')).toMatch(/^NetID 0x000000|^Experimental/);
	}, 60_000);
	it('finds nothing in noise alone', () => {
		const { records } = decodeFrames(LorawanDecoder, [], { rate: LORAWAN_RATE, bwHz: 125000, durationSec: 4 });
		expect(records).toHaveLength(0);
	});
});

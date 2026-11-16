import { describe, expect, it } from 'vitest';
import { MeshtasticDecoder, MESHTASTIC_MODE, MESHTASTIC_RATE } from '@/worker/decoders/digimode/meshtastic';
import { decodeMeshtastic } from '@/worker/decoders/digimode/meshtastic/proto';
import { channelHash, nodeId } from '@/worker/decoders/digimode/meshtastic/names';
import { MESHTASTIC_DEFAULT_PSK, meshtasticSlotHz } from '@/worker/decoders/digimode/lora/presets';
import { loraParams } from '@/worker/decoders/digimode/lora/code';
import { digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { meshtasticData, meshtasticRaw, meshtasticText } from './builders';
import { decodeFrames } from './phy';
import { MeshScene, MT_EVENTS, MT_LINES, meshtasticLongFast, schedule } from './scene';

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

/** The first `count` events of OnAir's Meshtastic scene as LongFast frames back to back. */
function sceneFrames(count, { strong = 6, weak = -8, cfoHz = 0, sroPpm = 0, seed = 1 } = {}) {
	const scene = new MeshScene(seed);
	const frames = schedule(MT_EVENTS.slice(0, count), {
		p: () => meshtasticLongFast(),
		bytes: (e, t) => scene.meshtastic(e, 0, t),
		radio: (e) => scene.radio(`mt${e.node}`, strong - ((strong - weak) * e.node) / 5),
		cfoHz,
		sroPpm,
		scene,
	});
	return { scene, frames };
}

describe('Meshtastic packet layer', () => {
	it("uses OnAir's channel hash, slot frequencies and catalog channel", () => {
		expect(channelHash('LongFast', MESHTASTIC_DEFAULT_PSK)).toBe(0x08);
		expect(meshtasticSlotHz('EU_868', 'LongFast')).toBe(869525000);
		expect(meshtasticSlotHz('US', 'LongFast')).toBe(906875000);
		expect(meshtasticSlotHz('US', 'MediumFast')).toBe(913125000);
		expect(meshtasticSlotHz('ANZ', 'LongFast')).toBe(919875000);
		expect(meshtasticSlotHz('EU_868', 'LongSlow')).toBe(869462500);
		const info = digimodeInfo('meshtastic');
		expect(info).toMatchObject({ rate: MESHTASTIC_RATE, family: 'LoRa & mesh' });
		for (const p of info.presets.filter((x) => x.label.includes('LongFast')))
			expect([869.525, 906.875, 919.875, 433.875, 865.875]).toContain(p.freqMHz);
		expect(MESHTASTIC_MODE.sfs).toEqual([7, 8, 9, 10, 11]);
	});
	it('decrypts a text message on the default key and keeps a private channel encrypted', () => {
		const from = { num: 0x2a0b1c2d };
		const ok = decodeMeshtastic(meshtasticText(from, 0xffffffff, 0x10203040, 3, 3, 'Hello mesh'));
		expect(ok.packet).toMatchObject({
			from: '!2a0b1c2d',
			to: '^all',
			type: 'TEXT_MESSAGE_APP',
			channel: 'LongFast',
			decrypted: true,
			hopLimit: 3,
		});
		expect(ok.messages[0]).toMatchObject({ text: 'Hello mesh', from: '!2a0b1c2d', to: '^all', packetId: 0x10203040, hops: 0 });
		const key = Uint8Array.from({ length: 16 }, (_, i) => i * 17 + 3);
		const secret = decodeMeshtastic(meshtasticRaw(from.num, 0xffffffff, 7, 3, 3, false, 'Family', key, meshtasticData(1, [65, 66])));
		expect(secret.packet).toMatchObject({
			type: 'ENCRYPTED',
			decrypted: false,
			note: `unknown channel 0x${channelHash('Family', key).toString(16).padStart(2, '0')}`,
		});
		expect(decodeMeshtastic(Uint8Array.from([1, 2, 3])).ok).toBe(false);
		expect(nodeId(0xffffffff - 1)).toBe('!fffffffe');
	});
	it("reads every port of OnAir's scene", () => {
		const scene = new MeshScene(9);
		const got = MT_EVENTS.map((e) => decodeMeshtastic(scene.meshtastic(e, 0, e.t)));
		expect(got.every((r) => r.ok && r.packet.decrypted)).toBe(true);
		const detail = (kind) => got[MT_EVENTS.findIndex((e) => e.kind === kind)].packet.detail;
		const id = (i) => nodeId(scene.mtNodes[i].num);
		expect(detail('Ack')).toBe(`ack of ${scene.wantAckId.toString(16).padStart(8, '0')}`);
		expect(detail('TraceReq')).toBe(`traceroute request: ${id(3)} > ${id(0)} > ${id(5)} (SNR 5.5 dB)`);
		expect(detail('TraceReply')).toBe(`traceroute reply: ${id(3)} > ${id(0)} > ${id(5)} (SNR 5.5 4.5 dB), back 1 hops`);
		expect(detail('Neighbors')).toMatch(new RegExp(`^2 neighbors: ${id(0)} 6\\.5 dB, ${id(1)} 2\\.[23] dB$`));
		expect(detail('EnvTelemetry')).toBe('environment 34.5 C, 61 %, 1008 hPa');
		const env = got[MT_EVENTS.findIndex((e) => e.kind === 'EnvTelemetry')];
		expect(env.nodes[0]).toMatchObject({ hasEnv: true, humidity: 61 });
		const tele = got[MT_EVENTS.findIndex((e) => e.kind === 'Telemetry')];
		expect(tele.nodes[0]).toMatchObject({ batteryPct: 95, uptimeS: 3608 });
		expect(got[16].packet).toMatchObject({ type: 'NODEINFO_APP', hopLimit: 1, hopStart: 3, relayNode: scene.mtNodes[5].num & 0xff });
	});
	it('never throws on garbage', () => {
		let x = 3;
		for (let k = 0; k < 3000; k++) {
			const b = Uint8Array.from({ length: 1 + (k % 80) }, () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24);
			const r = decodeMeshtastic(b);
			expect(r.ok).toBe(b.length >= 16);
		}
	});
});

describe('Meshtastic receiver', () => {
	it("decodes OnAir's scene on LongFast with carrier and clock offsets in noise", () => {
		const { scene, frames } = sceneFrames(10, { cfoHz: 2500, sroPpm: 12 });
		const { records, ms, seconds } = decodeFrames(MeshtasticDecoder, frames, { rate: MESHTASTIC_RATE, bwHz: 250000 });
		console.log(`Meshtastic: ${seconds.toFixed(1)} s of signal in ${ms.toFixed(0)} ms`);
		for (const r of records) console.log(r.text);
		expect(records).toHaveLength(frames.length);
		expect(records.every((r) => !r.damaged)).toBe(true);
		expect(records[0].text).toBe(`${nodeId(scene.mtNodes[0].num)} → ^all · NODEINFO_APP · Dubai Marina Base (DMB1), TBEAM, CLIENT`);
		expect(records[1].text).toContain(MT_LINES[0]);
	}, 60_000);
	it('finds nothing in noise alone', () => {
		const { records, status } = decodeFrames(MeshtasticDecoder, [], { rate: MESHTASTIC_RATE, bwHz: 250000, durationSec: 3 });
		expect(records).toHaveLength(0);
		expect(status.at(-1)).toEqual(['Listening for Meshtastic (SF7–SF11, 250 kHz)', false]);
	});
	it('lists a frame whose payload CRC fails as damaged', () => {
		const { frames } = sceneFrames(2, { strong: 10, weak: 10 });
		const data = frames[1].data;
		data[30] = (data[30] + 700) % 2048;
		const { records, status } = decodeFrames(MeshtasticDecoder, frames, { rate: MESHTASTIC_RATE, bwHz: 250000 });
		expect(records.map((r) => r.damaged)).toEqual([false, true]);
		expect(records[1].text).toMatch(/^CRC error · /);
		expect(field(records[1], 'CRC')).toBe('failed');
		expect(status.at(-1)[0]).toMatch(/^1 packet\(s\), 1 CRC error\(s\), last ![0-9a-f]{8} NODEINFO_APP$/);
	}, 30_000);
	it('decodes the other 250 kHz presets', () => {
		const scene = new MeshScene(2);
		const events = MT_EVENTS.slice(1, 4);
		const sfs = [7, 9, 10];
		let i = 0;
		const frames = schedule(events, {
			p: () => loraParams({ sf: sfs[i++], bwHz: 250000, cr: 5, preamble: 16, syncWord: 0x2b }),
			bytes: (e, t) => scene.meshtastic(e, 0, t),
			radio: () => ({ snrDb: 0, freqHz: -3000 }),
			scene,
		});
		const { records } = decodeFrames(MeshtasticDecoder, frames, { rate: MESHTASTIC_RATE, bwHz: 250000 });
		expect(records.map((r) => field(r, 'Spreading factor'))).toEqual(['SF7', 'SF9', 'SF10']);
		expect(records.every((r) => !r.damaged)).toBe(true);
	}, 30_000);
});

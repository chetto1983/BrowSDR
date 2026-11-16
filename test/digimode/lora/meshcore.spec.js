import { describe, expect, it } from 'vitest';
import { MeshCoreDecoder, MESHCORE_MODE, MESHCORE_RATE } from '@/worker/decoders/digimode/meshcore';
import { decodeMeshCore, meshcoreChannel } from '@/worker/decoders/digimode/meshcore/proto';
import { MESHCORE_PUBLIC_SECRET } from '@/worker/decoders/digimode/lora/presets';
import { hexEncode } from '@/worker/decoders/digimode/lora/crypto';
import { meshcoreAck, meshcoreAdvert, meshcoreGroupText, meshcoreNodeKeys, meshcorePublicText } from './builders';
import { decodeFrames } from './phy';
import { MC_EVENTS, MC_LINES, MC_NODES, MeshScene, meshcoreEu, schedule } from './scene';

const field = (record, label) => record.fields.find(([name]) => name === label)?.[1];

describe('MeshCore packet layer', () => {
	it('reads a signed advert with name, role and position', () => {
		const r = decodeMeshCore(meshcoreAdvert(MC_NODES[1], 1791360100));
		const pub = hexEncode(meshcoreNodeKeys(MC_NODES[1]).pub);
		expect(r.packet).toMatchObject({ type: 'ADVERT', from: pub.slice(0, 12), decrypted: true, routeType: 1, note: '' });
		expect(r.packet.detail).toBe('Business Bay Repeater, Repeater, 25.18500, 55.26500, signature ok, direct from sender');
		expect(r.nodes[0]).toMatchObject({
			longName: 'Business Bay Repeater',
			role: 'Repeater',
			hasPosition: true,
			signatureOk: true,
			publicKey: pub,
		});
		const bad = meshcoreAdvert(MC_NODES[1], 1791360100);
		bad[50] ^= 4; // inside the signature
		expect(decodeMeshCore(bad).packet).toMatchObject({ note: 'signature not valid' });
	});
	it('decrypts the Public channel and names what it cannot read', () => {
		expect(meshcoreChannel('Public', MESHCORE_PUBLIC_SECRET).hash).toBe(0x11); // SHA-256 of the secret, first byte
		const r = decodeMeshCore(meshcorePublicText(MC_NODES[0], 1791360200, 'Hello from the Marina', [0x5a]));
		expect(r.packet).toMatchObject({
			type: 'GRP_TXT',
			channel: 'Public',
			from: 'Marina Companion',
			to: 'Public',
			decrypted: true,
			path: '5a',
		});
		expect(r.messages[0]).toMatchObject({ from: 'Marina Companion', text: 'Hello from the Marina', hops: 1, senderTime: 1791360200 });
		const other = decodeMeshCore(
			meshcoreGroupText(
				Uint8Array.from({ length: 16 }, (_, i) => i),
				MC_NODES[0],
				1,
				'secret',
			),
		);
		expect(other.packet).toMatchObject({ type: 'GRP_TXT', decrypted: false });
		expect(other.packet.note).toMatch(/^unknown channel 0x[0-9a-f]{2}$/);
		expect(decodeMeshCore(meshcoreAck(0xdeadbeef, [1, 2])).packet).toMatchObject({
			type: 'ACK',
			detail: 'ack deadbeef, 2 hops',
			path: '01,02',
		});
		expect(decodeMeshCore(Uint8Array.from([0x11])).packet.note).toBe('too short for a MeshCore packet');
	});

	it('never throws on garbage', () => {
		let x = 5;
		const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24;
		for (let k = 0; k < 1500; k++) {
			const b = Uint8Array.from({ length: 1 + (k % 180) }, next);
			if (k % 5 === 0) b[0] = (4 << 2) | 1; // adverts: the signature check runs on junk keys
			expect(typeof decodeMeshCore(b).ok).toBe('boolean');
		}
	});
});

describe('MeshCore receiver', () => {
	it("decodes OnAir's scene (adverts, Public channel messages, one relayed) on SF8 62.5 kHz", () => {
		const scene = new MeshScene(3);
		const frames = schedule(MC_EVENTS.slice(0, 8), {
			p: () => meshcoreEu(8, 8),
			bytes: (e, t) => scene.meshcore(e, t),
			radio: (e) => scene.radio(`mc${e.node}`, 2 - (10 * (e.node + 0.5)) / 3),
			cfoHz: -1800,
			sroPpm: -15,
			scene,
		});
		const { records, ms, seconds } = decodeFrames(MeshCoreDecoder, frames, { rate: MESHCORE_RATE, bwHz: 62500 });
		console.log(`MeshCore: ${seconds.toFixed(1)} s of signal in ${ms.toFixed(0)} ms`);
		for (const r of records) console.log(r.text);
		expect(records).toHaveLength(frames.length);
		expect(records.every((r) => !r.damaged)).toBe(true);
		expect(records[0].text).toMatch(/^ADVERT [0-9a-f]{12} · Marina Companion, Chat, 25.07900, 55.13800, signature ok, direct from sender$/);
		expect(records[2].text).toBe(`Public · Marina Companion: ${MC_LINES[0]}, direct from sender`);
		expect(records[5].text).toBe(`Public · Deira Companion: ${MC_LINES[1]}, 1 hop`);
		expect(field(records[5], 'Path')).toMatch(/^[0-9a-f]{2} \(1 byte hashes\)$/);
		expect(field(records[2], 'Coding rate')).toBe('4/8');
	}, 60_000);
	it('decodes SF7 4/5 (the Netherlands, Hungary, Slovakia presets) and SF9 4/6 (Portugal 433)', () => {
		const scene = new MeshScene(4);
		const settings = [meshcoreEu(7, 5), meshcoreEu(9, 6)];
		let i = 0;
		const frames = schedule(MC_EVENTS.slice(2, 4), {
			p: () => settings[i++],
			bytes: (e, t) => scene.meshcore(e, t),
			radio: () => ({ snrDb: -3, freqHz: 2500 }),
			scene,
		});
		const { records } = decodeFrames(MeshCoreDecoder, frames, { rate: MESHCORE_RATE, bwHz: 62500 });
		expect(records.map((r) => [field(r, 'Spreading factor'), field(r, 'Coding rate'), r.damaged])).toEqual([
			['SF7', '4/5', false],
			['SF9', '4/6', false],
		]);
		expect(MESHCORE_MODE.sfs).toEqual([7, 8, 9]);
	}, 30_000);
	it('finds nothing in noise alone', () => {
		const { records } = decodeFrames(MeshCoreDecoder, [], { rate: MESHCORE_RATE, bwHz: 62500, durationSec: 6 });
		expect(records).toHaveLength(0);
	});
});

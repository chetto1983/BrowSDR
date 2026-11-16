// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to JavaScript for BrowSDR's tests from OnAir core/src/mesh/mesh_gen.cpp (the mesh test scene around Dubai: six
// Meshtastic nodes on LongFast, three MeshCore nodes, three LoRa APRS stations, six LoRaWAN end devices; their event
// tables, packets as the firmware builds them, per-node carrier offset and SNR, frames on one frequency never overlapping)
// and core/src/lorawan/lorawan_gen.cpp (lorawanTestSchedule: two uplinks, a join request, a confirmed uplink with MAC
// commands, a LinkCheckReq and a proprietary frame), https://github.com/adswill/OnAir; see third_party/onair. Changes: a
// seeded linear congruential generator in place of std::mt19937; one cycle, frames back to back (start = previous end +
// a 0.15..0.4 s pause) instead of the scene's one-minute schedule; one channel (the decoders are single-channel).

import { autoLdro, loraParams } from '@/worker/decoders/digimode/lora/code';
import { hwModelValue } from '@/worker/decoders/digimode/meshtastic/names';
import { noise } from '../fixtures';
import * as b from './builders';
import { txFrame } from './phy';

const UNIX0 = 1791360000; // 2026-10-07 UTC: the nodes' clocks
const BROADCAST = 0xffffffff;

// Meshtastic: [offset, kind, node, line or peer, hop start, hop limit]
export const MT_EVENTS = [
	[0.2, 'NodeInfo', 0],
	[1.8, 'Text', 0, 0],
	[3.4, 'NodeInfo', 1],
	[5.0, 'Text', 1, 1],
	[6.6, 'Position', 0],
	[8.2, 'Telemetry', 0],
	[9.8, 'NodeInfo', 2],
	[11.4, 'Position', 1],
	[13.0, 'Text', 2, 2],
	[14.6, 'NodeInfo', 3, -1, 3, 2],
	[16.2, 'Text', 3, 3, 3, 2],
	[17.8, 'Position', 2],
	[19.4, 'Telemetry', 1],
	[21.0, 'NodeInfo', 4],
	[22.6, 'Text', 0, 4],
	[24.2, 'Ack', 3, 0, 3, 2],
	[25.8, 'NodeInfo', 5, -1, 3, 1],
	[27.4, 'TraceReq', 3, 5, 3, 2],
	[29.0, 'TraceReply', 5, 3, 3, 1],
	[30.6, 'Position', 3, -1, 3, 2],
	[32.2, 'Telemetry', 2],
	[33.8, 'Text', 4, 5],
	[35.4, 'Position', 4],
	[37.0, 'EnvTelemetry', 3, -1, 3, 2],
	[38.6, 'Telemetry', 3, -1, 3, 2],
	[40.2, 'Position', 5, -1, 3, 1],
	[41.8, 'Text', 5, 6, 3, 1],
	[43.4, 'Telemetry', 4],
	[45.0, 'Neighbors', 5, -1, 3, 1],
	[46.6, 'Telemetry', 5, -1, 3, 1],
	[48.2, 'Text', 1, 7],
].map(([t, kind, node, arg = -1, hopStart = 3, hopLimit = 3]) => ({ t, kind, node, arg, hopStart, hopLimit }));
export const MT_LINES = [
	'Good morning mesh, Marina base is up',
	'Morning! Walking along JBR, signal is good here',
	'Kayaking off the Palm, battery at 80%',
	'Downtown rooftop here, I can see the Burj',
	'Stay safe out there on the water',
	'Stuck in traffic on Al Khail road',
	'Jebel Ali relay online, hearing 5 nodes',
	'Coffee at the Marina walk at 9?',
];
const MT_REPLY_TO = [-1, 0, -1, -1, 2, -1, -1, 0];
export const MT_NODES = [
	['Dubai Marina Base', 'DMB1', 'TBEAM', 25.0805, 55.1403, 12, 0],
	['JBR Walker', 'JBRW', 'HELTEC_V3', 25.078, 55.134, 5, 0],
	['Palm Jumeirah Kayak', 'PJK', 'T_ECHO', 25.1124, 55.139, 1, 5],
	['Downtown Rooftop', 'DTR', 'RAK4631', 25.1972, 55.2744, 120, 0],
	['Al Barsha Car', 'ABC', 'HELTEC_WIRELESS_TRACKER', 25.113, 55.2, 20, 5],
	['Jebel Ali Relay', 'JAR', 'STATION_G2', 25.02, 55.1, 35, 2],
].map(([longName, shortName, hw, lat, lon, altM, role]) => ({ longName, shortName, hwModel: hwModelValue(hw), lat, lon, altM, role }));

// MeshCore: [offset, kind, node, line, path (1 = relayed by the repeater)]
export const MC_EVENTS = [
	[0.5, 'Advert', 0],
	[3.0, 'Advert', 1],
	[6.0, 'PublicText', 0, 0],
	[9.5, 'Advert', 2],
	[13.0, 'PublicText', 2, 1],
	[15.0, 'PublicText', 2, 1, 1],
	[20.0, 'PublicText', 0, 2],
	[24.0, 'PublicText', 2, 3],
	[40.0, 'Advert', 0],
	[44.0, 'PublicText', 0, 4],
].map(([t, kind, node, arg = -1, path = 0]) => ({ t, kind, node, arg, path }));
export const MC_LINES = [
	'Hello from the Marina',
	'Deira checking in',
	'Anyone near Business Bay?',
	'On my way there now',
	'Repeater on the tower is working well',
];
export const MC_NODES = [
	{ name: 'Marina Companion', lat: 25.079, lon: 55.138, repeater: false, seed: 11 },
	{ name: 'Business Bay Repeater', lat: 25.185, lon: 55.265, repeater: true, seed: 12 },
	{ name: 'Deira Companion', lat: 25.27, lon: 55.31, repeater: false, seed: 13 },
];

// the 70 cm scene: LoRa APRS stations on 433.775 MHz (made-up calls)
export const APRS_EVENTS = [
	[0.5, 0, 'A61AB-7>APLRT1,WIDE1-1:!2504.83N/05508.42E>Marina tracker 12.6V'],
	[8.0, 1, 'A61CD-10>APLRG1:=2511.10N/05516.50E&LoRa iGate Al Barsha'],
	[16.0, 2, 'A61EF-9>APLRT1,A61CD-10*,WIDE1*:/071230z2512.00N/05518.00E_090/005g010t095h60b10080'],
	[24.0, 0, 'A61AB-7>APLRT1,WIDE1-1::A61EF-9  :Meet at the Marina at 9{01'],
	[32.0, 1, 'A61CD-10>APLRG1:;DXBMTG   *071200z2513.00N/05519.00E-Ham meeting Friday'],
	[40.0, 2, 'A61EF-9>APLRT1:>On the road to Abu Dhabi, 35°C'],
	[48.0, 0, 'A61AB-7>APLRT1:T#005,199,000,255,073,123,01101001'],
].map(([t, station, tnc2]) => ({ t, station, tnc2 }));

// LoRaWAN: end devices of a few networks (made-up addresses and EUIs): DevAddr, DevEUI, JoinEUI, SF (EU), FPort, length, ADR, first FCnt
export const LW_DEVS = [
	[0x260b1a2c, 0n, 0n, 7, 1, 10, true, 1200], // The Things Network, temperature sensor
	[0x48000a31, 0n, 0n, 9, 2, 11, true, 52], // Helium, tracker
	[0x22a1b2c3, 0n, 0n, 12, 3, 6, false, 7001], // Orange, water meter (confirmed, DevStatusAns)
	[0, 0xa84041000181c61an, 0xa840410000000101n, 10, -1, 0, false, 0], // Dragino, join request
	[0x01abcdef, 0n, 0n, 8, -1, 0, false, 33], // a private network: LinkCheckReq, no payload
	[0, 0x24e124136b502217n, 0x24e124c0002a0001n, 7, -1, 0, false, 0], // Milesight, join request
].map(([devAddr, devEui, joinEui, sf, fport, len, adr, fcnt0]) => ({ devAddr, devEui, joinEui, sf, fport, len, adr, fcnt0 }));
export const LW_EVENTS = [
	[0.5, 0, 'Up'],
	[2.0, 3, 'Join'],
	[4.0, 1, 'Up'],
	[6.0, 2, 'ConfUp'],
	[10.0, 0, 'Up'],
	[12.0, 4, 'LinkCheck'],
	[16.0, 5, 'Join'],
].map(([t, dev, kind]) => ({ t, dev, kind }));

/** The scene's random draws: uniform in [0, 1) from a seeded generator. */
function rng(seed) {
	const u = noise(seed * 7919 + 22);
	return { uniform: (lo, hi) => lo + (hi - lo) * (u() + 0.5), int: () => Math.floor((u() + 0.5) * 2 ** 32) >>> 0 };
}

/** The scene's packets, nodes and offsets for one seed. */
export class MeshScene {
	constructor(seed = 1) {
		this.r = rng(seed);
		this.mtNodes = MT_NODES.map((n) => ({ ...n, num: (0x2a000000 + (this.r.int() & 0x00ffffff)) >>> 0 }));
		this.nextId = (0x10000000 + (this.r.int() & 0x0fffffff)) >>> 0;
		this.lineIds = new Array(8).fill(0);
		this.wantAckId = 0;
		this.traceId = 0;
		this.lastMcTime = UNIX0;
		this.repeaterHash = b.meshcoreNodeKeys(MC_NODES[1]).pub[0];
		this.lwFcnt = LW_DEVS.map((d) => d.fcnt0);
	}

	newId() {
		this.nextId = (Math.imul(this.nextId, 1103515245) + 12345) >>> 0;
		return (this.nextId | 1) >>> 0;
	}

	/** A Meshtastic packet of the event (mesh_gen.cpp build). */
	meshtastic(e, cycle, t) {
		const nowUnix = UNIX0 + Math.floor(t);
		const n = { ...this.mtNodes[e.node] };
		if (e.node === 2 || e.node === 4) {
			n.lat += 0.002 * Math.sin(cycle * 0.7 + e.node);
			n.lon += 0.003 * Math.cos(cycle * 0.5 + e.node);
		}
		const id = this.newId();
		const [hl, hs, peer] = [e.hopLimit, e.hopStart, this.mtNodes[e.arg]];
		switch (e.kind) {
			case 'NodeInfo':
				return b.meshtasticNodeInfo(n, id, hl, hs);
			case 'Position':
				return b.meshtasticPosition(n, id, hl, hs, nowUnix);
			case 'Telemetry': {
				const batt = Math.max(5, 95 - 7 * e.node - 0.5 * cycle);
				return b.meshtasticTelemetry(
					n,
					id,
					hl,
					hs,
					batt,
					3.3 + 0.009 * batt,
					4 + e.node,
					0.6 + 0.1 * e.node,
					Math.trunc(3600 * (e.node + 1) + t),
				);
			}
			case 'EnvTelemetry':
				return b.meshtasticEnvTelemetry(n, id, hl, hs, 34.5, 61.0, 1007.8);
			case 'Text': {
				const r = MT_REPLY_TO[e.arg];
				const replyId = r >= 0 ? this.lineIds[r] : 0;
				this.lineIds[e.arg] = id;
				if (e.arg === 4) this.wantAckId = id;
				return b.meshtasticText(n, BROADCAST, id, hl, hs, MT_LINES[e.arg], replyId, e.arg === 4);
			}
			case 'Ack':
				return b.meshtasticRoutingAck(n, peer.num, id, hl, hs, this.wantAckId, 0);
			case 'TraceReq':
				this.traceId = id;
				return b.meshtasticTraceroute(n, peer.num, id, hl, hs, false, 0, [this.mtNodes[0].num], [22], [], []);
			case 'TraceReply':
				return b.meshtasticTraceroute(
					n,
					peer.num,
					id,
					hl,
					hs,
					true,
					this.traceId,
					[this.mtNodes[0].num],
					[22, 18],
					[this.mtNodes[0].num],
					[15, 26],
				);
			default:
				return b.meshtasticNeighborInfo(n, id, hl, hs, 300, [
					{ node: this.mtNodes[0].num, snr: 6.5 },
					{ node: this.mtNodes[1].num, snr: 2.25 },
				]);
		}
	}

	/** A MeshCore packet of the event: an advert, or a Public channel message (a relayed copy keeps the sender's time). */
	meshcore(e, t) {
		const nowUnix = UNIX0 + Math.floor(t);
		const n = MC_NODES[e.node];
		if (e.kind === 'Advert') return b.meshcoreAdvert(n, nowUnix);
		const when = e.path ? this.lastMcTime : nowUnix;
		this.lastMcTime = nowUnix;
		return b.meshcorePublicText(n, when, MC_LINES[e.arg], e.path ? [this.repeaterHash] : []);
	}

	/** A LoRaWAN uplink or join request of the event, frame counters going on. */
	lorawan(e) {
		const d = LW_DEVS[e.dev];
		const mic = this.newId();
		if (e.kind === 'Join') return b.lorawanJoinRequest(d.joinEui, d.devEui, this.newId() & 0xffff, mic);
		const frm = d.fport >= 0 ? Array.from({ length: d.len }, () => this.newId() & 0xff) : [];
		const fopts = e.kind === 'LinkCheck' ? [0x02] : e.kind === 'ConfUp' ? [0x06, 0xc8, 0x07] : []; // DevStatusAns: battery 200 / 254, margin 7 dB
		return b.lorawanBuild({
			mtype: e.kind === 'ConfUp' ? 4 : 2,
			devAddr: d.devAddr,
			adr: d.adr,
			fcnt: this.lwFcnt[e.dev]++,
			mic,
			fopts,
			fport: d.fport,
			frm,
		});
	}

	/**
	 * The SNR and carrier offset of a node: its crystal offset within +-1.5 kHz, its SNR varying by +-1.5 dB from packet to
	 * packet. OnAir's levels: Meshtastic node i of 6 at strong - (strong - weak) i / 5, MeshCore node i of 3 at
	 * strong - (strong - weak) (i + 0.5) / 3, LoRa APRS station i of 3 at strong - (strong - weak) i / 2.
	 */
	radio(key, snrDb, jitter = 1) {
		this.cfo ??= new Map();
		if (!this.cfo.has(key)) this.cfo.set(key, this.r.uniform(-1500, 1500));
		return { snrDb: snrDb + jitter * this.r.uniform(-1.5, 1.5), freqHz: this.cfo.get(key) };
	}
}

/** Frames back to back on one frequency: p(event) gives the LoRa settings, bytes(event, t) the payload. */
export function schedule(events, { p, bytes, radio, startSec = 0.1, cfoHz = 0, sroPpm = 0, scene }) {
	const frames = [];
	let t = startSec;
	for (const e of events) {
		const payload = bytes(e, t);
		const { snrDb, freqHz } = radio(e);
		const f = txFrame(p(e), payload, { startSec: t, freqHz: freqHz + cfoHz, snrDb, sroPpm, phase0: scene.r.uniform(0, 1) });
		frames.push({ ...f, event: e, payload });
		t = f.endSec + scene.r.uniform(0.15, 0.4);
	}
	return frames;
}

/** LoRa settings of the presets the scene uses. */
export const meshtasticLongFast = () => loraParams({ sf: 11, bwHz: 250000, cr: 5, preamble: 16, syncWord: 0x2b });
export const meshcoreEu = (sf = 8, cr = 8) =>
	loraParams({ sf, bwHz: 62500, cr, preamble: sf <= 8 ? 32 : 16, syncWord: 0x12, ldro: autoLdro(sf, 62500) });
export const loraAprsEu = (sf = 12, cr = 5) =>
	loraParams({ sf, bwHz: 125000, cr, preamble: 8, syncWord: 0x12, ldro: autoLdro(sf, 125000) });
export const lorawanEu = (sf) => loraParams({ sf, bwHz: 125000, cr: 5, preamble: 8, syncWord: 0x34, ldro: autoLdro(sf, 125000) });

import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DSDStatus, DpmrStatus, YsfStatus } from '@/worker/decoders/dsd/types';
import type { P25p2Slot, P25p2Status } from '@/worker/decoders/dsd/p25p2/types';
import type { DmrInfo } from '@/worker/decoders/dsd/dmr/types';
import type { DstarStatus } from '@/worker/decoders/dsd/dstar/types';
import type { NxdnStatus } from '@/worker/decoders/dsd/nxdn/types';

let wrapper: VueWrapper;
afterEach(() => wrapper?.unmount());

async function panelWith(status: DSDStatus) {
	wrapper = mount(ReceiverView);
	await wrapper.setData({ vfos: [{ ...makeDefaultVfo(144.8), mode: 'dsd', enabled: true }] });
	wrapper.vm.dsdStatus[0] = status;
	await nextTick();
	return wrapper.get('.dsd-status-panel');
}

const ysf: YsfStatus = {
	mode: 'DN',
	dataType: 2,
	frameType: 1,
	src: 'LY1ABC',
	dest: 'CQCQCQ',
	down: 'DB0XYZ',
	up: 'DB0UPL',
	rem: ['', '', '', ''],
	dgId: 42,
	callMode: 0,
	routing: 1,
	voip: false,
	text: '55.0N 25.3E',
	gps: { lat: 54.6875, lon: 25.275, radio: 'FTM-400D' },
	frames: 7,
	ended: false,
	inverted: false,
	snrDb: 20,
};

describe('DSD status panel', () => {
	it('shows a Yaesu System Fusion call: callsigns, mode, DG-ID, repeater, position and slow data', async () => {
		const panel = await panelWith({ mode: 'ysf', synced: true, syncName: 'YSF', syncCount: 7, ysf });
		const text = panel.text();
		expect(text).toContain('Mode: YSF');
		expect(panel.get('.dsd-ysf-call').text()).toBe('LY1ABC → CQCQCQ · DN');
		expect(text).toContain('DG-ID: 42');
		expect(text).toContain('DL: DB0XYZ · UL: DB0UPL');
		expect(text).toContain('GPS: 54.6875, 25.2750 · FTM-400D');
		expect(text).toContain('Data: 55.0N 25.3E');
	});
	it('marks an ended voice FR call and leaves out what was not received', async () => {
		const panel = await panelWith({
			mode: 'ysf',
			synced: true,
			ysf: { ...ysf, mode: 'VW', down: '', up: '', gps: undefined, text: '', ended: true },
		});
		expect(panel.get('.dsd-ysf-call').text()).toBe('LY1ABC → CQCQCQ · VW · ended');
		expect(panel.text()).not.toContain('DL:');
		expect(panel.text()).not.toContain('GPS:');
	});

	it('shows a dPMR call: ids, call type, colour code and the communication mode', async () => {
		const dpmr: DpmrStatus = {
			kind: 'voice',
			colourCode: 7,
			src: 1001,
			dst: 200,
			callType: 'group',
			commMode: 'voice',
			emergency: true,
			lateEntry: true,
			ended: false,
			lost: false,
			text: '',
			blocks: 12,
			inverted: false,
			snrDb: 18,
		};
		const panel = await panelWith({ mode: 'dpmr', synced: true, syncName: 'DPMR_FS2', dpmr });
		expect(panel.text()).toContain('Mode: DPMR');
		expect(panel.get('.dsd-dpmr-call').text()).toBe('00001001 → 00000200 · group · EMERGENCY');
		expect(panel.text()).toContain('CC: 7 · voice · joined late');
	});
	it('shows a dPMR short message to all and a call whose ids are not known yet', async () => {
		const message: DpmrStatus = {
			kind: 'message',
			colourCode: 12,
			src: 2006,
			dst: 0xffffff,
			callType: 'all call',
			commMode: 'data type 2',
			emergency: false,
			lateEntry: false,
			ended: true,
			lost: false,
			text: 'HELLO',
			blocks: 4,
			inverted: false,
			snrDb: 20,
		};
		let panel = await panelWith({ mode: 'dpmr', synced: true, dpmr: message });
		expect(panel.get('.dsd-dpmr-call').text()).toBe('00002006 → ALL · all call · ended');
		expect(panel.text()).toContain('Message: HELLO');
		wrapper.unmount();
		panel = await panelWith({
			mode: 'dpmr',
			synced: true,
			dpmr: { ...message, kind: 'voice', src: -1, dst: -1, colourCode: -1, text: '', ended: true, lost: true },
		});
		expect(panel.get('.dsd-dpmr-call').text()).toBe('? → ? · all call · lost');
		expect(panel.text()).toContain('CC: ---');
	});
	it('shows a clear M17 voice call and Codec2 availability', async () => {
		const panel = await panelWith({
			mode: 'm17',
			synced: true,
			syncName: 'M17 Voice 3200',
			voiceFrameCount: 2,
			m17: {
				src: 'N0CALL',
				dst: '@ALL',
				can: 1,
				kind: 'Voice 3200',
				encrypted: false,
				frames: 2,
				voiceFrames: 2,
				codecReady: true,
				text: 'HELLO',
				snrDb: 18.5,
				inverted: false,
				ended: false,
			},
		});
		const text = panel.text();
		expect(text).toContain('Mode: M17');
		expect(text).toContain('N0CALL');
		expect(text).toContain('@ALL');
		expect(text).toContain('CAN: 1');
		expect(text).toContain('SNR: 18.5 dB');
		expect(text).toContain('Data: HELLO');
		expect(text).toContain('Codec2 voice ready');
	});

	it('shows P25 Phase 2: the seed, both slots with talkgroup, source and encryption, the grant and the site', async () => {
		const slot: P25p2Slot = {
			active: true,
			src: 1234567,
			dst: 1001,
			group: true,
			emergency: false,
			encrypted: false,
			cryptoKnown: true,
			algId: 0x80,
			keyId: 0,
			mi: '',
			essMissing: false,
			lateEntry: false,
			endSeen: false,
			voiceFrames: 40,
			clearFrames: 40,
			voice: true,
			startSec: 0.4,
			durSec: 1.2,
		};
		const p25p2: P25p2Status = {
			slots: [slot, { ...slot, active: false, endSeen: true, src: 777, dst: 2002, encrypted: true, algId: 0x84, emergency: true }],
			audioSlot: 1,
			slotNow: 4,
			wacn: 0xbee00,
			sysId: 0x3a5,
			nac: 0x293,
			seed: 'recovered',
			endNac: 0x293,
			site: { wacn: 0xbee00, sysId: 0x3a5, rfss: 1, site: 7, channel: 0x1005, freqHz: 851075000 },
			grant: { dst: 3003, src: 55555, group: true, channel: 0x1005, freqHz: 851075000, emergency: false, encrypted: false, at: 2 },
			cfoHz: 12,
			snrDb: 25,
			macOk: 40,
			macBad: 0,
			essOk: 4,
			essBad: 0,
			voiceFrames: 80,
			encryptedSkipped: 40,
		};
		const panel = await panelWith({ mode: 'p25p2', synced: true, syncName: 'P25P2', syncCount: 30, p25p2 });
		expect(panel.text()).toContain('Mode: P25P2');
		expect(panel.get('.dsd-p25p2-system').text()).toBe('WACN: 0xBEE00 · SYS: 0x3A5 · NAC: 0x293 · seed found');
		const slots = panel.findAll('.dsd-p25p2-slot').map((s) => s.text());
		expect(slots).toEqual(['S1: 1234567 → TG 1001 · on air · playing', 'S2: 777 → TG 2002 · ended · ENCRYPTED 0x84 · EMERGENCY']);
		expect(panel.get('.dsd-p25p2-grant').text()).toBe('Grant: TG 3003 ← 55555 on 1-5 (851.07500 MHz)');
		expect(panel.text()).toContain('Site: SYS 0x3A5 · RFSS 1 · site 7');
		wrapper.unmount();
		const unknown = { ...slot, src: -1, dst: -1, cryptoKnown: false, essMissing: true, lateEntry: true, voiceFrames: 60 };
		const empty = { ...slot, active: false, src: -1, dst: -1, voiceFrames: 0 };
		const scrambled = await panelWith({
			mode: 'p25p2',
			synced: true,
			p25p2: { ...p25p2, slots: [empty, unknown], seed: 'none', wacn: 0, sysId: 0, nac: 0, macOk: 0, site: undefined, grant: undefined },
		});
		expect(scrambled.get('.dsd-p25p2-system').text()).toBe('Scrambled, seed not found yet · NAC: 0x293');
		expect(scrambled.findAll('.dsd-p25p2-slot').map((s) => s.text())).toEqual(['S2: ? → TG ? · joined late · encryption unknown']);
	});

	it('shows the DMR link layer: late entry, talker alias, trunking, control block, text, position and the event list', async () => {
		const at = new Date(2026, 10, 17, 21, 30, 5).getTime();
		const dmr: DmrInfo = {
			alias: { text: 'Truck 12', slot: 0, src: 250997 },
			system: { kind: 'Tier III', text: 'Tiny network 6 site 3 (AB)', at },
			control: { text: 'TV_GRANT talkgroup voice: TG 2149 ← 2145007 on channel 12 slot 2', slot: 1, at },
			message: { text: 'Meet at gate 3', format: 'Text message (TMS)', src: 7001, dst: 7002, group: false, slot: 0, crcOk: false, at },
			position: { lat: 54.68719, lon: 25.27971, source: 'GPS LC', src: 250997, slot: 0, speedKmh: 22, at },
			activity: 'activity: slot 1 group voice, slot 2 none',
			events: [
				{ kind: 'position', slot: 0, text: '250997: 54.68719, 25.27971 (GPS LC)', at },
				{ kind: 'alias', slot: 0, text: 'Talker alias "Truck 12" (250997)', at: at - 1000 },
			],
		};
		const dmrCall = {
			colourCode: 1,
			terminator: false,
			group: true,
			featureSet: 0,
			emergency: false,
			privacy: false,
			target: 262,
			source: 250997,
			lateEntry: true,
			slot: 0,
			at,
		};
		const panel = await panelWith({ mode: 'dmr', synced: true, syncName: 'DMR_BS_VOICE', colorCode: 1, dmrCall, dmr });
		const text = panel.text();
		expect(text).toContain('TS1 · TG 262 ← SRC 250997 · late entry');
		expect(panel.get('.dsd-dmr-alias').text()).toBe('Alias: Truck 12 TS1 · 250997');
		expect(panel.get('.dsd-dmr-system').text()).toBe('Tier III: Tiny network 6 site 3 (AB)');
		expect(panel.get('.dsd-dmr-control').text()).toBe('CSBK TS2: TV_GRANT talkgroup voice: TG 2149 ← 2145007 on channel 12 slot 2');
		expect(panel.get('.dsd-dmr-message').text()).toBe('Text 7001 → 7002: Meet at gate 3 · CRC wrong');
		expect(panel.get('.dsd-dmr-position').text()).toBe('Position 250997: 54.68719, 25.27971 · GPS LC · 22 km/h');
		expect(text).toContain('CACH activity: slot 1 group voice, slot 2 none');
		const events = panel.get('.dsd-dmr-events');
		expect(events.get('summary').text()).toBe('Events (2): 250997: 54.68719, 25.27971 (GPS LC)');
		expect(events.findAll('div').map((d) => d.text())).toEqual([
			'21:30:05 TS1 250997: 54.68719, 25.27971 (GPS LC)',
			'21:30:04 TS1 Talker alias "Truck 12" (250997)',
		]);
		wrapper.unmount();
		// after the carrier drops the summary stays; another protocol hides it
		const lost = await panelWith({ mode: 'unknown', synced: false, dmr });
		expect(lost.get('.dsd-dmr-alias').text()).toContain('Truck 12');
		wrapper.unmount();
		const other = await panelWith({ mode: 'p25', synced: true, dmr });
		expect(other.find('.dsd-dmr-alias').exists()).toBe(false);
	});

	it('shows D-STAR: the header callsigns and flags, the message, the position and the event list', async () => {
		const dstar: DstarStatus = {
			my: 'N0CALL',
			sfx: 'ID51',
			ur: 'CQCQCQ',
			rpt1: 'LY0VNO B',
			rpt2: 'LY0VNO G',
			flag: [0x48, 0, 0],
			flags: 'via repeater, EMERGENCY',
			headerOk: true,
			headerFromSlow: false,
			lateEntry: false,
			active: true,
			endSeen: false,
			text: 'OnAir D-STAR test 73',
			textBlocks: 15,
			gps: '$$CRC96B7,LY1TST-7>API51,DSTAR*:!5453.91N/02354.22E>OnAir D-PRS test',
			position: { call: 'LY1TST-7', lat: 54.8985, lon: 23.90367, dprs: true, comment: 'OnAir D-PRS test', altM: 112.4 },
			squelch: 12,
			voiceFrames: 120,
			durSec: 2.4,
			berPct: 0,
			inverted: false,
			events: [
				{ at: 0, text: 'message from N0CALL: OnAir D-STAR test 73' },
				{ at: 0, text: 'N0CALL/ID51 → CQCQCQ via LY0VNO B / LY0VNO G' },
			],
		};
		const panel = await panelWith({ mode: 'dstar', synced: true, syncName: 'DSTAR', syncCount: 3, dstar });
		expect(panel.get('.dsd-dstar-call').text()).toBe('N0CALL/ID51 → CQCQCQ · EMERGENCY');
		expect(panel.text()).toContain('RPT1: LY0VNO B · RPT2: LY0VNO G');
		expect(panel.get('.dsd-dstar-flags').text()).toBe('via repeater, EMERGENCY · DSQ 12');
		expect(panel.text()).toContain('Message: OnAir D-STAR test 73');
		expect(panel.get('.dsd-dstar-position').text()).toBe('D-PRS: LY1TST-7 54.89850, 23.90367 · 112 m');
		const at = new Date(2026, 10, 17, 21, 30, 5).getTime();
		wrapper.unmount();
		const withEvents = await panelWith({
			mode: 'dstar',
			synced: true,
			dstar: { ...dstar, events: dstar.events.map((e, k) => ({ ...e, at: at - 1000 * k })) },
		});
		const events = withEvents.get('.dsd-dstar-events');
		expect(events.get('summary').text()).toBe('Events (2): message from N0CALL: OnAir D-STAR test 73');
		expect(events.findAll('div').map((d) => d.text())).toEqual([
			'21:30:05 message from N0CALL: OnAir D-STAR test 73',
			'21:30:04 N0CALL/ID51 → CQCQCQ via LY0VNO B / LY0VNO G',
		]);
		wrapper.unmount();
		// after the carrier drops the summary stays; another protocol hides it
		const lost = await panelWith({ mode: 'unknown', synced: false, dstar });
		expect(lost.get('.dsd-dstar-call').text()).toBe('N0CALL/ID51 → CQCQCQ · EMERGENCY');
		wrapper.unmount();
		const other = await panelWith({ mode: 'p25', synced: true, dstar });
		expect(other.find('.dsd-dstar-call').exists()).toBe(false);
		wrapper.unmount();
		const late = await panelWith({
			mode: 'dstar',
			synced: false,
			dstar: {
				...dstar,
				my: '',
				sfx: '',
				ur: '',
				rpt1: '',
				rpt2: '',
				flags: '',
				flag: [0, 0, 0],
				headerOk: false,
				lateEntry: true,
				active: false,
				endSeen: false,
				text: '',
				position: undefined,
				squelch: -1,
				events: [],
			},
		});
		expect(late.get('.dsd-dstar-call').text()).toBe('? → ? · lost');
		expect(late.get('.dsd-dstar-flags').text()).toBe('header not received · joined late');
		expect(late.find('.dsd-dstar-events').exists()).toBe(false);
	});

	it('shows NXDN: the call with its rate, RAN and frame type, encryption, a status message, the site and the events', async () => {
		const at = new Date(2026, 10, 17, 21, 30, 5).getTime();
		const nxdn: NxdnStatus = {
			kind: 'voice',
			active: true,
			src: 1001,
			dst: 200,
			callType: 'group',
			cipher: 3,
			keyId: 5,
			ran: 1,
			baud: 2400,
			lateEntry: true,
			endSeen: false,
			voiceFrames: 40,
			durSec: 0.8,
			text: '',
			frame: 'RTCH, SACCH superframe, voice + voice, outbound',
			site: { location: 0x0a4c2b, system: 659, site: 43, service: 0x3c00, channel: 0x0101, ran: 5 },
			blocksOk: 10,
			blocksBad: 0,
			inverted: false,
			events: [
				{ at, text: 'VCALL group 1001 → 200, encrypted (cipher 3, key 5) (joined late)' },
				{ at: at - 1000, text: 'SITE_INFO location 0x0A4C2B (system 659, site 43), RAN 5' },
			],
		};
		const panel = await panelWith({ mode: 'nxdn', synced: true, syncName: 'NXDN48', syncCount: 5, nxdn });
		expect(panel.get('.dsd-nxdn-call').text()).toBe('1001 → TG 200 · group · ENCRYPTED (AES, key 5) · joined late');
		expect(panel.get('.dsd-nxdn-frame').text()).toBe('NXDN48 · RAN 1 · RTCH, SACCH superframe, voice + voice, outbound');
		expect(panel.get('.dsd-nxdn-site').text()).toBe('Site: location 0x0A4C2B · system 659 · site 43 · RAN 5');
		const events = panel.get('.dsd-nxdn-events');
		expect(events.get('summary').text()).toBe('Events (2): VCALL group 1001 → 200, encrypted (cipher 3, key 5) (joined late)');
		expect(events.findAll('div').map((d) => d.text())).toEqual([
			'21:30:05 VCALL group 1001 → 200, encrypted (cipher 3, key 5) (joined late)',
			'21:30:04 SITE_INFO location 0x0A4C2B (system 659, site 43), RAN 5',
		]);
		wrapper.unmount();
		const status = await panelWith({
			mode: 'unknown',
			synced: false,
			nxdn: {
				...nxdn,
				kind: 'status',
				active: false,
				endSeen: true,
				src: 1002,
				dst: 1001,
				callType: 'individual',
				cipher: 0,
				lateEntry: false,
				text: 'status 17',
				baud: 4800,
				site: undefined,
			},
		});
		expect(status.get('.dsd-nxdn-call').text()).toBe('1002 → 1001 · status · ended');
		expect(status.get('.dsd-nxdn-text').text()).toBe('Status: status 17');
		expect(status.find('.dsd-nxdn-site').exists()).toBe(false);
		wrapper.unmount();
		const control = await panelWith({
			mode: 'nxdn',
			synced: true,
			nxdn: { ...nxdn, kind: 'control', frame: 'RCCH, CAC, outbound', baud: 4800, ran: 5 },
		});
		expect(control.find('.dsd-nxdn-call').exists()).toBe(false);
		expect(control.get('.dsd-nxdn-frame').text()).toBe('NXDN96 · RAN 5 · RCCH, CAC, outbound');
	});
});

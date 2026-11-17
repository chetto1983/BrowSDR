import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DSDStatus, DpmrStatus, YsfStatus } from '@/worker/decoders/dsd/types';
import type { P25p2Slot, P25p2Status } from '@/worker/decoders/dsd/p25p2/types';

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
});

import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DSDStatus, DpmrStatus, YsfStatus } from '@/worker/decoders/dsd/types';

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
});

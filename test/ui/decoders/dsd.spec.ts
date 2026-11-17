import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DSDStatus, YsfStatus } from '@/worker/decoders/dsd/types';

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
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DigimodeMessage } from '@/worker/decoders/digimode/types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});

const status = { state: 'receiving' as const, message: 'Listening for calls', records: 1, locked: false };
const message = (records: DigimodeMessage['records']): DigimodeMessage => ({
	type: 'digimode',
	freq: 156.525,
	mode: 'dsc-vhf',
	status,
	records,
});
const distress = {
	id: 1,
	time: Date.UTC(2026, 10, 16, 21, 0),
	mode: 'dsc-vhf',
	text: 'Distress alert: 247123450 → all stations - Flooding',
	fields: [['Nature', 'Flooding']] as Array<[string, string]>,
	alert: true,
};

async function mountPanel(vfo = makeDefaultVfo(156.525)) {
	const setVfoParams = vi.fn();
	wrapper = mount(ReceiverView);
	await wrapper.setData({ running: true, backend: { setVfoParams }, vfos: [vfo] });
	wrapper.vm.toggleDigimodePanel();
	await wrapper.vm.$nextTick();
	return setVfoParams;
}

describe('Digital Modes panel', () => {
	it('turns a decoder on for the selected VFO', async () => {
		const setVfoParams = await mountPanel();
		await wrapper.get('select[aria-label="Decoder"]').setValue('dsc-vhf');
		expect(wrapper.vm.vfos[0].digimode).toBe('dsc-vhf');
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ digimode: 'dsc-vhf' }));
		expect(wrapper.text()).toContain('Digital selective calling');
	});
	it('tunes the usual frequency of the mode', async () => {
		await mountPanel({ ...makeDefaultVfo(156.8), digimode: 'dsc-vhf' });
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Tune')!
			.trigger('click');
		expect(wrapper.vm.vfos[0].freq).toBe(156.525);
	});
	it('logs decoded records with their details, newest first', async () => {
		await mountPanel({ ...makeDefaultVfo(156.525), digimode: 'dsc-vhf' });
		wrapper.vm._onDigimodeMessage(0, 156.525, message([distress]));
		wrapper.vm._onDigimodeMessage(0, 156.525, message([{ ...distress, id: 2, text: 'Test call: 002470100 → 247987650', alert: false }]));
		await wrapper.vm.$nextTick();
		const rows = wrapper.findAll('table[aria-label="Decoded messages"] tbody tr');
		expect(rows[0].text()).toContain('Test call');
		expect(rows[1].classes()).toContain('digimode-alert');
		await rows[1].trigger('click');
		expect(wrapper.text()).toContain('Flooding');
		expect(wrapper.text()).toContain('VFO 1 · DSC (VHF channel 70)');
	});
	it('shows the CPDLC message an Aero record carries, decoded in the app', async () => {
		await mountPanel({ ...makeDefaultVfo(1545.1225), digimode: 'aero' });
		const body = '243F880C3D903BB412903604FE326C2479F4A64F7F62528B1A9CF8382738186AC28B16668E013DF464D8A7F0'.slice(0, -4);
		const cpdlc = {
			id: 1,
			time: Date.UTC(2026, 10, 16, 15, 56),
			mode: 'aero',
			text: 'Downlink from HL8251 · CPDLC AT1',
			application: { kind: 'cpdlc' as const, uplink: false, hex: body },
		};
		wrapper.vm._onDigimodeMessage(0, 1545.1225, { ...message([cpdlc]), freq: 1545.1225, mode: 'aero' });
		await wrapper.vm.$nextTick();
		const row = wrapper.find('table[aria-label="Decoded messages"] tbody tr');
		expect(row.text()).toContain('CPDLC AT1: POSITION REPORT');
		await row.trigger('click');
		expect(wrapper.text()).toContain('15:56:32 UTC');
	});
	it('reassembles a VDL2 ACARS message split over two blocks and shows its CPDLC message', async () => {
		await mountPanel({ ...makeDefaultVfo(136.975), digimode: 'vdl2' });
		const report = '/SOUCAYA.AT1.HL8251243F880C3D903BB412903604FE326C2479F4A64F7F62528B1A9CF8382738186AC28B16668E013DF464D8A7F0';
		const block = (id: number, part: string, text: string, continuation: boolean) => ({
			id,
			time: Date.UTC(2026, 10, 18, 15, 56, id),
			mode: 'vdl2',
			text: `71BE19 (HL8251) → GS 10A000 · I · ACARS AA KE0907: ${text.slice(0, 20)}`,
			fields: [['Label', 'AA']] as Array<[string, string]>,
			application: {
				kind: 'acars' as const,
				aircraft: '71BE19',
				block: {
					label: 'AA',
					text,
					direction: 'downlink' as const,
					registration: 'HL8251',
					mode: '2',
					acknowledgement: 'NAK',
					blockId: String(id + 2),
					messageNumber: `M01${part}`,
					flight: 'KE0907',
					continuation,
				},
			},
		});
		const vdl2 = (records: DigimodeMessage['records']) => ({ ...message(records), freq: 136.975, mode: 'vdl2' });
		wrapper.vm._onDigimodeMessage(0, 136.975, vdl2([block(1, 'A', report.slice(0, 50), true)]));
		wrapper.vm._onDigimodeMessage(0, 136.975, vdl2([block(2, 'B', report.slice(50), false)]));
		await wrapper.vm.$nextTick();
		const rows = wrapper.findAll('table[aria-label="Decoded messages"] tbody tr');
		expect(rows[0].text()).toContain('message of 2 blocks: POSITION REPORT');
		expect(rows[1].text()).toContain('part 1 of a message, waiting for more blocks');
		await rows[0].trigger('click');
		expect(wrapper.text()).toContain('the last of 2 blocks (M01A, M01B)');
		expect(wrapper.text()).toContain('15:56:32 UTC');
	});
	it('ignores output for a mode the VFO no longer runs', async () => {
		await mountPanel({ ...makeDefaultVfo(156.525), digimode: '' });
		wrapper.vm._onDigimodeMessage(0, 156.525, message([distress]));
		expect(wrapper.vm.digimodes.log).toHaveLength(0);
	});
});

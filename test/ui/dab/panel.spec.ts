import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DabMessage } from '@/worker/decoders/dabplus/types';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.clearAllMocks();
});

const status: DabMessage['status'] = {
	state: 'synced',
	message: 'Ensemble locked · SNR 15.0 dB · FIC 100 %',
	ensemble: 'DAB Italia',
	eid: 0x5001,
	services: [
		{ sid: 0x5201, label: 'Radio Uno', components: [{ subchannel: 3, dabPlus: true, bitrate: 96, protection: 'EEP 3-A', primary: true }] },
		{
			sid: 0x5202,
			label: 'Classic MP2',
			components: [{ subchannel: 4, dabPlus: false, bitrate: 128, protection: 'UEP 3', primary: true }],
		},
		{ sid: 0x5203, label: 'Radio Due', components: [{ subchannel: 5, dabPlus: true, bitrate: 64, protection: 'EEP 3-A', primary: true }] },
	],
	service: 0x5201,
	serviceLabel: 'Radio Uno',
	label: 'Artist - Title',
	codec: 'HE-AAC v2 stereo 48 kHz',
	bitrate: 96,
	snrDb: 15,
	audioUnits: 120,
	audioErrors: 2,
};

async function mountDab() {
	const setVfoParams = vi.fn();
	wrapper = mount(ReceiverView);
	await wrapper.setData({
		running: true,
		backend: { setVfoParams },
		vfos: [{ ...makeDefaultVfo(223.936), mode: 'dab', bandwidth: 1536000 }],
	});
	return setVfoParams;
}

describe('DAB+ VFO panel', () => {
	it('offers DAB+ as a mode with its defaults', async () => {
		await mountDab();
		await wrapper.setData({ vfos: [makeDefaultVfo(100)] });
		const radio = wrapper.findAll('input[type="radio"]').find((input) => (input.element as HTMLInputElement).value === 'dab')!;
		await radio.setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ mode: 'dab', bandwidth: 1536000 });
		expect(wrapper.text()).toContain('DAB+');
	});
	it('tunes a Band III block and plays the chosen service', async () => {
		const setVfoParams = await mountDab();
		await wrapper.get('select[aria-label="DAB block"]').setValue('225.648');
		expect(wrapper.vm.vfos[0].freq).toBe(225.648);
		await wrapper.setData({ vfos: [{ ...wrapper.vm.vfos[0], freq: 223.936 }] });
		wrapper.vm._onDabMessage(0, 223.936, { type: 'dab', freq: 223.936, status });
		await wrapper.vm.$nextTick();
		const text = wrapper.text();
		for (const part of [
			'DAB Italia',
			'Radio Uno',
			'Artist - Title',
			'HE-AAC v2 stereo 48 kHz · 96 kbit/s · 120 audio units',
			'1 service(s) without DAB+ audio',
		])
			expect(text).toContain(part);
		const services = wrapper.get('select[aria-label="DAB service"]');
		expect(services.findAll('option').map((option) => option.text())).toEqual(['Radio Uno', 'Radio Due']);
		await services.setValue(String(0x5203));
		expect(wrapper.vm.vfos[0].dabService).toBe(0x5203);
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ mode: 'dab', dabService: 0x5203 }));
	});
	it('ignores status for another frequency', async () => {
		await mountDab();
		wrapper.vm._onDabMessage(0, 225.648, { type: 'dab', freq: 225.648, status });
		expect(wrapper.vm.dabStatus[0]).toBeUndefined();
	});
});

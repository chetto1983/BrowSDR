import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import { meteorImage } from '@/app/decoders/meteor/controller';

let wrapper: VueWrapper;
afterEach(() => {
	wrapper?.unmount();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	localStorage.clear();
});

const status = {
	state: 'receiving' as const,
	message: 'Receiving image on 137.900 MHz',
	locked: true,
	quality: 0.9,
	freqOffsetHz: 1200,
	rs: 2,
	vit: 950,
	mpdus: 40,
	rows: 8,
	apids: [66, 65, 64] as [number, number, number],
};
const rows = (from: number, to: number) => ({
	from,
	to,
	width: 1568,
	channels: [0, 1, 2].map(() => new Uint8Array((to - from) * 1568).fill(100)) as [Uint8Array, Uint8Array, Uint8Array],
});

async function mountPanel(extra: Record<string, unknown> = {}) {
	wrapper = mount(ReceiverView);
	await wrapper.setData({ running: true, vfos: [makeDefaultVfo(137.9)], ...extra });
	await wrapper.setData({ meteor: { ...wrapper.vm.meteor, panelOpen: true } });
	return wrapper;
}

describe('Meteor panel', () => {
	it('asks for the station location before listing passes', async () => {
		await mountPanel();
		expect(wrapper.text()).toContain('Set the station location first.');
	});
	it('enables a muted Meteor decoder on the selected VFO', async () => {
		const setVfoParams = vi.fn();
		await mountPanel({ backend: { setVfoParams } });
		await wrapper.get('input[aria-label="Meteor decoding for VFO 1"]').setValue(true);
		expect(wrapper.vm.vfos[0]).toMatchObject({ meteor: true });
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ meteor: true }));
	});
	it('shows decoder status and assembles image rows', async () => {
		await mountPanel({ vfos: [{ ...makeDefaultVfo(137.9), meteor: true }] });
		wrapper.vm._onMeteorMessage(0, 137.9, { type: 'meteor', freq: 137.9, status, rows: rows(0, 8) });
		await wrapper.vm.$nextTick();
		expect(wrapper.text()).toContain('Receiving image on 137.900 MHz');
		expect(wrapper.text()).toContain('8 lines');
		expect(meteorImage(wrapper.vm, 0).rows).toBe(8);
		// A message for a frequency the VFO has left is ignored.
		wrapper.vm._onMeteorMessage(0, 137.1, { type: 'meteor', freq: 137.1, status, rows: rows(8, 16) });
		expect(meteorImage(wrapper.vm, 0).rows).toBe(8);
	});
	it('refuses to retune while another client controls the relay', async () => {
		const relayConnection = vi.fn().mockResolvedValue({ url: 'wss://radiopi:8443/?client=me', token: 'me' });
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						clients: [
							{ controller: true, client: 'other' },
							{ controller: false, client: 'me' },
						],
					}),
				),
			),
		);
		await mountPanel({ backend: { relayConnection, setVfoParams: vi.fn() }, vfos: [makeDefaultVfo(403.7)] });
		await wrapper.vm.meteorTune();
		expect(wrapper.vm.meteor.notice).toBe('Another client controls the dongle; Meteor cannot retune it.');
		expect(wrapper.vm.vfos[0].freq).toBe(403.7);
	});
	it('tunes the receiver for Meteor when it controls the dongle', async () => {
		const relayConnection = vi.fn().mockResolvedValue({ url: 'ws://192.168.250.2:8765/?client=me', token: 'me' });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ clients: [{ controller: true, client: 'me' }] }))));
		await mountPanel({ backend: { relayConnection, setVfoParams: vi.fn() }, running: false, vfos: [makeDefaultVfo(403.7)] });
		await wrapper.vm.meteorTune();
		expect(wrapper.vm.radio.centerFreq).toBe(137.75);
		expect(wrapper.vm.radio.sampleRate).toBe(1024000);
		expect(wrapper.vm.vfos[0]).toMatchObject({ freq: 137.9, meteor: true, mode: 'nfm' });
		expect(wrapper.vm.meteor.notice).toBe('');
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import Panel from '@/app/decoders/tetraear/panel';
import { makeDefaultVfo } from '@/app/core/constants';
import type { AppInstance } from '@/app/core/receiver.types';
import type { BridgeEvents } from '@/app/decoders/tetraear/types';
import type { TetraEarCallback } from '@/worker/decoders/tetraear/types';

const bridge = vi.hoisted(() => ({ connect: vi.fn(), send: vi.fn(), reset: vi.fn(), close: vi.fn(), events: null as BridgeEvents | null }));
vi.mock('@/app/decoders/tetraear/bridge', () => ({
	TetraEarBridge: class {
		constructor(events: BridgeEvents) {
			bridge.events = events;
		}
		connect = bridge.connect;
		send = bridge.send;
		reset = bridge.reset;
		close = bridge.close;
	},
}));
let wrapper: VueWrapper | undefined;
afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
	vi.clearAllMocks();
});

function setup() {
	bridge.connect.mockResolvedValue('TetraEar connected');
	const receiver = reactive({
		running: true,
		remoteMode: '',
		activeVfoIndex: 0,
		soloAudioVfo: null,
		radio: { centerFreq: 391, sampleRate: 2400000 },
		vfos: [makeDefaultVfo(391)],
		tetraear: { panelOpen: true, session: 0, vfo: null },
		backend: { setTetraEarCallback: vi.fn().mockResolvedValue(undefined) },
		updateAllBackendVfoParams: vi.fn(),
	});
	wrapper = mount(Panel, { global: { provide: { receiver: receiver as unknown as AppInstance } } });
	return receiver;
}

describe('TetraEar receiver panel', () => {
	it('connects the selected VFO, renders validated frames and stops on tuning changes', async () => {
		const receiver = setup();
		// UiButton does not provide a stable title for text buttons; select by visible text.
		await wrapper!
			.findAll('button')
			.find((button) => button.text() === 'Connect TetraEar')!
			.trigger('click');
		await flushPromises();
		expect(receiver.tetraear.session).toBeGreaterThan(0);
		const callback = receiver.backend.setTetraEarCallback.mock.calls[0][0] as TetraEarCallback;
		callback(0, { type: 'tetraear_symbols', session: receiver.tetraear.session, freq: 391, bits: new ArrayBuffer(2040) });
		expect(bridge.send).toHaveBeenCalledOnce();
		bridge.events!.batch({
			type: 'batch',
			bursts: 1,
			valid: 1,
			rejected: 0,
			frames: [{ kind: 'SB1', slot: 4, mcc: 222, mnc: 55, colour: 31, address: null, encrypted: null, text: '', call: null }],
		});
		await flushPromises();
		expect(wrapper!.get('tbody').text()).toContain('222 / 55');
		receiver.vfos[0].freq = 390.25;
		expect(receiver.tetraear.session).toBe(0);
		expect(bridge.close).toHaveBeenCalledOnce();
		callback(0, { type: 'tetraear_symbols', session: 1, freq: 391, bits: new ArrayBuffer(2040) });
		expect(bridge.send).toHaveBeenCalledOnce();
	});

	it('cancels a pending connection when reception stops without enabling a decoder later', async () => {
		const receiver = setup();
		let resolve!: (value: string) => void;
		bridge.connect.mockReturnValue(
			new Promise<string>((done) => {
				resolve = done;
			}),
		);
		await wrapper!
			.findAll('button')
			.find((button) => button.text() === 'Connect TetraEar')!
			.trigger('click');
		receiver.running = false;
		resolve('Ready');
		await flushPromises();
		expect(receiver.tetraear.session).toBe(0);
		expect(receiver.backend.setTetraEarCallback).not.toHaveBeenCalled();
		expect(wrapper!.text()).toContain('Reception or tuning changed');
	});

	it('bounds visible history and closes the bridge on receiver disposal', async () => {
		setup();
		await wrapper!
			.findAll('button')
			.find((button) => button.text() === 'Connect TetraEar')!
			.trigger('click');
		await flushPromises();
		const frame = { kind: 'SB1', slot: 1, mcc: 222, mnc: 55, colour: 31, address: null, encrypted: null, text: '', call: null };
		for (let i = 0; i < 11; i++) bridge.events!.batch({ type: 'batch', frames: Array(50).fill(frame), bursts: 1, valid: 1, rejected: 0 });
		await flushPromises();
		expect(wrapper!.findAll('tbody tr')).toHaveLength(500);
		wrapper!.unmount();
		wrapper = undefined;
		expect(bridge.close).toHaveBeenCalledOnce();
	});
});

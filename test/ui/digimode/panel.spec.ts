import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ReceiverView } from '../helpers/receiver-view';
import { makeDefaultVfo } from '@/app/core/constants';
import type { DigimodeMessage } from '@/worker/decoders/digimode/types';
import { clnp, dataTpduAtn, dataTsdu, plainUplink, uplinkContact, x25Data } from '../../digimode/aviation/atn-wire.js';

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
	it('reads an ATN CPDLC message from the X.25 packets of VDL2 records', async () => {
		await mountPanel({ ...makeDefaultVfo(136.975), digimode: 'vdl2' });
		const air = [0x47, 0x00, 0x27, 0x81, 0x81, 0x3c, 0x66, 0x4b, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0x20];
		const ground = [0x47, 0x00, 0x27, 0x41, 0x20, 0x44, 0x45, 0x55, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0x21];
		const addresses = { source: Uint8Array.from(ground), destination: Uint8Array.from(air) };
		const contact = dataTpduAtn(0x0777, 0, dataTsdu(plainUplink(uplinkContact())), addresses);
		const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
		const atn = (id: number, downlink: boolean, packet: number[]) => ({
			id,
			time: Date.UTC(2026, 10, 18, 12, 34, id),
			mode: 'vdl2',
			text: downlink ? '3C664B → GS 10A000 · I · X.25 call request, LCN 1' : 'GS 10A000 → 3C664B · I · X.25 data, LCN 1',
			application: {
				kind: 'atn' as const,
				direction: downlink ? ('downlink' as const) : ('uplink' as const),
				source: downlink ? { address: '3C664B', type: 1 } : { address: '10A000', type: 4 },
				destination: downlink ? { address: '10A000', type: 4 } : { address: '3C664B', type: 1 },
				hex: hex(packet),
			},
		});
		const vdl2 = (records: DigimodeMessage['records']) => ({ ...message(records), freq: 136.975, mode: 'vdl2' });
		wrapper.vm._onDigimodeMessage(0, 136.975, vdl2([atn(1, true, [0x10, 0x01, 0x0b, 0x00, 0x00, 0xc1, 0x00])]));
		wrapper.vm._onDigimodeMessage(0, 136.975, vdl2([atn(2, false, x25Data(1, 0, 0, clnp({ src: ground, dst: air, payload: contact })))]));
		await wrapper.vm.$nextTick();
		const row = wrapper.find('table[aria-label="Decoded messages"] tbody tr');
		expect(row.text()).toContain('X.25 data, LCN 1: CPDLC UM117 CONTACT EDYY center 132.6 MHz');
		await row.trigger('click');
		expect(wrapper.text()).toContain('CPDLC, identified by trial');
		expect(wrapper.text()).toContain('2026-11-18 12:34:56 UTC');
	});
	it('ignores output for a mode the VFO no longer runs', async () => {
		await mountPanel({ ...makeDefaultVfo(156.525), digimode: '' });
		wrapper.vm._onDigimodeMessage(0, 156.525, message([distress]));
		expect(wrapper.vm.digimodes.log).toHaveLength(0);
	});

	it('decodes with a pasted TinyGS modem configuration and goes back to the blind search', async () => {
		const setVfoParams = await mountPanel({ ...makeDefaultVfo(436.5), digimode: 'lora-sat' });
		expect(wrapper.text()).toContain('Blind search: every SF, sync word and IQ of this bandwidth.');
		const json =
			'{"mode":"LoRa","freq":436.703,"bw":250.0,"sf":10,"cr":5,"sw":18,"pwr":5,"cl":120,"pl":8,"gain":0,"crc":true,"fldro":1,"sat":"Norbi","NORAD":46494}';
		await wrapper.get('textarea[aria-label="TinyGS modem configuration JSON"]').setValue(json);
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Use configuration')!
			.trigger('click');
		expect(wrapper.vm.vfos[0]).toMatchObject({ digimode: 'lora-sat-250', freq: 436.703 });
		expect(wrapper.text()).toContain(
			'Decoding with Norbi (NORAD 46494): 436.703 MHz · SF10 · 250 kHz · CR 4/5 · sync 0x12 · preamble 8 · CRC on · LDRO on · normal IQ · explicit header.',
		);
		expect(setVfoParams).toHaveBeenLastCalledWith(
			0,
			expect.objectContaining({
				freq: 436.703,
				digimode: 'lora-sat-250',
				digimodeLoraSat: { config: expect.objectContaining({ sat: 'Norbi', norad: 46494, sf: 10, bwHz: 250000, sync: 18, ldro: 'on' }) },
			}),
		);
		expect(wrapper.get('select[aria-label="Decoder"]').element.value).toBe('lora-sat-250');
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Blind search')!
			.trigger('click');
		expect(wrapper.vm.vfos[0].loraSatConfig).toBeUndefined();
		expect(setVfoParams).toHaveBeenLastCalledWith(0, expect.objectContaining({ digimode: 'lora-sat-250', digimodeLoraSat: {} }));
	});
	it('says when a TinyGS configuration is FSK or invalid and keeps the VFO as it was', async () => {
		await mountPanel({ ...makeDefaultVfo(436.5), digimode: 'lora-sat' });
		const use = async (json: string) => {
			await wrapper.get('textarea[aria-label="TinyGS modem configuration JSON"]').setValue(json);
			await wrapper
				.findAll('button')
				.find((button) => button.text() === 'Use configuration')!
				.trigger('click');
			return wrapper.get('.digimode-tinygs-state').text();
		};
		expect(
			await use(
				'{"mode":"FSK","freq":437.77,"br":9.6,"fd":25,"bw":200,"pwr":10,"cl":100,"pl":0,"ook":0,"fsw":[4,53,46,53,46],"sat":"reaktor-hello-world","NORAD":43743}',
			),
		).toMatch(/^reaktor-hello-world uses FSK \(mode "FSK"\) at 437\.77 MHz: 9\.6 kbit\/s, deviation 25 kHz/);
		expect(await use('{"freq":436.7}')).toContain('it has no "mode"');
		expect(await use('{"mode":"LoRa","freq":436.7,"bw":100,"sf":10,"cr":5}')).toContain('Bandwidth 100 kHz');
		expect(wrapper.vm.vfos[0]).toMatchObject({ digimode: 'lora-sat', freq: 436.5 });
		expect(wrapper.vm.vfos[0].loraSatConfig).toBeUndefined();
		// other decoders have no such field
		await wrapper.get('select[aria-label="Decoder"]').setValue('dsc-vhf');
		expect(wrapper.find('textarea[aria-label="TinyGS modem configuration JSON"]').exists()).toBe(false);
	});
});

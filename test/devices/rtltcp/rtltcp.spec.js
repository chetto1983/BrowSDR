import { describe, expect, it, vi } from 'vitest';
import { RtlTcpDevice } from '@/devices/rtltcp/device';
import { encodeRtlTcpCommand, normalizeRtlTcpUrl, parseRtlTcpHeader } from '@/devices/rtltcp/protocol';
import { receiveTransferSize } from '@/radio/receive-transfer';

class FakeSocket {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.readyState = 0;
		this.binaryType = 'blob';
	}
	send(buffer) {
		if (this.readyState !== 1) throw new Error('socket not open');
		this.sent.push([...new Uint8Array(buffer)]);
	}
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({ code: 1000, reason: '' });
	}
	accept() {
		this.readyState = 1;
		this.onopen?.({});
	}
	push(bytes) {
		this.onmessage?.({ data: Uint8Array.from(bytes).buffer });
	}
}

const u32 = (value) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const header = (tuner = 6, gains = 29) => [0x52, 0x54, 0x4c, 0x30, ...u32(tuner), ...u32(gains)];

async function connected(tuner, gains) {
	let socket;
	const device = new RtlTcpDevice('ws://pi:8765', (url) => (socket = new FakeSocket(url)));
	const opening = device.open();
	socket.accept();
	socket.push(header(tuner, gains));
	await opening;
	socket.sent.length = 0;
	return { device, socket };
}

describe('rtl_tcp protocol', () => {
	it('normalizes bare host:port addresses to WebSocket URLs', () => {
		expect(normalizeRtlTcpUrl('192.168.250.2:8765')).toBe('ws://192.168.250.2:8765/');
		expect(normalizeRtlTcpUrl(' wss://radio.example/rtl ')).toBe('wss://radio.example/rtl');
		expect(() => normalizeRtlTcpUrl('http://pi:1234')).toThrow(/ws:\/\//);
		expect(() => normalizeRtlTcpUrl('')).toThrow();
	});

	it('encodes five-byte big-endian commands', () => {
		expect([...new Uint8Array(encodeRtlTcpCommand(0x01, 1090000000))]).toEqual([0x01, ...u32(1090000000)]);
		expect([...new Uint8Array(encodeRtlTcpCommand(0x05, -3))]).toEqual([0x05, 0xff, 0xff, 0xff, 0xfd]);
	});

	it('parses the dongle header and rejects other servers', () => {
		expect(parseRtlTcpHeader(Uint8Array.from(header(6, 29)))).toEqual({ tunerType: 6, tuner: 'R828D', gainCount: 29 });
		expect(() => parseRtlTcpHeader(Uint8Array.from([0x48, 0x54, 0x54, 0x50, ...u32(0), ...u32(0)]))).toThrow(/rtl_tcp/);
	});
});

describe('RtlTcpDevice', () => {
	it('opens after a header split across messages and exposes tuner gain steps', async () => {
		let socket;
		const device = new RtlTcpDevice('ws://pi:8765', (url) => (socket = new FakeSocket(url)));
		const opening = device.open();
		expect(socket.binaryType).toBe('arraybuffer');
		socket.accept();
		socket.push(header(6, 29).slice(0, 5));
		socket.push(header(6, 29).slice(5));
		await opening;
		expect((await device.getInfo()).tuner).toBe('R828D');
		expect(device.gainControls.map((control) => [control.name, control.max])).toEqual([
			['Tuner', 28],
			['Bias-T', 1],
		]);
		// Manual gain mode, so tuner gain steps apply.
		expect(socket.sent).toEqual([[0x03, ...u32(1)]]);
	});

	it('fails to open when the server closes before sending a header', async () => {
		let socket;
		const device = new RtlTcpDevice('ws://pi:8765', (url) => (socket = new FakeSocket(url)));
		const opening = device.open();
		socket.accept();
		socket.close();
		await expect(opening).rejects.toThrow(/closed/);
	});

	it('sends tuning, rate, gain and bias-T commands', async () => {
		const { device, socket } = await connected();
		await device.setFrequency(1090e6);
		await device.setSampleRate(2400000);
		await device.setGains({ Tuner: 12, 'Bias-T': 1 });
		expect(socket.sent).toEqual([
			[0x01, ...u32(1090000000)],
			[0x02, ...u32(2400000)],
			[0x0d, ...u32(12)],
			[0x0e, ...u32(1)],
		]);
	});

	it('delivers signed IQ in fixed chunks across message boundaries, keeping I/Q alignment', async () => {
		const { device, socket } = await connected();
		await device.setSampleRate(250000);
		const size = receiveTransferSize(250000, 65536, 2, 2);
		// Three samples arrive before reception starts; the odd byte count must not swap I and Q.
		socket.push([1, 2, 3]);
		const chunks = [];
		await device.startRx((view) => chunks.push([...new Int8Array(view.buffer, view.byteOffset, view.byteLength)]));
		const stream = Array.from({ length: size + 2 }, (_, i) => (i * 7) & 255);
		socket.push(stream.slice(0, 1000));
		socket.push(stream.slice(1000));
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toHaveLength(size);
		// stream[0] is the Q half of the dropped third pair; delivery starts at the next I.
		expect(chunks[0].slice(0, 3)).toEqual(stream.slice(1, 4).map((byte) => byte - 128));
		await device.stopRx();
		socket.push(stream);
		expect(chunks).toHaveLength(1);
	});

	it('reports a source error when the server drops the connection while receiving', async () => {
		const { device, socket } = await connected();
		await device.startRx(() => {});
		expect(device.getRxStreamStats().sourceError).toBeUndefined();
		socket.close();
		expect(device.getRxStreamStats().sourceError).toMatch(/closed/);
	});

	it('reports a source error when IQ stops arriving while receiving', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
		const { device, socket } = await connected();
		await device.startRx(() => {});
		socket.push([1, 2, 3, 4]);
		now.mockReturnValue(3500);
		expect(device.getRxStreamStats().sourceError).toBeUndefined();
		now.mockReturnValue(4100);
		expect(device.getRxStreamStats().sourceError).toMatch(/No IQ/);
		await device.stopRx();
		expect(device.getRxStreamStats().sourceError).toBeUndefined();
		now.mockRestore();
	});

	it('closes the socket and rejects commands afterwards', async () => {
		const { device, socket } = await connected();
		await device.close();
		expect(socket.readyState).toBe(3);
		await expect(device.setFrequency(100e6)).rejects.toThrow(/closed/);
	});
});

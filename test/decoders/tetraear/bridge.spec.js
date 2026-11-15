import { afterEach, describe, expect, it, vi } from 'vitest';
import { TetraEarBridge } from '@/app/decoders/tetraear/bridge';
import { bridgeUrl, validBatch } from '@/app/decoders/tetraear/validation';

class Socket {
	static OPEN = 1;
	static last;
	readyState = 1;
	bufferedAmount = 0;
	sent = [];
	constructor() {
		Socket.last = this;
	}
	send(value) {
		this.sent.push(value);
	}
	close() {
		this.readyState = 3;
	}
	message(value) {
		this.onmessage?.({ data: typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value) });
	}
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function connected() {
	vi.stubGlobal('WebSocket', Socket);
	vi.stubGlobal('location', { protocol: 'http:' });
	const events = { batch: vi.fn(), audio: vi.fn(), error: vi.fn() };
	const bridge = new TetraEarBridge(events);
	const ready = bridge.connect('ws://127.0.0.1:8766', { frequency: 391, audio: false, slot: 1 });
	Socket.last.onopen();
	Socket.last.message({ type: 'ready', protocol: 1, message: 'Ready', audio: false });
	await ready;
	return { bridge, events, socket: Socket.last };
}
const batch = { type: 'batch', frames: [], bursts: 0, valid: 0, rejected: 0 };

describe('TetraEar bridge client', () => {
	it('bounds unacknowledged symbols and stops rather than accumulating latency', async () => {
		const { bridge, events, socket } = await connected();
		for (let i = 0; i < 8; i++) bridge.send(new ArrayBuffer(2040));
		socket.message(batch);
		bridge.send(new ArrayBuffer(2040));
		expect(events.error).not.toHaveBeenCalled();
		bridge.send(new ArrayBuffer(2040));
		expect(events.error.mock.lastCall[0]).toContain('cannot keep up');
		expect(socket.readyState).toBe(3);
	});
	it('validates replies, resets the stream and suppresses callbacks after closing', async () => {
		const { bridge, events, socket } = await connected();
		bridge.send(new ArrayBuffer(2040));
		socket.message(batch);
		expect(events.batch).toHaveBeenCalledOnce();
		bridge.reset();
		expect(JSON.parse(socket.sent.at(-1))).toEqual({ type: 'reset' });
		socket.message(new Float32Array([NaN]).buffer);
		expect(events.audio).not.toHaveBeenCalled();
		expect(events.error).toHaveBeenCalledOnce();
		socket.message(batch);
		expect(events.batch).toHaveBeenCalledOnce();
	});
	it('times out a stalled handshake', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('WebSocket', Socket);
		vi.stubGlobal('location', { protocol: 'http:' });
		const events = { batch: vi.fn(), audio: vi.fn(), error: vi.fn() };
		const bridge = new TetraEarBridge(events);
		const failure = expect(bridge.connect('ws://localhost:8766', { frequency: 391, audio: false, slot: 1 })).rejects.toThrow('10 seconds');
		await vi.advanceTimersByTimeAsync(10000);
		await failure;
	});
	it('rejects mixed content and oversized or malformed frame batches', () => {
		expect(() => bridgeUrl('ws://localhost:8766', 'https:')).toThrow('wss://');
		expect(() => bridgeUrl('https://localhost:8766', 'http:')).toThrow();
		expect(() => bridgeUrl('ws://user:pass@localhost:8766', 'http:')).toThrow();
		expect(validBatch(batch)).toBe(true);
		expect(validBatch({ ...batch, frames: Array(65).fill({}) })).toBe(false);
		expect(validBatch({ ...batch, valid: Infinity })).toBe(false);
	});
});

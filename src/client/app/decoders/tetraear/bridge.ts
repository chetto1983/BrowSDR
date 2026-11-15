import { isRecord } from '@/platform/data';
import { bridgeUrl, validBatch } from './validation';
import type { BridgeEvents, BridgeOptions } from './types';

/** Acknowledgements bound latency even when the server's TCP receive buffer is large. */
export class TetraEarBridge {
	private socket?: WebSocket;
	private pending = 0;
	private ready = false;
	private reject?: (reason: Error) => void;
	private timer?: ReturnType<typeof setTimeout>;
	constructor(private events: BridgeEvents) {}

	connect(address: string, options: BridgeOptions): Promise<string> {
		const socket = new WebSocket(bridgeUrl(address));
		this.socket = socket;
		socket.binaryType = 'arraybuffer';
		return new Promise((resolve, reject) => {
			this.reject = reject;
			this.timer = setTimeout(() => this.fail('TetraEar bridge did not respond within 10 seconds.'), 10000);
			socket.onopen = () => socket.send(JSON.stringify({ type: 'configure', protocol: 1, ...options }));
			socket.onmessage = (event: MessageEvent<unknown>) => {
				if (!this.ready) {
					const value = this.json(event.data);
					if (
						!isRecord(value) ||
						value.type !== 'ready' ||
						value.protocol !== 1 ||
						typeof value.message !== 'string' ||
						value.message.length > 512 ||
						typeof value.audio !== 'boolean'
					)
						return this.fail('Invalid TetraEar handshake.');
					this.ready = true;
					this.reject = undefined;
					clearTimeout(this.timer);
					resolve(value.message);
					return;
				}
				this.receive(event.data);
			};
			socket.onerror = () => this.fail('Cannot connect to TetraEar. Check the bridge address, allowed origin and TLS certificate.');
			socket.onclose = (event) => this.fail(`TetraEar disconnected${event.reason ? `: ${event.reason}` : '.'}`);
		});
	}

	send(bits: ArrayBuffer): void {
		if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
		if (this.pending >= 8 || this.socket.bufferedAmount > 32768) {
			this.fail('TetraEar cannot keep up with reception. Decoding stopped to prevent stale frames.');
			return;
		}
		if (!this.pending) this.timer = setTimeout(() => this.fail('TetraEar stopped acknowledging symbols.'), 10000);
		this.pending++;
		this.socket.send(bits);
	}

	reset(): void {
		if (this.ready) this.socket?.send(JSON.stringify({ type: 'reset' }));
	}

	close(): void {
		clearTimeout(this.timer);
		this.reject?.(new Error('Connection cancelled'));
		this.reject = undefined;
		this.ready = false;
		if (this.socket) {
			this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
			this.socket.close();
			this.socket = undefined;
		}
	}

	private receive(data: unknown): void {
		if (data instanceof ArrayBuffer) {
			if (!data.byteLength || data.byteLength % 4 || data.byteLength > 32000) return this.fail('Invalid TetraEar audio packet.');
			const samples = new Float32Array(data);
			if (!samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1)) return this.fail('Invalid TetraEar audio samples.');
			this.events.audio(data);
			return;
		}
		const value = this.json(data);
		if (!validBatch(value) || !this.pending) return this.fail('Invalid TetraEar frame packet.');
		this.pending--;
		clearTimeout(this.timer);
		if (this.pending) this.timer = setTimeout(() => this.fail('TetraEar stopped acknowledging symbols.'), 10000);
		this.events.batch(value);
	}

	private json(data: unknown): unknown {
		if (typeof data !== 'string' || data.length > 262144) return null;
		try {
			return JSON.parse(data) as unknown;
		} catch {
			return null;
		}
	}

	private fail(message: string): void {
		this.reject?.(new Error(message));
		this.reject = undefined;
		this.close();
		this.events.error(message);
	}
}

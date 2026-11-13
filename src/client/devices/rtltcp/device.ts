import type { GainControl, RxStreamStats, SdrDevice, SdrDeviceInfo } from '@/radio/types';
import { receiveTransferSize } from '@/radio/receive-transfer';
import { RTL_TCP_COMMAND, RTL_TCP_HEADER_BYTES, encodeRtlTcpCommand, parseRtlTcpHeader } from './protocol';
import type { RtlTcpHeader, RtlTcpSocketFactory } from './types';

const SOCKET_OPEN = 1;
const OPEN_TIMEOUT_MS = 8000;
const STALL_MS = 3000;
const MAX_TRANSFER_BYTES = 65536;
const R82XX_RANGE: [number, number] = [24e6, 1766e6];

/**
 * RTL-SDR shared over the network by rtl_tcp, reached through a WebSocket bridge
 * (for example websockify) because browsers cannot open raw TCP sockets.
 */
export class RtlTcpDevice implements SdrDevice {
	readonly deviceType = 'rtltcp';
	readonly sampleRates = [250000, 1024000, 1536000, 1792000, 1920000, 2048000, 2160000, 2400000, 2560000, 2880000, 3200000];
	readonly sampleFormat = 'int8' as const;
	gainControls: GainControl[] = [];
	frequencyRange?: [number, number];

	private socket: WebSocket | null = null;
	private header: RtlTcpHeader | null = null;
	private headerBytes = new Uint8Array(RTL_TCP_HEADER_BYTES);
	private headerFill = 0;
	private callback: ((data: ArrayBufferView) => void) | null = null;
	private chunk = new Int8Array(0);
	private fill = 0;
	private streamBytes = 0;
	private alignPending = false;
	private sampleRate = 2048000;
	private receivedBytes = 0;
	private started = 0;
	private lastDataAt = 0;
	private failure: string | null = null;

	constructor(
		readonly url: string,
		private readonly createSocket: RtlTcpSocketFactory = (address) => new WebSocket(address),
	) {}

	async open(): Promise<void> {
		const socket = this.createSocket(this.url);
		socket.binaryType = 'arraybuffer';
		this.socket = socket;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => fail(new Error(`No rtl_tcp header from ${this.url} within ${OPEN_TIMEOUT_MS / 1000} s.`)),
				OPEN_TIMEOUT_MS,
			);
			const fail = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			socket.onerror = () => fail(new Error(`Cannot reach ${this.url}.`));
			socket.onclose = () => fail(new Error(`The rtl_tcp connection to ${this.url} closed before it was ready.`));
			socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
				try {
					this.receive(new Uint8Array(event.data));
				} catch (error) {
					fail(error as Error);
					socket.close();
					return;
				}
				if (this.header) {
					clearTimeout(timer);
					resolve();
				}
			};
		});
		socket.onclose = () => {
			// close() detaches the socket first, so only a server-side drop lands here.
			if (this.socket === socket) this.failure = 'The rtl_tcp server closed the connection.';
		};
		this.applyHeader(this.header!);
		this.send(RTL_TCP_COMMAND.gainMode, 1);
	}

	async close(): Promise<void> {
		await this.stopRx();
		const socket = this.socket;
		this.socket = null;
		socket?.close();
	}

	getInfo(): Promise<SdrDeviceInfo> {
		return Promise.resolve({
			name: 'rtl_tcp',
			product: this.header ? `RTL-SDR (${this.header.tuner})` : 'RTL-SDR',
			tuner: this.header?.tuner,
			protocol: this.url,
		});
	}

	// rtl_tcp has no acknowledgements, so commands settle once written to the socket.
	setSampleRate(rate: number): Promise<void> {
		return settle(() => {
			this.send(RTL_TCP_COMMAND.sampleRate, rate);
			this.sampleRate = rate;
			this.resizeChunk();
		});
	}

	setFrequency(freqHz: number): Promise<void> {
		return settle(() => this.send(RTL_TCP_COMMAND.frequency, Math.round(freqHz)));
	}

	setGain(name: string, value: number): Promise<void> {
		return settle(() => {
			if (name === 'Tuner') this.send(RTL_TCP_COMMAND.gainIndex, Math.round(value));
			else if (name === 'Bias-T') this.send(RTL_TCP_COMMAND.biasTee, value ? 1 : 0);
		});
	}

	async setGains(gains: Record<string, number>): Promise<void> {
		for (const [name, value] of Object.entries(gains)) await this.setGain(name, value);
	}

	getRxStreamStats(): RxStreamStats {
		return {
			sourceGapCount: 0,
			sourceMissingSamples: 0,
			sourceDiscontinuities: 0,
			usbReceivedBytes: this.receivedBytes,
			usbReceivedSamples: this.receivedBytes / 2,
			usbElapsedMs: this.started ? performance.now() - this.started : 0,
			sourceError: this.sourceError(),
		};
	}

	/** A dropped connection, or silence while receiving: rtl_tcp keeps the socket open after losing its dongle. */
	private sourceError(): string | undefined {
		if (this.failure) return this.failure;
		const silentMs = performance.now() - this.lastDataAt;
		if (this.callback && silentMs > STALL_MS)
			return `No IQ from rtl_tcp for ${Math.round(silentMs / 1000)} s; the dongle or server stopped.`;
		return undefined;
	}

	startRx(callback: (data: ArrayBufferView) => void): Promise<void> {
		return settle(() => {
			if (!this.isOpen()) throw new Error('The rtl_tcp connection is closed.');
			this.resizeChunk();
			this.fill = 0;
			this.alignPending = true;
			this.receivedBytes = 0;
			this.started = performance.now();
			this.lastDataAt = this.started;
			this.callback = callback;
		});
	}

	stopRx(): Promise<void> {
		this.callback = null;
		this.fill = 0;
		return Promise.resolve();
	}

	private isOpen(): boolean {
		return this.socket?.readyState === SOCKET_OPEN;
	}

	private send(command: number, value: number): void {
		if (!this.isOpen()) throw new Error('The rtl_tcp connection is closed.');
		this.socket!.send(encodeRtlTcpCommand(command, value));
	}

	private applyHeader(header: RtlTcpHeader): void {
		const steps = Math.max(1, header.gainCount);
		this.gainControls = [
			{ name: 'Tuner', min: 0, max: steps - 1, step: 1, default: Math.round((steps - 1) * 0.43), type: 'slider' },
			{ name: 'Bias-T', min: 0, max: 1, step: 1, default: 0, type: 'checkbox' },
		];
		this.frequencyRange = header.tuner === 'R820T' ? R82XX_RANGE : undefined;
	}

	private receive(bytes: Uint8Array): void {
		let data = bytes;
		if (!this.header) {
			const take = Math.min(RTL_TCP_HEADER_BYTES - this.headerFill, data.length);
			this.headerBytes.set(data.subarray(0, take), this.headerFill);
			this.headerFill += take;
			data = data.subarray(take);
			if (this.headerFill < RTL_TCP_HEADER_BYTES) return;
			this.header = parseRtlTcpHeader(this.headerBytes);
			this.socket!.onmessage = (event: MessageEvent<ArrayBuffer>) => this.receive(new Uint8Array(event.data));
		}
		this.stream(data);
	}

	private stream(data: Uint8Array): void {
		const callback = this.callback;
		let start = 0;
		if (callback && this.alignPending) {
			// rtl_tcp interleaves I,Q bytes; resume on an I byte after any discarded data.
			start = this.streamBytes % 2;
			this.alignPending = false;
		}
		this.streamBytes += data.length;
		if (data.length) this.lastDataAt = performance.now();
		if (!callback) return;
		this.receivedBytes += data.length - start;
		for (let i = start; i < data.length; i++) {
			this.chunk[this.fill++] = data[i] - 128;
			if (this.fill === this.chunk.length) {
				const full = this.chunk;
				this.chunk = new Int8Array(full.length);
				this.fill = 0;
				callback(full);
				if (this.callback !== callback) return;
			}
		}
	}

	private resizeChunk(): void {
		const size = receiveTransferSize(this.sampleRate, MAX_TRANSFER_BYTES, 2, 2);
		if (size === this.chunk.length) return;
		this.chunk = new Int8Array(size);
		this.fill = 0;
	}
}

function settle(action: () => void): Promise<void> {
	try {
		action();
		return Promise.resolve();
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
}

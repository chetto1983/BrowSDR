import type { RtlTcpHeader } from './types';

/** rtl_tcp wire protocol: a 12-byte dongle header, then raw unsigned 8-bit IQ; commands are 5 bytes. */
export const RTL_TCP_COMMAND = {
	frequency: 0x01,
	sampleRate: 0x02,
	gainMode: 0x03,
	gain: 0x04,
	ppm: 0x05,
	agc: 0x08,
	directSampling: 0x09,
	offsetTuning: 0x0a,
	gainIndex: 0x0d,
	biasTee: 0x0e,
} as const;

export const RTL_TCP_HEADER_BYTES = 12;

const TUNERS = ['Unknown', 'E4000', 'FC0012', 'FC0013', 'FC2580', 'R820T', 'R828D'];

export function parseRtlTcpHeader(bytes: Uint8Array): RtlTcpHeader {
	const view = new DataView(bytes.buffer, bytes.byteOffset, RTL_TCP_HEADER_BYTES);
	const magic = String.fromCharCode(...bytes.subarray(0, 4));
	if (magic !== 'RTL0') throw new Error('The server did not answer like rtl_tcp (missing RTL0 header).');
	const tunerType = view.getUint32(4);
	return { tunerType, tuner: TUNERS[tunerType] ?? `Tuner ${tunerType}`, gainCount: view.getUint32(8) };
}

export function encodeRtlTcpCommand(command: number, value: number): ArrayBuffer {
	const buffer = new ArrayBuffer(5);
	const view = new DataView(buffer);
	view.setUint8(0, command);
	view.setUint32(1, value >>> 0);
	return buffer;
}

/** Accepts ws:// or wss:// URLs, or a bare host:port that is reached over ws://. */
export function normalizeRtlTcpUrl(input: string): string {
	const text = input.trim();
	if (!text) throw new Error('Enter the WebSocket address of the rtl_tcp bridge.');
	const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `ws://${text}`);
	if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Use a ws:// or wss:// address for the rtl_tcp bridge.');
	return url.href;
}

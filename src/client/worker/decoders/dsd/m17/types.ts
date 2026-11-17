export type M17FrameType = 'lsf' | 'stream' | 'packet' | 'bert' | 'eot';

export interface M17Lsf {
	dst: string;
	src: string;
	type: number;
	meta: Uint8Array;
}

export interface M17Status {
	src: string;
	dst: string;
	can: number;
	kind: string;
	encrypted: boolean;
	frames: number;
	voiceFrames: number;
	codecReady: boolean;
	text: string;
	snrDb: number;
	inverted: boolean;
	ended: boolean;
}

export interface M17Frame {
	status: M17Status;
	voice?: { payload: Uint8Array; rate: 1600 | 3200; frameNumber: number };
}

export interface Codec2Module {
	cwrap(name: string, result: string | null, parameters: string[]): (...args: number[]) => number;
	_malloc(size: number): number;
	_free(pointer: number): void;
	HEAPU8: Uint8Array;
	HEAPF32: Float32Array;
}
export type Codec2Factory = (options: { locateFile(path: string): string }) => Promise<Codec2Module>;

export interface TetraEarFrame {
	kind: string;
	slot: number | null;
	mcc: number | null;
	mnc: number | null;
	colour: number | null;
	encrypted: boolean | null;
	address: number | null;
	text: string;
	call: Record<string, string | number | boolean | null> | null;
}

export interface TetraEarBatch {
	type: 'batch';
	frames: TetraEarFrame[];
	bursts: number;
	valid: number;
	rejected: number;
}

export interface BridgeOptions {
	frequency: number;
	audio: boolean;
	slot: number;
}

export interface BridgeEvents {
	batch: (batch: TetraEarBatch) => void;
	audio: (samples: ArrayBuffer) => void;
	error: (message: string) => void;
}

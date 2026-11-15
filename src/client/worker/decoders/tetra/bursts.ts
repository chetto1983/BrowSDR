import { BSCH_SCRAMBLING, cellScrambling, decodeControlBlock } from './coding';
import { parseSync, parseSysinfo } from './pdus';
import type { SyncBurst } from './types';

/** Synchronisation training sequence y1..y38 (§9.4.4.3.4). */
export const SYNC_TRAINING = [
	1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1,
];
export const BURST_BITS = 510;
/** Offset of y1 inside a synchronisation continuous downlink burst. */
export const SYNC_TRAINING_OFFSET = 214;
// Synchronisation continuous downlink burst layout (§9.4.4.2.6): q 12, h 2, f 80, sb1 120, y 38, bb 30, bkn2 216, h 2, q 10.
const SB1 = 94;
const BKN2 = 282;

/** Decode the BSCH and, when it is a SYSINFO, the BNCH of one 510-bit synchronisation burst (soft bits, + is one). */
export function decodeSyncBurst(soft: ArrayLike<number>): SyncBurst {
	const bsch = decodeControlBlock(slice(soft, SB1, 120), 11, BSCH_SCRAMBLING, 60);
	if (!bsch.crcOk) return {};
	const sync = parseSync(bsch.info);
	const bnch = decodeControlBlock(slice(soft, BKN2, 216), 101, cellScrambling(sync.mcc, sync.mnc, sync.colourCode), 124);
	const sysinfo = bnch.crcOk ? parseSysinfo(bnch.info) : null;
	return sysinfo ? { sync, sysinfo } : { sync };
}

function slice(soft: ArrayLike<number>, start: number, length: number): Float32Array {
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) out[i] = soft[start + i];
	return out;
}

/**
 * Finds synchronisation bursts in a continuous stream of soft bits (two per symbol) and decodes them.
 * Training sequences are matched on hard decisions at symbol boundaries with up to three bit errors.
 */
export class SyncBurstFinder {
	bursts = 0;
	private readonly soft = new Float32Array(4096);
	private length = 0;
	private pending: number[] = [];

	constructor(private readonly onBurst: (burst: SyncBurst) => void) {}

	pushSymbol(bit1: number, bit2: number): void {
		if (this.length + 2 > this.soft.length) this.compact();
		this.soft[this.length++] = bit1;
		this.soft[this.length++] = bit2;
		const start = this.length - SYNC_TRAINING.length;
		if (start >= SYNC_TRAINING_OFFSET && this.matchesTraining(start)) {
			this.bursts++;
			this.pending.push(start - SYNC_TRAINING_OFFSET);
		}
		while (this.pending.length && this.pending[0] + BURST_BITS <= this.length) {
			const begin = this.pending.shift()!;
			this.onBurst(decodeSyncBurst(this.soft.subarray(begin, begin + BURST_BITS)));
		}
	}

	reset(): void {
		this.length = 0;
		this.pending = [];
	}

	private matchesTraining(start: number): boolean {
		let errors = 0;
		for (let i = 0; i < SYNC_TRAINING.length; i++) {
			if (this.soft[start + i] > 0 !== (SYNC_TRAINING[i] === 1) && ++errors > 3) return false;
		}
		return true;
	}

	/** Keep the last burst's worth of bits so a training sequence near the end still finds its burst start. */
	private compact(): void {
		const keep = BURST_BITS * 2;
		const drop = this.length - keep;
		this.soft.copyWithin(0, drop, this.length);
		this.length = keep;
		this.pending = this.pending.map((begin) => begin - drop).filter((begin) => begin >= 0);
	}
}

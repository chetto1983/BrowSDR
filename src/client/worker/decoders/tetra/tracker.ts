import type { SyncBurst, TetraCell } from './types';

const MAX_CELLS = 32;

/** Cells heard on one channel, keyed by network and colour code. */
export class TetraCells {
	frames = 0;
	private cells = new Map<string, TetraCell>();

	process(burst: SyncBurst, now = Date.now()): void {
		const { sync, sysinfo } = burst;
		if (!sync) return;
		this.frames++;
		const id = `${sync.mcc}-${sync.mnc}-${sync.colourCode}`;
		const cell = this.cells.get(id) ?? {
			id,
			mcc: sync.mcc,
			mnc: sync.mnc,
			colourCode: sync.colourCode,
			sync,
			syncCount: 0,
			sysinfoCount: 0,
			firstSeen: now,
			lastSeen: now,
		};
		cell.sync = sync;
		cell.syncCount++;
		cell.lastSeen = now;
		if (sysinfo) {
			cell.sysinfo = sysinfo;
			cell.sysinfoCount++;
		}
		this.cells.delete(id);
		this.cells.set(id, cell);
		if (this.cells.size > MAX_CELLS) this.cells.delete(this.cells.keys().next().value!);
	}

	snapshot(): TetraCell[] {
		return [...this.cells.values()].reverse().map((cell) => ({
			...cell,
			sync: { ...cell.sync },
			sysinfo: cell.sysinfo && { ...cell.sysinfo, services: { ...cell.sysinfo.services } },
		}));
	}
}

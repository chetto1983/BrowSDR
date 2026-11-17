import type { MeteorChannelIndex, MeteorDecoder, MeteorRows } from './types';

const CHANNELS: MeteorChannelIndex[] = [0, 1, 2];
/** A channel this many rows behind the others has stopped (an APID switched off mid-pass, day/night). */
const STALLED_ROWS = 64;

/**
 * The image rows to send after `sentRows`: up to the rows every live channel has finished, so none is
 * sent before it is final. A stalled channel no longer holds the others back, and pixels a channel never
 * wrote (no APID, or past its last row) go out as zeros rather than whatever its memory holds.
 */
export function selectRows(
	decoder: Pick<MeteorDecoder, 'width' | 'channelRows' | 'channel' | 'apid'> & Partial<Pick<MeteorDecoder, 'blockTime'>>,
	sentRows: number,
): MeteorRows | undefined {
	const active = CHANNELS.filter((index) => decoder.apid(index) >= 0);
	if (!active.length) return undefined;
	const counts = active.map((index) => decoder.channelRows(index));
	const newest = Math.max(...counts);
	const to = Math.min(...counts.filter((count) => count >= newest - STALLED_ROWS));
	if (to <= sentRows) return undefined;
	const width = decoder.width();
	const from = sentRows;
	const channel = (index: MeteorChannelIndex) => {
		const out = new Uint8Array((to - from) * width);
		if (decoder.apid(index) < 0) return out;
		const own = Math.min(to, decoder.channelRows(index));
		if (own > from) out.set(decoder.channel(index).subarray(from * width, own * width));
		return out;
	};
	const timeBlocks: NonNullable<MeteorRows['timeBlocks']> = [];
	if (decoder.blockTime) {
		for (let block = Math.floor(from / 8); block < Math.ceil(to / 8); block++) {
			const timeMs = decoder.blockTime(block);
			if (Number.isFinite(timeMs) && timeMs > 0) timeBlocks.push({ row: block * 8, timeMs });
		}
	}
	return { from, to, width, channels: [channel(0), channel(1), channel(2)], timeBlocks };
}

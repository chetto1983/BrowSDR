// Bounded checks for the LoRa satellite decoder's VFO parameters (remote peers and the worker take nothing unchecked).
import { isRecord } from '@/platform/data';
import { TINYGS_LORA_BANDWIDTHS_KHZ } from './tinygs';
import type { LoraSatConfig, LoraSatHint, LoraSatParams, LoraSatSatellite } from './types';

const int = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const finite = (v: unknown, limit: number): boolean => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
const shortText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max;

/** A LoRa setting a TinyGS radio takes: a RadioLib bandwidth, SF5 to SF12, 4/5 to 4/8, one byte of sync word. */
export function validLoraSatConfig(value: unknown): value is LoraSatConfig {
	if (!isRecord(value) || !shortText(value.sat, 64) || !int(value.norad, 0, 2 ** 32 - 1)) return false;
	if (!finite(value.freqMHz, 1020) || (value.freqMHz as number) < 137) return false;
	const bw = value.bwHz as number;
	if (typeof bw !== 'number' || !TINYGS_LORA_BANDWIDTHS_KHZ.some((k) => Math.abs((k === 41.7 ? 125 / 3 : k) * 1000 - bw) < 0.5))
		return false;
	if (!int(value.sf, 5, 12) || !int(value.cr, 5, 8) || !int(value.sync, 0, 255) || !int(value.preamble, 0, 65535)) return false;
	if (typeof value.crc !== 'boolean' || typeof value.inverted !== 'boolean' || !int(value.implicitLen, 0, 255)) return false;
	return value.ldro === 'off' || value.ldro === 'on' || value.ldro === 'auto';
}

const validHint = (v: unknown): v is LoraSatHint => isRecord(v) && finite(v.offsetHz, 1e6) && finite(v.rateHzS, 1e5);
const validSatellite = (v: unknown): v is LoraSatSatellite => isRecord(v) && shortText(v.name, 64) && int(v.norad, 0, 2 ** 32 - 1);

/** The decoder's part of the VFO parameters. */
export function validLoraSatParams(value: unknown): value is LoraSatParams {
	if (!isRecord(value)) return false;
	return (
		(value.config === undefined || validLoraSatConfig(value.config)) &&
		(value.hint === undefined || validHint(value.hint)) &&
		(value.satellite === undefined || validSatellite(value.satellite))
	);
}

import { isRecord } from '@/platform/data';
import { digimodeInfo } from './catalog';
import type { DigimodeMessage } from './types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const MAX_IMAGE_WIDTH = 4096;
const MAX_IMAGE_ROWS = 8192;

function validPosition(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || !text(value.id, 32) || !finite(value.lat) || !finite(value.lon)) return false;
	return Math.abs(value.lat) <= 90 && Math.abs(value.lon) <= 180 && (value.label === undefined || text(value.label, 32));
}

const hexText = (value: unknown, max: number): value is string => text(value, max) && value.length % 2 === 0 && /^[0-9A-F]*$/.test(value);
const optionalText = (value: unknown, max: number): boolean => value === undefined || text(value, max);
const direction = (value: unknown): boolean => value === 'uplink' || value === 'downlink';

/** An ACARS block envelope: the ACARS library's record fields, bounded as ARINC 618 blocks are. */
function validAcarsBlock(value: unknown): boolean {
	if (!isRecord(value) || !text(value.label, 2) || value.label.length !== 2 || !text(value.text, 240)) return false;
	if (!direction(value.direction) || !text(value.registration, 7) || !text(value.mode, 1) || !text(value.blockId, 1)) return false;
	if (!text(value.acknowledgement, 3) || typeof value.continuation !== 'boolean') return false;
	return optionalText(value.messageNumber, 4) && optionalText(value.flight, 6);
}

const validAvlcAddress = (value: unknown): boolean =>
	isRecord(value) &&
	text(value.address, 6) &&
	/^[0-9A-F]{6}$/.test(value.address) &&
	Number.isInteger(value.type) &&
	Number(value.type) >= 0 &&
	Number(value.type) <= 7;

/** An X.25 packet from an AVLC frame between an aircraft and a ground station: at least an X.25 header, at most 2000 octets. */
function validAtn(value: Record<string, unknown>): boolean {
	if (!direction(value.direction) || !validAvlcAddress(value.source) || !validAvlcAddress(value.destination)) return false;
	return hexText(value.hex, 4000) && value.hex.length >= 6;
}

function validApplication(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	if (value.kind === 'cpdlc') return typeof value.uplink === 'boolean' && hexText(value.hex, 4000);
	if (value.kind === 'acars')
		return (
			(value.aircraft === undefined || (text(value.aircraft, 6) && /^[0-9A-F]{6}$/.test(value.aircraft))) && validAcarsBlock(value.block)
		);
	if (value.kind === 'atn') return validAtn(value);
	return false;
}

function validRecord(value: unknown): boolean {
	if (!isRecord(value) || !Number.isInteger(value.id) || !finite(value.time) || !text(value.mode, 64) || !text(value.text, 2000))
		return false;
	if (!validPosition(value.position) || !validApplication(value.application)) return false;
	if (value.fields === undefined) return true;
	return (
		Array.isArray(value.fields) &&
		value.fields.length <= 64 &&
		value.fields.every((field) => Array.isArray(field) && field.length === 2 && text(field[0], 200) && text(field[1], 4000))
	);
}

function validImage(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value) || !Number.isInteger(value.picture) || !text(value.title, 200)) return false;
	const [width, from, to] = [value.width, value.from, value.to];
	if (!Number.isInteger(width) || !Number.isInteger(from) || !Number.isInteger(to)) return false;
	const [w, f, t] = [width as number, from as number, to as number];
	return (
		w > 0 &&
		w <= MAX_IMAGE_WIDTH &&
		f >= 0 &&
		t > f &&
		t <= MAX_IMAGE_ROWS &&
		value.rgb instanceof Uint8Array &&
		value.rgb.length === (t - f) * w * 3
	);
}

/** Bounded check for Digital Modes messages (worker output and remote peers). */
export function validDigimodeMessage(value: unknown): value is DigimodeMessage {
	if (!isRecord(value) || value.type !== 'digimode' || !finite(value.freq) || !isRecord(value.status)) return false;
	if (value.mode !== '' && !digimodeInfo(String(value.mode))) return false;
	const status = value.status;
	return (
		['off', 'receiving', 'error'].includes(String(status.state)) &&
		text(status.message, 500) &&
		Number.isInteger(status.records) &&
		typeof status.locked === 'boolean' &&
		Array.isArray(value.records) &&
		value.records.length <= 500 &&
		value.records.every(validRecord) &&
		validImage(value.image)
	);
}

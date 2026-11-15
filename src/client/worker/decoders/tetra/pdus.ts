import { field } from './coding';
import type { TetraServices, TetraSync, TetraSysinfo } from './types';

/** BSCH info bits: D-MAC-SYNC (31 bits) followed by D-MLE-SYNC (29 bits). §21.4.4.2, §18.4.2.2 */
export function parseSync(bits: Uint8Array): TetraSync {
	return {
		systemCode: field(bits, 0, 4),
		colourCode: field(bits, 4, 6),
		timeslot: field(bits, 10, 2) + 1,
		frame: field(bits, 12, 5),
		multiframe: field(bits, 17, 6),
		sharingMode: field(bits, 23, 2),
		mcc: field(bits, 31, 10),
		mnc: field(bits, 41, 14),
		neighbourBroadcast: field(bits, 55, 2),
		cellServiceLevel: field(bits, 57, 2),
		lateEntry: bits[59] === 1,
	};
}

const OFFSET_HZ = [0, 6250, -6250, 12500];
const MAC_BROADCAST = 2;
const SYSINFO = 0;

/** BNCH info bits when they carry a MAC SYSINFO broadcast; other PDUs on the block return null. */
export function parseSysinfo(bits: Uint8Array): TetraSysinfo | null {
	if (field(bits, 0, 2) !== MAC_BROADCAST || field(bits, 2, 2) !== SYSINFO) return null;
	const mainCarrier = field(bits, 4, 12);
	const band = field(bits, 16, 4);
	const offset = field(bits, 20, 2);
	const hz = band * 100e6 + mainCarrier * 25000 + OFFSET_HZ[offset];
	// Bits 60..81: optional field flag and its 20-bit value, then the 42-bit MLE SYSINFO fills the 124 bits.
	const mle = 82;
	return {
		mainCarrier,
		band,
		offset,
		mainCarrierMHz: Math.round(hz) / 1e6,
		duplexSpacing: field(bits, 22, 3),
		reverseOperation: bits[25] === 1,
		commonScch: field(bits, 26, 2),
		msTxPowerMax: field(bits, 28, 3),
		rxLevelAccessMin: field(bits, 31, 4),
		accessParameter: field(bits, 35, 4),
		radioDownlinkTimeout: field(bits, 39, 4),
		cipherKeyBroadcast: bits[43] === 1,
		hyperframeOrCck: field(bits, 44, 16),
		locationArea: field(bits, mle, 14),
		subscriberClass: field(bits, mle + 14, 16),
		services: parseServices(bits, mle + 30),
	};
}

function parseServices(bits: Uint8Array, start: number): TetraServices {
	const flag = (index: number) => bits[start + index] === 1;
	return {
		registrationRequired: flag(0),
		deregistrationRequired: flag(1),
		priorityCell: flag(2),
		noMinimumMode: flag(3),
		migration: flag(4),
		systemWideServices: flag(5),
		voice: flag(6),
		circuitData: flag(7),
		packetData: flag(9),
		airEncryption: flag(10),
		advancedLink: flag(11),
	};
}

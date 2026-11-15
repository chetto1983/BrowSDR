/** Broadcast synchronisation from the BSCH of a synchronisation burst (EN 300 392-2 §21.4.4.2). */
export interface TetraSync {
	systemCode: number;
	colourCode: number;
	/** 1..4 */
	timeslot: number;
	/** 1..18 */
	frame: number;
	/** 1..60 */
	multiframe: number;
	sharingMode: number;
	mcc: number;
	mnc: number;
	neighbourBroadcast: number;
	cellServiceLevel: number;
	lateEntry: boolean;
}

/** BS service details (EN 300 392-2 §18.5.2). */
export interface TetraServices {
	registrationRequired: boolean;
	deregistrationRequired: boolean;
	priorityCell: boolean;
	noMinimumMode: boolean;
	migration: boolean;
	systemWideServices: boolean;
	voice: boolean;
	circuitData: boolean;
	packetData: boolean;
	airEncryption: boolean;
	advancedLink: boolean;
}

/** MAC SYSINFO broadcast with its MLE part (EN 300 392-2 §21.4.4.1, §18.4.2.1). */
export interface TetraSysinfo {
	mainCarrier: number;
	band: number;
	offset: number;
	/** Main carrier downlink frequency in MHz. */
	mainCarrierMHz: number;
	duplexSpacing: number;
	reverseOperation: boolean;
	commonScch: number;
	msTxPowerMax: number;
	rxLevelAccessMin: number;
	accessParameter: number;
	radioDownlinkTimeout: number;
	/** True when this SYSINFO carries a common cipher key identifier instead of the hyperframe number; cells alternate. */
	cipherKeyBroadcast: boolean;
	hyperframeOrCck: number;
	locationArea: number;
	subscriberClass: number;
	services: TetraServices;
}

export interface TetraCell {
	id: string;
	mcc: number;
	mnc: number;
	colourCode: number;
	sync: TetraSync;
	sysinfo?: TetraSysinfo;
	syncCount: number;
	sysinfoCount: number;
	firstSeen: number;
	lastSeen: number;
}

export interface TetraStatus {
	state: 'off' | 'receiving' | 'error';
	message: string;
	samples: number;
	/** Synchronisation training sequences found. */
	bursts: number;
	/** Bursts whose BSCH passed the CRC. */
	frames: number;
	/** 0..1 constellation quality of the last block; 1 is a clean pi/4-DQPSK signal. */
	quality: number;
	freqOffsetHz: number;
}

export interface TetraMessage {
	type: 'tetra';
	freq: number;
	status: TetraStatus;
	cells: TetraCell[];
}

/** What one synchronisation burst yielded: nothing when its BSCH failed the CRC. */
export interface SyncBurst {
	sync?: TetraSync;
	sysinfo?: TetraSysinfo;
}

/** A decoded control block: info bits when the CRC passed. */
export interface TetraBlock {
	info: Uint8Array;
	crcOk: boolean;
}

export type TetraSymbolSink = (softBit1: number, softBit2: number) => void;

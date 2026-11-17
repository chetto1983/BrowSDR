// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir core/include/dect2/inmc/inmc_tel.h (InmcMessage, InmcNcsInfo),
// inmc_code.h (FrameDecode), inmc_pkt.h (FrameParser slots) and inmc_egc.h (EgcInfo), https://github.com/adswill/OnAir;
// see third_party/onair. Changes: the telemetry report, the channel list of the band search and the results file are
// left out; a slot remembers what the log has already shown of its message.

/** One decoded TDM frame (inmc_code.h FrameDecode). */
export interface InmcFrameDecode {
	/** The 640 frame bytes, descrambled; the last one is the flush byte. */
	bytes: Uint8Array;
	/** Unique word symbols that disagree with their hard decision (polarity as given). */
	uwErrors: number;
	/** Coded symbols that differ from the re-encoded result. */
	symbolErrors: number;
	pathMetric: number;
}

/** The unique word fit that allows one polarity flip inside the frame (inmc_code.h uwFit). */
export interface InmcUwFit {
	errors: number;
	/** The frame starts with the reversed polarity. */
	startRev: boolean;
	/** First row after the flip; 64 when there is none. */
	slipRow: number;
}

/** What a SafetyNET / FleetNET message is about, read from its text (inmc_egc.h EgcInfo). */
export interface InmcEgcInfo {
	/** "NAVAREA IV" / "METAREA 9", "" when the text names none. */
	area: string;
	areaNumber: number;
	/** "Navigational warning", "Weather forecast", "Distress relay", ... ("" for a system message). */
	subject: string;
	/** The warning number, "123/26", "" when none. */
	ident: string;
}

/** One EGC message (SafetyNET or FleetNET), assembled from its packets (inmc_tel.h InmcMessage). */
export interface InmcMessage {
	/** Message sequence number from the packet header. */
	id: number;
	/** Service / address code byte (0x31 NAVAREA/METAREA warning, ...). */
	serviceCode: number;
	/** 0 other or system, 1 SafetyNET, 2 FleetNET. */
	kind: number;
	/** 0 routine, 1 safety, 2 urgency, 3 distress. */
	priority: number;
	serviceText: string;
	/** The address bytes after the first one, in hex (their layout is not confirmed, so they are not decoded). */
	area: string;
	/** First address byte, read as satellite (2 bits) and LES (6 bits) as in every other packet: TENTATIVE for EGC. */
	addr0: number;
	sat: number;
	lesId: number;
	lesName: string;
	repetition: number;
	/** 0 IA5, 6 ITA2, 7 binary. */
	presentation: number;
	packets: number;
	/** The last packet (continuation bit clear) and all before it were received. */
	complete: boolean;
	/** How many times the complete message was received. */
	seen: number;
	/** Frame number of the first packet. */
	frameNo: number;
	text: string;
	/** "NAVAREA IV" / "METAREA 9", read from the text. */
	navarea: string;
	subject: string;
	/** The warning number from the text, "123/26". */
	ident: string;
}

/** A message being assembled (inmc_pkt.h FrameParser::Slot). */
export interface InmcSlot {
	msg: InmcMessage;
	/** Packet payloads by key = packet number * 2 + (descriptor == 0xB2). */
	parts: Map<number, Uint8Array>;
	lastKey: number;
	/** The parts heard in this broadcast of the message. */
	passKeys: Set<number>;
	/** This broadcast was counted in `seen`. */
	counted: boolean;
	order: number;
	/** BrowSDR: the text the log showed last for this message, and whether it was complete. */
	shown: string;
	shownComplete: boolean;
	/** BrowSDR: frames parsed since a packet of this message last arrived. */
	idleFrames: number;
}

/** System information from the bulletin board (0x7D) and signalling channel (0x6C) packets (inmc_tel.h InmcNcsInfo). */
export interface InmcNcsInfo {
	valid: boolean;
	/** Ocean region code 0 AOR-W, 1 AOR-E, 2 POR, 3 IOR. */
	sat: number;
	region: string;
	/** Station that sends this channel (the NCS is 44). */
	lesId: number;
	lesName: string;
	/** 1 NCS, 2 LES TDM, 3 joint NCS and TDM, 4 stand-by NCS. */
	channelType: number;
	channelTypeName: string;
	networkVersion: number;
	signallingChannel: number;
	count: number;
	status: number;
	statusText: string;
	services: number;
	servicesText: string;
	randomInterval: number;
	/** From the signalling channel packet, 0 when not seen. */
	signallingUplinkMhz: number;
	frameNo: number;
	/** Frame number times 8.64 s as h:mm:ss.s. */
	frameTime: string;
}

/** Packet counts of the parser. */
export interface InmcPacketCounts {
	ok: number;
	bad: number;
}

/** What the frame search hands on with every decoded frame. */
export interface InmcFrameEvent {
	decode: InmcFrameDecode;
	/** Unique word errors of the best fit (of 128). */
	uwErrors: number;
	/** The polarity was inverted, or flipped inside the frame. */
	inverted: boolean;
	slipRow: number;
}

/** Signal quality when a frame came in. */
export interface InmcSignal {
	ebn0Db: number;
	cfoHz: number;
}

/** Labelled lines of a record. */
export type InmcFields = Array<[label: string, value: string]>;

// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Packet shapes from OnAir core/include/dect2/orbcomm/orbcomm.h.

export type OrbcommKind = 'sync' | 'message' | 'uplink' | 'downlink' | 'network' | 'fill' | 'ephemeris' | 'elements' | 'other';

export interface OrbcommPacket {
	kind: OrbcommKind;
	text: string;
	fields: Array<[string, string]>;
	satellite?: number;
	message?: { id: number; part: number; last: boolean; text: string };
	position?: { lat: number; lon: number; altitudeKm: number };
}

export interface MessageParts {
	next: number;
	text: string;
}

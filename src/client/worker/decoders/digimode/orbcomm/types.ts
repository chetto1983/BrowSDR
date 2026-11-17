// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Packet labels from public downlink captures.

export type OrbcommKind = 'sync' | 'message' | 'uplink' | 'downlink' | 'network' | 'fill' | 'ephemeris' | 'elements' | 'other';

export interface OrbcommPacket {
	kind: OrbcommKind;
	text: string;
	fields: Array<[string, string]>;
	satellite?: number;
}

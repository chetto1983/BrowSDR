// SPDX-FileCopyrightText: Copyright (C) 2026 Kristijonas Adomaitis and OnAir contributors
// SPDX-License-Identifier: GPL-3.0-or-later
// Ported to TypeScript for BrowSDR from OnAir app/inmc/inmc_ui.cpp (what the message list and the reading pane show of an
// EGC message: priority, service, area, warning number, station, the text) and core/include/dect2/inmc/inmc_tel.h
// (inmcSummary), https://github.com/adswill/OnAir; see third_party/onair. Changes: one log record per message with
// labelled fields, the whole text cut into fields of at most 4000 characters; urgency and distress messages are alerts.

import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import { frameTimeText, priorityName } from './tables';
import type { InmcFields as Fields, InmcMessage, InmcNcsInfo, InmcSignal } from './types';

/** Characters of the text in one field (the log allows 4000), and fields of text at most. */
const FIELD_CHARS = 3900;
const MAX_TEXT_FIELDS = 40;
const PRESENTATIONS: Record<number, string> = { 0: 'IA5 (7-bit text)', 6: 'ITA2 (telex)', 7: 'binary' };

const hex2 = (v: number): string => v.toString(16).toUpperCase().padStart(2, '0');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const signedHz = (hz: number): string => `${hz > 0 ? '+' : ''}${Math.round(hz)} Hz`;

/** The service in a few words: "NAVAREA/METAREA warning or forecast" from "SafetyNET, NAVAREA/METAREA warning or forecast". */
const shortService = (m: InmcMessage): string => m.serviceText.replace(/^(SafetyNET|FleetNET|System), /, '');

function textFields(text: string): Fields {
	const fields: Fields = [];
	for (let at = 0, n = 1; at < text.length && n <= MAX_TEXT_FIELDS; at += FIELD_CHARS, n++)
		fields.push([n === 1 ? 'Text' : `Text (${n})`, text.slice(at, at + FIELD_CHARS)]);
	return fields;
}

function headerFields(m: InmcMessage): Fields {
	const fields: Fields = [
		['Priority', priorityName(m.priority)],
		['Service', `${m.serviceText} (0x${hex2(m.serviceCode)})`],
	];
	if (m.subject) fields.push(['Subject', m.subject]);
	if (m.navarea) fields.push(['Area', m.navarea]);
	if (m.ident) fields.push(['Warning number', m.ident]);
	fields.push(['Message number', `${m.id}${m.repetition ? `, repetition ${m.repetition}` : ''}`]);
	fields.push(['Packets', `${m.packets}${m.complete ? '' : ', incomplete (packets missing)'}`]);
	const les = m.lesName ? `, read as station ${m.lesId} (${m.lesName}), tentative` : '';
	fields.push(['Address', `${hex2(m.addr0)}${m.area ? ` ${m.area}` : ''}${les}`]);
	fields.push(['Presentation', PRESENTATIONS[m.presentation] ?? `code ${m.presentation}`]);
	return fields;
}

/** One record for an EGC message: priority, subject, area and warning number, then the text on one line; the full text in the fields. */
export function messageRecord(m: InmcMessage, ncs: InmcNcsInfo, signal: InmcSignal): Omit<DigimodeRecord, 'id' | 'time' | 'mode'> {
	const head = [priorityName(m.priority), m.subject || shortService(m), [m.navarea, m.ident].filter(Boolean).join(' ')].filter(Boolean);
	const fields = headerFields(m);
	if (ncs.valid) fields.push(['Channel', `${ncs.region}, ${ncs.lesName || `station ${ncs.lesId}`}, ${ncs.channelTypeName}`]);
	fields.push(['Frame', `${m.frameNo} (${frameTimeText(m.frameNo)} after the frame count started)`]);
	fields.push(['Signal', `Eb/N0 ${signal.ebn0Db.toFixed(1)} dB, carrier ${signedHz(signal.cfoHz)}`]);
	fields.push(...textFields(m.text));
	const body = oneLine(m.text);
	return {
		text: `${head.join(' · ')}${m.complete ? '' : ' (incomplete)'}: ${body || '(no text)'}`.slice(0, 2000),
		fields: fields.slice(0, 64),
		damaged: !m.complete,
		alert: m.priority >= 2,
	};
}

/** The channel from its bulletin board, for the status line: "IOR, NCS". */
export function channelName(ncs: InmcNcsInfo): string {
	if (!ncs.valid) return '';
	const region = /\(([^)]+)\)/.exec(ncs.region)?.[1] ?? ncs.region;
	return `${region} ${ncs.channelTypeName}${ncs.lesId !== 44 && ncs.lesName ? ` (${ncs.lesName})` : ''}`;
}

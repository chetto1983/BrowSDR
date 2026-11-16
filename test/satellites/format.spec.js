import { describe, expect, it } from 'vitest';
import { passRows } from '@/satellites/format';
import { predictPasses } from '@/satellites/passes';
import { parseTle } from '@/satellites/tle';
import { METEOR_TLE, SITE } from './fixtures';

const passes = predictPasses(parseTle(METEOR_TLE), SITE, new Date('2026-11-16T07:00:00Z'), 24);
const options = { locale: 'it-IT', timeZone: 'Europe/Rome' };

describe('pass list rows', () => {
	it('drops finished passes and marks the one in progress', () => {
		const rows = passRows(passes, new Date('2026-11-16T09:10:00Z'), options);
		expect(rows[0].inProgress).toBe(true);
		expect(rows[0].label).toBe('Meteor-M2 3');
		expect(rows.some((row) => row.pass.aos.toISOString().startsWith('2026-11-16T07:28'))).toBe(false);
	});
	it('describes a pass in local time with elevation, duration and direction', () => {
		const rows = passRows(passes, new Date('2026-11-16T09:10:00Z'), options);
		const m24 = rows.find((row) => row.pass.aos.toISOString().startsWith('2026-11-16T13:10'));
		expect(m24.when).toBe('lun 16 14:10');
		expect(m24.detail).toBe('max 50° · 10 min · SE→N');
		expect(m24.poor).toBe(false);
		expect(m24.key).toBe(`59051-${m24.pass.aos.toISOString()}`);
	});
});

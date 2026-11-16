import { azimuthName } from './passes';
import type { Pass, PassRow } from './types';

/** Weekday, day and 24-hour time, e.g. "lun 16 14:10", in the given locale and time zone. */
function shortWhen(date: Date, locale?: string, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone,
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('weekday').replace(/\.$/, '')} ${part('day')} ${part('hour')}:${part('minute')}`;
}

/** Display rows for passes that have not ended yet; shared by the Meteor panel and browsdr-cli. */
export function passRows(passes: readonly Pass[], now: Date, options: { locale?: string; timeZone?: string } = {}): PassRow[] {
	return passes
		.filter((pass) => pass.los > now)
		.map((pass) => ({
			key: `${pass.norad}-${pass.aos.toISOString()}`,
			label: pass.satellite,
			when: shortWhen(pass.aos, options.locale, options.timeZone),
			detail: `max ${Math.round(pass.maxElevation)}° · ${Math.round((pass.los.getTime() - pass.aos.getTime()) / 60000)} min · ${azimuthName(pass.aosAzimuth)}→${azimuthName(pass.losAzimuth)}`,
			poor: pass.poor,
			inProgress: pass.aos <= now,
			pass,
		}));
}

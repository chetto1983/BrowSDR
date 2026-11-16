import { METEOR_SATELLITES } from '@/satellites/catalog';
import { passRows } from '@/satellites/format';
import { predictPasses } from '@/satellites/passes';
import { fetchTles } from '@/satellites/tle';
import type { Site, Tle } from '@/satellites/types';
import { fetchRelayStatus, runDecode } from './decode';
import { runNextPass } from './next-pass';
import type { CliIo, DecodeRun } from './types';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** --lat/--lon, else BROWSDR_LAT/BROWSDR_LON. */
export function stationFrom(lat: number | undefined, lon: number | undefined): Site {
	const latitude = lat ?? Number(process.env.BROWSDR_LAT);
	const longitude = lon ?? Number(process.env.BROWSDR_LON);
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || process.env.BROWSDR_LAT === '')
		throw new Error('Set the station location with --lat/--lon or BROWSDR_LAT/BROWSDR_LON.');
	return { lat: latitude, lon: longitude, altM: 0 };
}

/** Celestrak TLEs, keeping the last good set when the network fails (they stay usable for days). */
function tleSource(): (now: Date) => Promise<Tle[]> {
	let last: { tles: Tle[]; at: number } | null = null;
	return async (now) => {
		if (last && now.getTime() - last.at < 12 * 3600e3) return last.tles;
		try {
			last = { tles: await fetchTles(METEOR_SATELLITES.map((satellite) => satellite.norad)), at: now.getTime() };
		} catch (error) {
			if (!last) throw error;
		}
		return last.tles;
	};
}

/** `passes`: the next Meteor passes over the station, in local time or as NDJSON. */
export async function listPasses(site: Site, hours: number, json: boolean, io: CliIo): Promise<number> {
	const now = new Date();
	const passes = predictPasses(await tleSource()(now), site, now, hours);
	for (const row of passRows(passes, now)) {
		io.out(json ? JSON.stringify(row.pass) : `${row.when.padEnd(14)} ${row.label.padEnd(12)} ${row.detail}${row.poor ? '  (low)' : ''}`);
	}
	return 0;
}

/** `decode meteor --next-pass [--repeat]` against the relay, one PNG per pass. */
export function capturePasses(site: Site, run: DecodeRun, repeat: boolean, io: CliIo): Promise<number> {
	return runNextPass({ site, repeat, take: run.take === true }, io, {
		now: () => new Date(),
		sleep: wait,
		tles: tleSource(),
		status: () => fetchRelayStatus(run.relay),
		capture: async (pass) => {
			const seconds = Math.ceil((pass.los.getTime() + 30_000 - Date.now()) / 1000);
			const freq = METEOR_SATELLITES.find((satellite) => satellite.norad === pass.norad)?.freqMHz;
			await runDecode('meteor', { ...run, ...(freq ? { freq } : {}), seconds, pngPrefix: `meteor-${pass.norad}` }, io);
		},
	});
}

// browsdr-cli: BrowSDR's decoders without a browser, fed by the Pi's rtl_tcp relay.
// npm run -s cli -- <status | bookmarks | decode adsb|rtl433|radiosonde> [options]   (see `npm run -s cli -- help`)
import { parseArgs } from 'node:util';
import { STATION_BOOKMARKS } from '@/app/workspace/station-bookmarks';
import { bookmarkDecode, describeBookmark } from './bookmarks';
import { fetchRelayStatus, runDecode } from './decode';
import { runFileDecode } from './file-decode';
import { capturePasses, listPasses, stationFrom } from './passes';
import type { CliIo, DecodeFlags, DecodeOptions, DecoderName } from './types';

const USAGE = `browsdr-cli <command> [options]

  status                     show the relay: who is connected, who controls, current tuning
  bookmarks                  list the station bookmarks (stations/radiopi.json, shared with the app)
  decode <adsb|rtl433|radiosonde|meteor>  decode for --seconds, one record per line
  decode --bookmark <id|name>      decode with a bookmark's decoder and tuning
  decode meteor --next-pass [--repeat]   wait for the next Meteor pass (20°+) and save its image
  decode <decoder> --iq-file <u8> --center <MHz> --rate <S/s>   decode a relay recording instead
  passes                     next Meteor-M passes over --lat/--lon (or BROWSDR_LAT/BROWSDR_LON)

Options:
  --relay <host:port|url>    relay address (default: $BROWSDR_RELAY)
  --seconds <n>              decode duration (default 60)
  --freq <MHz>               channel to decode (adsb 1090, rtl433 433.92, radiosonde 403)
  --take                     take control of the dongle (retunes every other client)
  --center <MHz> --rate <S/s> --gain <index 0-28>   tuning when this client controls
  --protocols <ids>          rtl_433 protocol numbers, e.g. 88,89 (default set otherwise)
  --bookmark <id|name>       a station bookmark (any unique part of its id or name);
                             explicit --freq/--center/--rate override it
  --json                     NDJSON records and a final summary on stdout
  --out <dir>                where Meteor PNGs go (default: current directory)
  --lat <deg> --lon <deg> --hours <n>   station location and look-ahead for passes

Without --take the CLI only tunes a free dongle; otherwise it decodes inside the band the
current controller chose, and refuses if the channel is outside it.`;

const io: CliIo = {
	out: (line) => process.stdout.write(line + '\n'),
	err: (line) => process.stderr.write(line + '\n'),
};

// Keep stdout for records: worker and WASM chatter goes to stderr.
for (const level of ['log', 'info', 'warn', 'debug'] as const) {
	console[level] = (...values: unknown[]) => io.err(values.map(String).join(' '));
}

function number(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Not a number: ${value}`);
	return parsed;
}

function defined<T extends object>(values: T): Partial<T> {
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The decoder named on the command line, or the one a --bookmark runs (they must agree). */
function decodeTarget(
	decoder: string | undefined,
	bookmark: string | undefined,
): { decoder: DecoderName; options: DecodeOptions } | undefined {
	const named = decoder === 'adsb' || decoder === 'rtl433' || decoder === 'radiosonde' || decoder === 'meteor' ? decoder : undefined;
	if (!bookmark) return named ? { decoder: named, options: {} } : undefined;
	const resolved = bookmarkDecode(STATION_BOOKMARKS, bookmark);
	if (decoder !== undefined && named !== resolved.decoder)
		throw new Error(`Bookmark "${bookmark}" runs ${resolved.decoder}, not ${decoder}.`);
	return resolved;
}

const OPTIONS = {
	relay: { type: 'string', default: process.env.BROWSDR_RELAY },
	seconds: { type: 'string', default: '60' },
	freq: { type: 'string' },
	center: { type: 'string' },
	rate: { type: 'string' },
	gain: { type: 'string' },
	protocols: { type: 'string' },
	bookmark: { type: 'string' },
	take: { type: 'boolean', default: false },
	'iq-file': { type: 'string' },
	out: { type: 'string' },
	'next-pass': { type: 'boolean', default: false },
	repeat: { type: 'boolean', default: false },
	lat: { type: 'string' },
	lon: { type: 'string' },
	hours: { type: 'string', default: '48' },
	json: { type: 'boolean', default: false },
} as const;

/** `decode`: a fixed-length run, or Meteor passes as they come (--next-pass). */
function decodeCommand(chosen: { decoder: DecoderName; options: DecodeOptions }, values: DecodeFlags, relay: string): Promise<number> {
	const run = {
		...chosen.options,
		...defined({
			freq: number(values.freq),
			center: number(values.center),
			rate: number(values.rate),
			protocols: values.protocols,
			out: values.out,
		}),
		relay,
		seconds: number(values.seconds) ?? 60,
		json: values.json,
		take: values.take,
		gain: number(values.gain),
	};
	if (values['next-pass'] && chosen.decoder === 'meteor')
		return capturePasses(stationFrom(number(values.lat), number(values.lon)), run, values.repeat, io);
	return runDecode(chosen.decoder, run, io);
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv.filter((arg) => arg !== '--'),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [command, decoder] = positionals;
	if (!command || command === 'help') {
		io.out(USAGE);
		return command ? 0 : 2;
	}
	if (command === 'bookmarks') {
		for (const row of STATION_BOOKMARKS.map(describeBookmark))
			io.out(
				values.json
					? JSON.stringify(row)
					: `${row.id.padEnd(24)} ${row.freq_mhz.toFixed(4).padStart(10)} MHz  ${row.use.padEnd(18)} ${row.name}`,
			);
		return 0;
	}
	if (command === 'passes')
		return listPasses(stationFrom(number(values.lat), number(values.lon)), number(values.hours) ?? 48, values.json, io);
	const target = command === 'decode' && values['iq-file'] ? decodeTarget(decoder, values.bookmark) : undefined;
	if (target && values['iq-file']) {
		return runFileDecode(
			target.decoder,
			{
				...target.options,
				...defined({ freq: number(values.freq), center: number(values.center), rate: number(values.rate), out: values.out }),
				iqFile: values['iq-file'],
				json: values.json,
			},
			io,
		);
	}
	if (!values.relay) throw new Error('Set --relay or BROWSDR_RELAY to the relay address, e.g. 192.168.250.2:8765.');
	if (command === 'status') {
		const status = await fetchRelayStatus(values.relay);
		io.out(values.json ? JSON.stringify(status) : JSON.stringify(status, null, 2));
		return 0;
	}
	const chosen = command === 'decode' ? decodeTarget(decoder, values.bookmark) : undefined;
	if (chosen) return decodeCommand(chosen, values, values.relay);
	io.err(USAGE);
	return 2;
}

/**
 * Lets the event loop drain instead of calling process.exit() straight away: on Windows, exiting
 * while a just-finished fetch is still closing its handles aborts Node (libuv async.c assertion).
 * The unref'd timer only forces the exit if something else keeps the process alive.
 */
function finish(code: number): void {
	process.exitCode = code;
	setTimeout(() => process.exit(code), 1000).unref();
}

main(process.argv.slice(2)).then(finish, (error: unknown) => {
	io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
	finish(1);
});

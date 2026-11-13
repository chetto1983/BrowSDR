// browsdr-cli: BrowSDR's decoders without a browser, fed by the Pi's rtl_tcp relay.
// npm run -s cli -- <status | bookmarks | decode adsb|rtl433|radiosonde> [options]   (see `npm run -s cli -- help`)
import { parseArgs } from 'node:util';
import { STATION_BOOKMARKS } from '@/app/workspace/station-bookmarks';
import { bookmarkDecode, describeBookmark } from './bookmarks';
import { fetchRelayStatus, runDecode } from './decode';
import type { CliIo, DecodeOptions, DecoderName } from './types';

const USAGE = `browsdr-cli <command> [options]

  status                     show the relay: who is connected, who controls, current tuning
  bookmarks                  list the station bookmarks (stations/radiopi.json, shared with the app)
  decode <adsb|rtl433|radiosonde>  decode for --seconds, one record per line
  decode --bookmark <id|name>      decode with a bookmark's decoder and tuning

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
	const named = decoder === 'adsb' || decoder === 'rtl433' || decoder === 'radiosonde' ? decoder : undefined;
	if (!bookmark) return named ? { decoder: named, options: {} } : undefined;
	const resolved = bookmarkDecode(STATION_BOOKMARKS, bookmark);
	if (decoder !== undefined && named !== resolved.decoder)
		throw new Error(`Bookmark "${bookmark}" runs ${resolved.decoder}, not ${decoder}.`);
	return resolved;
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv.filter((arg) => arg !== '--'),
		allowPositionals: true,
		options: {
			relay: { type: 'string', default: process.env.BROWSDR_RELAY },
			seconds: { type: 'string', default: '60' },
			freq: { type: 'string' },
			center: { type: 'string' },
			rate: { type: 'string' },
			gain: { type: 'string' },
			protocols: { type: 'string' },
			bookmark: { type: 'string' },
			take: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
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
	if (!values.relay) throw new Error('Set --relay or BROWSDR_RELAY to the relay address, e.g. 192.168.250.2:8765.');
	if (command === 'status') {
		const status = await fetchRelayStatus(values.relay);
		io.out(values.json ? JSON.stringify(status) : JSON.stringify(status, null, 2));
		return 0;
	}
	const chosen = command === 'decode' ? decodeTarget(decoder, values.bookmark) : undefined;
	if (chosen) {
		return runDecode(
			chosen.decoder,
			{
				...chosen.options,
				...defined({
					freq: number(values.freq),
					center: number(values.center),
					rate: number(values.rate),
					protocols: values.protocols,
				}),
				relay: values.relay,
				seconds: number(values.seconds) ?? 60,
				json: values.json,
				take: values.take,
				gain: number(values.gain),
			},
			io,
		);
	}
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

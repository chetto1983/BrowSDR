// browsdr-cli: BrowSDR's decoders without a browser, fed by the Pi's rtl_tcp relay.
// npm run -s cli -- <status | decode adsb|rtl433> [options]   (see `npm run -s cli -- help`)
import { parseArgs } from 'node:util';
import { fetchRelayStatus, runDecode } from './decode';
import type { CliIo, DecoderName } from './types';

const USAGE = `browsdr-cli <command> [options]

  status                     show the relay: who is connected, who controls, current tuning
  decode <adsb|rtl433|radiosonde>  decode for --seconds, one record per line

Options:
  --relay <host:port|url>    relay address (default: $BROWSDR_RELAY)
  --seconds <n>              decode duration (default 60)
  --freq <MHz>               channel to decode (adsb 1090, rtl433 433.92, radiosonde 403)
  --take                     take control of the dongle (retunes every other client)
  --center <MHz> --rate <S/s> --gain <index 0-28>   tuning when this client controls
  --protocols <ids>          rtl_433 protocol numbers, e.g. 88,89 (default set otherwise)
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
			take: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
		},
	});
	const [command, decoder] = positionals;
	if (!command || command === 'help') {
		io.out(USAGE);
		return command ? 0 : 2;
	}
	if (!values.relay) throw new Error('Set --relay or BROWSDR_RELAY to the relay address, e.g. 192.168.250.2:8765.');
	if (command === 'status') {
		const status = await fetchRelayStatus(values.relay);
		io.out(values.json ? JSON.stringify(status) : JSON.stringify(status, null, 2));
		return 0;
	}
	if (command === 'decode' && (decoder === 'adsb' || decoder === 'rtl433' || decoder === 'radiosonde')) {
		return runDecode(
			decoder satisfies DecoderName,
			{
				relay: values.relay,
				seconds: number(values.seconds) ?? 60,
				json: values.json,
				take: values.take,
				freq: number(values.freq),
				center: number(values.center),
				rate: number(values.rate),
				gain: number(values.gain),
				protocols: values.protocols,
			},
			io,
		);
	}
	io.err(USAGE);
	return 2;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	},
);

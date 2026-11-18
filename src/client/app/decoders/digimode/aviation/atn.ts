import type { DigimodeRecord } from '@/worker/decoders/digimode/types';
import { bytesOf, withFields } from './fields';
import { AtnNetwork } from './network';
import { AtnTransport } from './transport';
import { AtnApplications } from './ulcs';
import type { AviationPart, Field } from './types';

/**
 * ATN over VDL2 for one VFO: the X.25 packets of its frames through the ACARS library's passive stack (X.25, CLNP and
 * the Mobile SNDCF compression, COTP class 4, the ATN session, presentation and ACSE) up to CM and CPDLC (plain or
 * protected), whose messages become the record's fields and summary. The library reads; it never answers or fills a
 * gap. Each layer says in the record what it did with the frame.
 */
export class AtnStack implements AviationPart {
	private readonly network = new AtnNetwork();
	private readonly transport = new AtnTransport();
	private readonly applications = new AtnApplications();
	/** The library's reassemblers want reception times that never go back. */
	private time = 0;

	read<T extends DigimodeRecord>(record: T): T {
		const app = record.application;
		if (app?.kind !== 'atn') return record;
		this.time = Math.max(this.time, record.time);
		const downlink = app.direction === 'downlink';
		const network = this.network.read({
			air: (downlink ? app.source : app.destination).address,
			ground: (downlink ? app.destination : app.source).address,
			downlink,
			bytes: bytesOf(app.hex),
			time: this.time,
		});
		const fields: Field[] = [...network.fields];
		const summaries: string[] = [];
		if (network.up) {
			const transport = this.transport.read(network.up, downlink, this.time);
			fields.push(...transport.fields);
			for (const tsdu of transport.up ?? []) {
				const application = this.applications.read(tsdu, downlink);
				fields.push(...application.fields);
				if (application.summary) summaries.push(application.summary);
			}
		}
		return withFields(record, fields, summaries.length ? `: ${summaries.join('; ')}` : '');
	}
}

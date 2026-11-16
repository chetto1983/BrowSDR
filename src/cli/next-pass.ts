import { METEOR_SATELLITES } from '@/satellites/catalog';
import { predictPasses } from '@/satellites/passes';
import type { Pass } from '@/satellites/types';
import { errorMessage } from '@/platform/errors';
import { planDecode } from './plan';
import type { CliIo, DecodePlan, NextPassDeps, NextPassOptions, RelayStatus } from './types';

const LEAD_MS = 60_000;
const TAIL_MS = 30_000;
const LOOKAHEAD_HOURS = 48;
const RETRY_MS = 3600_000;

/** The capture plan for a pass under the usual relay rules, or why this pass has to be skipped. */
export function planPassCapture(pass: Pass, status: RelayStatus, take: boolean): DecodePlan | { skip: string } {
	const freq = METEOR_SATELLITES.find((satellite) => satellite.norad === pass.norad)?.freqMHz;
	try {
		return planDecode('meteor', { ...(freq ? { freq } : {}), take }, status);
	} catch (error) {
		return { skip: errorMessage(error) };
	}
}

function describe(pass: Pass): string {
	return `${pass.satellite} ${pass.aos.toISOString().slice(0, 16)}Z max ${Math.round(pass.maxElevation)}°`;
}

/** The first pass worth capturing (20° or more) that has not ended by `now`. */
async function nextGoodPass(options: NextPassOptions, deps: NextPassDeps, io: CliIo): Promise<Pass | null> {
	const now = deps.now();
	try {
		const passes = predictPasses(await deps.tles(now), options.site, now, LOOKAHEAD_HOURS);
		return passes.find((pass) => !pass.poor && pass.los.getTime() > now.getTime() + LEAD_MS) ?? null;
	} catch (error) {
		io.err(`no pass prediction: ${errorMessage(error)}`);
		return null;
	}
}

/** Captures one pass (or logs why not), then waits until it is over; false when the capture failed. */
async function handlePass(pass: Pass, options: NextPassOptions, deps: NextPassDeps, io: CliIo): Promise<boolean> {
	let ok = true;
	let status: RelayStatus | undefined;
	try {
		status = await deps.status();
	} catch (error) {
		io.err(`skipped ${describe(pass)}: relay status unavailable (${errorMessage(error)})`);
		ok = false;
	}
	const plan = status ? planPassCapture(pass, status, options.take) : undefined;
	if (plan && 'skip' in plan) io.err(`skipped ${describe(pass)}: ${plan.skip}`);
	else if (plan) {
		try {
			await deps.capture(pass, plan);
		} catch (error) {
			io.err(`capture failed for ${describe(pass)}: ${errorMessage(error)}`);
			ok = false;
		}
	}
	// A capture that ended early must not pick the same pass up again.
	await deps.sleep(Math.max(0, pass.los.getTime() + TAIL_MS - deps.now().getTime()));
	return ok;
}

/**
 * Waits for the next good Meteor pass and captures it from AOS - 1 min to LOS + 30 s; with `repeat`, keeps
 * going pass after pass, past relay errors. A pass is skipped (never retuning anyone) when another client
 * holds the dongle on another band, unless `take` is set.
 */
export async function runNextPass(options: NextPassOptions, io: CliIo, deps: NextPassDeps): Promise<number> {
	for (let handled = 0; !options.maxPasses || handled < options.maxPasses;) {
		const pass = await nextGoodPass(options, deps, io);
		if (!pass) {
			if (!options.repeat) return 1;
			await deps.sleep(RETRY_MS);
			continue;
		}
		io.err(`next pass: ${describe(pass)}`);
		const wait = pass.aos.getTime() - LEAD_MS - deps.now().getTime();
		if (wait > 0) await deps.sleep(wait);
		const ok = await handlePass(pass, options, deps, io);
		handled++;
		if (!options.repeat) return ok ? 0 : 1;
	}
	return 0;
}

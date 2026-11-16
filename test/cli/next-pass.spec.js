import { describe, expect, it, vi } from 'vitest';
import { planPassCapture, runNextPass } from '../../src/cli/next-pass';
import { predictPasses } from '@/satellites/passes';
import { parseTle } from '@/satellites/tle';
import { METEOR_TLE, SITE } from '../satellites/fixtures';

const tles = parseTle(METEOR_TLE);
const passes = predictPasses(tles, SITE, new Date('2026-11-16T07:00:00Z'), 24);
const good = passes.find((pass) => pass.aos.toISOString().startsWith('2026-11-16T09:05'));
const idle = { connected: false, state: { frequency_hz: 0, sample_rate: 0, gain_index: 0 }, clients: [] };
const busyAt = (frequencyHz, sampleRate) => ({
	connected: true,
	state: { frequency_hz: frequencyHz, sample_rate: sampleRate, gain_index: 12 },
	clients: [{ id: 1, kind: 'ws', remote: 'browser', controller: true }],
});

describe('capturing a pass without stepping on the user', () => {
	it('leaves a user listening elsewhere alone', () => {
		const plan = planPassCapture(good, busyAt(403_500_000, 1_024_000), false);
		expect(plan.skip).toMatch(/outside that band/);
	});
	it('tunes a free dongle for the pass', () => {
		expect(planPassCapture(good, idle, false)).toMatchObject({ role: 'controller', centerMHz: 137.75, freqMHz: 137.9 });
	});
	it('listens along when the controller is already on Meteor', () => {
		expect(planPassCapture(good, busyAt(137_750_000, 1_024_000), false)).toMatchObject({ role: 'listener' });
	});
});

describe('waiting for passes', () => {
	function fakeRun(startIso, { repeat = false, status = idle } = {}) {
		let now = Date.parse(startIso);
		const captured = [];
		const logs = [];
		const deps = {
			now: () => new Date(now),
			sleep: async (ms) => {
				now += ms;
			},
			tles: async () => tles,
			status: async () => status,
			capture: async (pass, plan) => {
				captured.push([pass.satellite, pass.aos.toISOString().slice(0, 16), plan.role]);
				now = pass.los.getTime() + 30_000;
			},
		};
		return { deps, captured, logs, io: { out: (line) => logs.push(line), err: (line) => logs.push(line) }, repeat };
	}
	it('skips poor passes and captures the next good one', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z');
		await runNextPass({ site: SITE, repeat: false, take: false }, run.io, run.deps);
		expect(run.captured).toEqual([['Meteor-M2 3', '2026-11-16T09:05', 'controller']]);
	});
	it('keeps going pass after pass with --repeat', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z');
		await runNextPass({ site: SITE, repeat: true, take: false, maxPasses: 3 }, run.io, run.deps);
		expect(run.captured.map(([, aos]) => aos)).toEqual(['2026-11-16T09:05', '2026-11-16T13:10', '2026-11-16T14:51']);
	});
	it('survives a relay error with --repeat and goes on to the next pass', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z', { repeat: true });
		const capture = run.deps.capture;
		let calls = 0;
		run.deps.capture = async (pass, plan) => {
			if (calls++ === 0) throw new Error('relay unreachable'); // fails at once, without the pass going by
			return capture(pass, plan);
		};
		await runNextPass({ site: SITE, repeat: true, take: false, maxPasses: 2 }, run.io, run.deps);
		expect(run.captured.map(([, aos]) => aos)).toEqual(['2026-11-16T13:10']);
		expect(run.logs.some((line) => /failed.*relay unreachable/.test(line))).toBe(true);
	});
	it('reports a failed capture without --repeat', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z');
		run.deps.capture = async () => {
			throw new Error('relay unreachable');
		};
		expect(await runNextPass({ site: SITE, repeat: false, take: false }, run.io, run.deps)).toBe(1);
	});
	it('skips the pass when the relay status cannot be read', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z');
		let reads = 0;
		run.deps.status = async () => {
			if (reads++ === 0) throw new Error('fetch failed');
			return idle;
		};
		await runNextPass({ site: SITE, repeat: true, take: false, maxPasses: 2 }, run.io, run.deps);
		expect(run.captured.map(([, aos]) => aos)).toEqual(['2026-11-16T13:10']);
		expect(run.logs.some((line) => /skipped.*fetch failed/.test(line))).toBe(true);
	});
	it('never captures the same pass twice when a capture ends early', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z');
		run.deps.capture = async (pass, plan) => void run.captured.push([pass.satellite, pass.aos.toISOString().slice(0, 16), plan.role]);
		await runNextPass({ site: SITE, repeat: true, take: false, maxPasses: 2 }, run.io, run.deps);
		expect(run.captured.map(([, aos]) => aos)).toEqual(['2026-11-16T09:05', '2026-11-16T13:10']);
	});
	it('logs and moves on when the user holds the dongle elsewhere', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z', { status: busyAt(403_500_000, 1_024_000) });
		const capture = vi.spyOn(run.deps, 'capture');
		await runNextPass({ site: SITE, repeat: true, take: false, maxPasses: 2 }, run.io, run.deps);
		expect(capture).not.toHaveBeenCalled();
		expect(run.logs.filter((line) => line.includes('skipped')).length).toBe(2);
	});
});

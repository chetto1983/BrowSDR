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
	it('logs and moves on when the user holds the dongle elsewhere', async () => {
		const run = fakeRun('2026-11-16T07:00:00Z', { status: busyAt(403_500_000, 1_024_000) });
		const capture = vi.spyOn(run.deps, 'capture');
		await runNextPass({ site: SITE, repeat: true, take: false, maxPasses: 2 }, run.io, run.deps);
		expect(capture).not.toHaveBeenCalled();
		expect(run.logs.filter((line) => line.includes('skipped')).length).toBe(2);
	});
});

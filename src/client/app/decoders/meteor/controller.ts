import { toRaw } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import type { MeteorMessage } from '@/worker/decoders/meteor/types';
import type { Pass } from '@/satellites/types';
import { METEOR_SATELLITES } from '@/satellites/catalog';
import { predictPasses } from '@/satellites/passes';
import { errorMessage } from '@/platform/errors';
import { MeteorImage } from './image';
import { loadStation, meteorTles, saveStation } from './station';
import { tuneForMeteor } from './tuning';

const PASS_HOURS = 48;
const ARM_LEAD_MS = 60_000;
const ARM_TAIL_MS = 30_000;

/** Images live outside Vue's reactivity (megabytes of pixels); `meteor.imageVersion` signals changes. */
const images = new WeakMap<object, MeteorImage[]>();
const timers = new WeakMap<object, Array<ReturnType<typeof setTimeout>>>();
const wakeLocks = new WeakMap<object, { release(): Promise<void> }>();

export function meteorImage(receiver: AppInstance, index: number): MeteorImage {
	const key = toRaw(receiver);
	const list = images.get(key) ?? [];
	images.set(key, list);
	return (list[index] ??= new MeteorImage());
}

function clearArm(receiver: AppInstance): void {
	const key = toRaw(receiver);
	for (const timer of timers.get(key) ?? []) clearTimeout(timer);
	timers.delete(key);
	void wakeLocks
		.get(key)
		?.release()
		.catch(() => undefined);
	wakeLocks.delete(key);
	receiver.meteor.armed = null;
}

async function holdScreenOn(receiver: AppInstance): Promise<void> {
	const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
	if (!wakeLock) return;
	try {
		wakeLocks.set(toRaw(receiver), await wakeLock.request('screen'));
	} catch {
		/* Not granted (page hidden, or not supported): the banner still asks to keep the screen on. */
	}
}

export const meteorMethods = {
	toggleMeteorPanel(this: AppInstance): void {
		this.meteor.panelOpen = !this.meteor.panelOpen;
		if (this.meteor.panelOpen) void this.meteorRefreshPasses();
	},
	_onMeteorMessage(this: AppInstance, index: number, freq: number, message: MeteorMessage): void {
		const vfo = this.vfos[index];
		if (!vfo?.meteor || vfo.freq !== freq || message.freq !== freq) return;
		const source = this.meteor.sources[index];
		if (source?.freq !== freq) {
			meteorImage(this, index).reset();
			this.meteor.sources[index] = { freq };
		}
		this.meteor.status[index] = message.status;
		if (message.rows) {
			meteorImage(this, index).append(message.rows);
			this.meteor.imageVersion++;
		}
	},
	meteorStatusText(this: AppInstance, index: number): string {
		if (!this.running) return 'Start reception to decode';
		const status = this.meteor.sources[index]?.freq === this.vfos[index]?.freq ? this.meteor.status[index] : null;
		if (!status) return 'Starting decoder…';
		if (status.state !== 'receiving') return status.message;
		const signal = status.locked ? ` · quality ${status.quality.toFixed(2)} · offset ${Math.round(status.freqOffsetHz)} Hz` : '';
		const decode = status.mpdus ? ` · ${meteorImage(this, index).rows} lines · Viterbi ${status.vit} · RS ${status.rs}` : '';
		return `${status.message}${signal}${decode}`;
	},
	async meteorRefreshPasses(this: AppInstance, now = new Date()): Promise<void> {
		this.meteor.site ??= loadStation();
		if (!this.meteor.site) {
			this.meteor.passes = [];
			this.meteor.passMessage = 'Set the station location first.';
			return;
		}
		try {
			const { tles, note } = await meteorTles(now);
			this.meteor.passes = predictPasses(tles, this.meteor.site, now, PASS_HOURS);
			this.meteor.tleNote = note;
			this.meteor.passMessage = this.meteor.passes.length ? '' : 'No passes in the next 48 hours.';
		} catch (error) {
			this.meteor.passes = [];
			this.meteor.passMessage = errorMessage(error);
		}
	},
	meteorSetLocation(this: AppInstance, lat: number, lon: number): void {
		if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
			this.meteor.notice = 'Enter latitude (-90 to 90) and longitude (-180 to 180) in degrees.';
			return;
		}
		this.meteor.site = { lat, lon, altM: 0 };
		saveStation(this.meteor.site);
		this.meteor.notice = '';
		void this.meteorRefreshPasses();
	},
	meteorUseMyPosition(this: AppInstance): void {
		if (!navigator.geolocation) {
			this.meteor.notice = 'This browser cannot report its position; enter it by hand.';
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(position) => this.meteorSetLocation(+position.coords.latitude.toFixed(3), +position.coords.longitude.toFixed(3)),
			(error) => (this.meteor.notice = `Position unavailable: ${error.message}`),
		);
	},
	async meteorTune(this: AppInstance, pass?: Pass): Promise<boolean> {
		const freq = METEOR_SATELLITES.find((satellite) => satellite.norad === pass?.norad)?.freqMHz;
		this.meteor.notice = await tuneForMeteor(this, freq);
		const refused = this.meteor.notice.startsWith('Another client');
		if (!refused && pass) this.meteor.norad = pass.norad;
		return !refused;
	},
	meteorArm(this: AppInstance, pass: Pass): void {
		clearArm(this);
		const now = Date.now();
		const start = Math.max(0, pass.aos.getTime() - ARM_LEAD_MS - now);
		const end = Math.max(start, pass.los.getTime() + ARM_TAIL_MS - now);
		this.meteor.armed = {
			key: `${pass.norad}-${pass.aos.toISOString()}`,
			norad: pass.norad,
			aos: pass.aos.getTime(),
			los: pass.los.getTime(),
		};
		void holdScreenOn(this);
		const key = toRaw(this);
		timers.set(key, [
			setTimeout(() => {
				void this.meteorTune(pass).then((tuned) => {
					if (!tuned) clearArm(this);
				});
			}, start),
			setTimeout(() => clearArm(this), end),
		]);
	},
	meteorDisarm(this: AppInstance): void {
		clearArm(this);
	},
};

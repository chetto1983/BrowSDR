import type { AppInstance } from '@/app/core/receiver.types';
import type { WorkspaceInstance } from '@/app/workspace/types';
import { restoreDeviceGains } from '@/app/radio/gain-settings';
import { fitTuningToDevice } from '@/app/radio/connection';
import { errorMessage } from '@/platform/errors';

const STORAGE_KEY = 'browsdr.rtlTcpUrl';

/**
 * The relay on the Pi serves this page over HTTPS next to the radio, so a page loaded that way
 * finds the radio on its own origin; any other page has no relay to assume.
 */
export function defaultRtlTcpUrl(location: { protocol: string; host: string }): string {
	return location.protocol === 'https:' ? `wss://${location.host}/` : '';
}

/** Last rtl_tcp bridge address (a per-browser convenience), else the relay that served the page. */
export function savedRtlTcpUrl(): string {
	let saved = '';
	try {
		saved = localStorage.getItem(STORAGE_KEY) ?? '';
	} catch {
		/* Storage may be unavailable; fall back to the default below. */
	}
	return saved || defaultRtlTcpUrl(globalThis.location ?? { protocol: '', host: '' });
}

function rememberRtlTcpUrl(address: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, address);
	} catch {
		/* Storage may be unavailable; the address field still works for this session. */
	}
}

export const rtlTcpMethods = {
	async connectRtlTcp(this: AppInstance, address: string) {
		if (this.remoteMode === 'client' || this.workspace?.mode === 'client' || !address.trim()) return;
		this.devicePicker.show = false;
		this._initAudioCtx(); // create AudioContext within user gesture
		rememberRtlTcpUrl(address.trim());
		if (this.workspace) return this.workspace.connectRtlTcp(this, address);
		return this._connectRtlTcp(address);
	},
	async _connectRtlTcp(this: AppInstance, address: string) {
		if (!this.backend || this.connected) return;
		this.deviceInfoCollapsed = true;
		this.info.device = null;
		this.showMsg('Connecting to rtl_tcp...');
		try {
			await this.backend.openRtlTcp(address);
		} catch (error) {
			this.showMsg('rtl_tcp connection failed: ' + errorMessage(error));
			return;
		}
		try {
			this.connected = true;
			const info = await this.backend.info();
			this.info.boardName = info.name;
			this.info.device = info;
			const caps = await this.backend.getDeviceCapabilities();
			this.deviceCapabilities = caps;
			let retuned = '';
			if (caps) {
				const saved = this.gainDeviceType === caps.deviceType ? this.gains : {};
				this.gains = restoreDeviceGains(caps, saved);
				this.gainDeviceType = caps.deviceType;
				if (!caps.sampleRates.includes(this.radio.sampleRate)) this.radio.sampleRate = 2048000;
				retuned = fitTuningToDevice(this, caps.frequencyRange);
			}
			this.showMsg('Connected to ' + (info.product ?? info.name) + ' over rtl_tcp' + retuned);
			await this.startStream();
		} catch (error) {
			await this.backend.close();
			this.connected = false;
			this.deviceCapabilities = null;
			this.showMsg('rtl_tcp connection failed: ' + errorMessage(error));
		}
	},
};

export async function connectRtlTcp(workspace: WorkspaceInstance, source: AppInstance, address: string): Promise<void> {
	if (workspace.mode === 'client' || source._connectingDevice || source._removing) return;
	source._connectingDevice = true;
	try {
		const app = source.connected ? await workspace.newReceiver() : source;
		if (!app) return;
		await app._connectRtlTcp(address);
		if (app.connected && workspace.mode === 'host') await workspace.attachHostReceiver(app);
		workspace.broadcastReceivers();
	} finally {
		source._connectingDevice = false;
	}
}

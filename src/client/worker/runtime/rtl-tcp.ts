import type { Backend } from '@/worker/runtime/backend';
import { RtlTcpDevice } from '@/devices/rtltcp/device';
import { normalizeRtlTcpUrl } from '@/devices/rtltcp/protocol';

/** Connects this receiver to an rtl_tcp server through a WebSocket bridge. */
export async function openRtlTcp(this: Backend, address: string): Promise<void> {
	if (this.device) throw new Error('A receiver is already connected.');
	const device = new RtlTcpDevice(normalizeRtlTcpUrl(address));
	try {
		await device.open();
	} catch (error) {
		await device.close().catch(() => undefined);
		throw error;
	}
	this.device = device;
}

import type { Backend } from '@/worker/runtime/backend';
import { RtlTcpDevice } from '@/devices/rtltcp/device';
import { normalizeRtlTcpUrl } from '@/devices/rtltcp/protocol';
import { newRelayToken, relayTokenOf, withRelayClient } from '@/devices/rtltcp/relay-control';

/** Connects this receiver to an rtl_tcp server through a WebSocket bridge, naming the connection for the Pi relay. */
export async function openRtlTcp(this: Backend, address: string): Promise<void> {
	if (this.device) throw new Error('A receiver is already connected.');
	const device = new RtlTcpDevice(withRelayClient(normalizeRtlTcpUrl(address), newRelayToken()));
	try {
		await device.open();
	} catch (error) {
		await device.close().catch(() => undefined);
		throw error;
	}
	this.device = device;
}

/** The relay connection of this receiver (URL and token), or null when it is not an rtl_tcp source. */
export function relayConnection(this: Backend): { url: string; token: string } | null {
	if (!(this.device instanceof RtlTcpDevice)) return null;
	const token = relayTokenOf(this.device.url);
	return token ? { url: this.device.url, token } : null;
}

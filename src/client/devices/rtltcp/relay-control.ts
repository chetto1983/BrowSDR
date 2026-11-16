import type { RelayClients, RelayRole } from './types';

/*
 * The Pi relay lets each WebSocket client name itself with ?client=<token> and reports the token in
 * GET /status, so a client can tell for certain whether its commands reach the dongle.
 */

/** Adds `client=<token>` (and `control=take` when asked) to a relay WebSocket URL, keeping its other parameters. */
export function withRelayClient(wsUrl: string, token: string, take = false): string {
	const url = new URL(wsUrl);
	url.searchParams.set('client', token);
	if (take) url.searchParams.set('control', 'take');
	return url.href;
}

/** The token a connection URL carries, or null for a connection that did not name itself. */
export function relayTokenOf(wsUrl: string): string | null {
	return new URL(wsUrl).searchParams.get('client');
}

/** ws(s)://host/... → http(s)://host/status */
export function relayStatusUrl(wsUrl: string): string {
	const url = new URL(wsUrl);
	return `${url.protocol === 'wss:' ? 'https' : 'http'}://${url.host}/status`;
}

/** 16 random base-36 characters, inside the relay's accepted alphabet. */
export function newRelayToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}

export function relayRole(status: RelayClients, token: string): RelayRole | 'unknown' {
	// A relay built before client tokens reports none: nobody can be recognised.
	if (status.clients.length && !status.clients.some((client) => client.client)) return 'unknown';
	const me = status.clients.find((client) => client.client === token);
	if (!me) return 'absent';
	return me.controller ? 'controller' : 'listener';
}

/** Reads /status; 'unknown' when it cannot be read (no relay, mixed content, network down). */
export async function fetchRelayRole(wsUrl: string, token: string): Promise<RelayRole | 'unknown'> {
	try {
		const response = await fetch(relayStatusUrl(wsUrl), { signal: AbortSignal.timeout(4000) });
		if (!response.ok) return 'unknown';
		return relayRole((await response.json()) as RelayClients, token);
	} catch {
		return 'unknown';
	}
}

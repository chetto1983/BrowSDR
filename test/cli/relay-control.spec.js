import { describe, expect, it } from 'vitest';
import { newRelayToken, relayRole, relayStatusUrl, relayTokenOf, withRelayClient } from '@/devices/rtltcp/relay-control';

describe('relay client identity', () => {
	it('adds the client token and an optional take to the WebSocket URL', () => {
		expect(withRelayClient('wss://h:8443/', 'abc', true)).toBe('wss://h:8443/?client=abc&control=take');
		expect(withRelayClient('ws://h/?x=1', 'abc')).toBe('ws://h/?x=1&client=abc');
	});
	it('reads the token back from a connection URL', () => {
		expect(relayTokenOf('ws://h/?x=1&client=abc')).toBe('abc');
		expect(relayTokenOf('ws://h/')).toBeNull();
	});
	it('derives the status URL from the WebSocket URL', () => {
		expect(relayStatusUrl('wss://h:8443/')).toBe('https://h:8443/status');
		expect(relayStatusUrl('ws://192.168.250.2:8765/?client=x')).toBe('http://192.168.250.2:8765/status');
	});
	it('makes distinct 16-character tokens the relay accepts', () => {
		const a = newRelayToken();
		expect(a).toMatch(/^[a-z0-9]{16}$/);
		expect(newRelayToken()).not.toBe(a);
	});
	it('tells controller, listener and absent apart', () => {
		const clients = [
			{ controller: true, client: 'me' },
			{ controller: false, client: 'other' },
		];
		expect(relayRole({ clients }, 'me')).toBe('controller');
		expect(relayRole({ clients }, 'other')).toBe('listener');
		expect(relayRole({ clients }, 'gone')).toBe('absent');
	});
});

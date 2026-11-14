import { describe, expect, it } from 'vitest';
import { defaultRtlTcpUrl } from '@/app/network/rtl-tcp';

describe('rtl_tcp default address', () => {
	it('points at the relay that served the page over HTTPS', () => {
		expect(defaultRtlTcpUrl({ protocol: 'https:', host: '192.168.1.83:8443' })).toBe('wss://192.168.1.83:8443/');
	});

	it('suggests nothing for a page served from elsewhere', () => {
		// A plain-HTTP page (the dev server) does not sit next to a relay.
		expect(defaultRtlTcpUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('');
	});
});

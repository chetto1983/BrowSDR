import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import worker from '../../src/server';
import { TINYGS_TLE_SOURCE, validTleText } from '../../src/server/tinygs';

const TLE = `Norby-2
1 57179U 23091P   26325.27201282  .00003326  00000-0  16892-3 0  9999
2 57179  97.4899  19.6340 0013066 303.8105  56.1884 15.17520022187605
FossaSat-2E27
1 A1140U 26237AF  26324.92364408  .00000654  00000-0  88240-4 0  9990
2 A1140  52.9828 184.5495 0007272  23.5042 336.6270 14.91890940  4705
`;

function upstream(status, body) {
	const url = new URL(TINYGS_TLE_SOURCE);
	fetchMock.get(url.origin).intercept({ path: url.pathname }).reply(status, body);
}

async function get(origin, method = 'GET') {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`${origin}/api/tinygs/tle`, { method }), env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("TinyGS's element file", () => {
	it('is fetched once, served same-origin with isolation headers and kept for six hours', async () => {
		upstream(200, TLE);
		const first = await get('http://first.example');
		expect(first.status).toBe(200);
		expect(await first.text()).toBe(TLE);
		expect(first.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
		expect(first.headers.get('Cache-Control')).toBe('public, max-age=21600');
		expect(first.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
		expect(first.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		// no second request to TinyGS: the network is shut and nothing is intercepted any more
		const second = await get('http://first.example');
		expect(second.status).toBe(200);
		expect(await second.text()).toBe(TLE);
	});
	it("reports TinyGS's failures and keeps no copy of them", async () => {
		upstream(503, 'Service Unavailable');
		const down = await get('http://down.example');
		expect(down.status).toBe(502);
		expect(await down.text()).toBe('TinyGS returned HTTP 503.');
		expect(down.headers.get('Cache-Control')).toBe('no-store');
		upstream(200, '<html>Missing client timestamp</html>');
		const page = await get('http://down.example');
		expect(page.status).toBe(502);
		expect(await page.text()).toBe('TinyGS sent no element sets.');
		upstream(200, TLE);
		const back = await get('http://down.example');
		expect(back.status).toBe(200);
		expect(await back.text()).toBe(TLE);
	});
	it('answers only reads', async () => {
		const response = await get('http://post.example', 'POST');
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, HEAD');
	});
	it('takes element sets only, Alpha-5 numbers included', () => {
		expect(validTleText(TLE)).toBe(true);
		expect(validTleText('')).toBe(false);
		expect(validTleText('Not found')).toBe(false);
		expect(validTleText(`${TLE}\u0000`)).toBe(false);
		expect(validTleText('x'.repeat(600 * 1024))).toBe(false);
	});
});

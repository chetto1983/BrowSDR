/**
 * TinyGS's element file of the satellites it supports, documented for gpredict and Look4Sat (TinyGS wiki, TLE.md). It
 * sends no CORS header, so browsers cannot read it from TinyGS: this route fetches it at most every six hours and serves
 * it same-origin. Only this public file is read; TinyGS's API is not used.
 */
export const TINYGS_TLE_SOURCE = 'https://api.tinygs.com/v1/tinygs_supported.txt';
export const TINYGS_TLE_PATH = '/api/tinygs/tle';
export const TINYGS_TLE_MAX_AGE_S = 6 * 3600;
const MAX_LENGTH = 512 * 1024;

/** Text of element sets (lines 1 and 2, nothing binary), not an error page. */
export function validTleText(text: string): boolean {
	if (!text || text.length > MAX_LENGTH) return false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false;
	}
	const lines = text.split(/\r?\n/);
	return lines.some((line) => /^1 [0-9A-Z]{5}/.test(line)) && lines.some((line) => /^2 [0-9A-Z]{5}/.test(line));
}

function failure(message: string, headers: Record<string, string>): Response {
	return new Response(message, {
		status: 502,
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
	});
}

/** The element file from the worker's cache, or fetched from TinyGS and cached for six hours. */
export async function tinygsTle(request: Request, ctx: ExecutionContext, headers: Record<string, string>): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD')
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', ...headers } });
	const cache = caches.default;
	const key = new Request(new URL(TINYGS_TLE_PATH, request.url).toString());
	const hit = await cache.match(key);
	if (hit) return hit;
	let upstream: Response;
	try {
		upstream = await fetch(TINYGS_TLE_SOURCE, { headers: { 'User-Agent': 'BrowSDR-Worker', Accept: 'text/plain' } });
	} catch {
		return failure('TinyGS could not be reached.', headers);
	}
	if (!upstream.ok) return failure(`TinyGS returned HTTP ${upstream.status}.`, headers);
	const text = await upstream.text();
	if (!validTleText(text)) return failure('TinyGS sent no element sets.', headers);
	const response = new Response(request.method === 'HEAD' ? null : text, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': `public, max-age=${TINYGS_TLE_MAX_AGE_S}`,
			...headers,
		},
	});
	if (request.method === 'GET') ctx.waitUntil(cache.put(key, response.clone()));
	return response;
}

import { ecfToEci, eciToGeodetic, geodeticToEcf, gstime, propagate } from 'satellite.js';
import type { Tle } from '@/satellites/types';
import { satrecFor } from '@/satellites/orbit';
import type { MeteorImage } from './image';
import type { Point, ProjectedImage, ScanGrid, Vec3 } from './projection.types';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const WGS84_A = 6378.137;
const WGS84_B = 6356.752314245;
const MERCATOR_LIMIT = 85.05112878;
const SCAN_ANGLE = 110.1;
const GRID_X = 64;
const GRID_Y = 16;
const MAX_RASTER = 2048;

const norm = (v: Vec3): Vec3 => {
	const length = Math.hypot(v.x, v.y, v.z);
	return { x: v.x / length, y: v.y / length, z: v.z / length };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** SatDump's normal_single_line geometry: roll the nadir ray about orbital velocity, then intersect WGS84. */
export function groundPoint(tle: Tle, timeMs: number, x: number): { lat: number; lon: number } | null {
	const time = new Date(timeMs + (tle.norad === 59051 ? 1000 : 0));
	const state = propagate(satrecFor(tle), time);
	if (!state || typeof state.position !== 'object' || typeof state.velocity !== 'object') return null;
	const position = state.position;
	const gmst = gstime(time);
	const geodetic = eciToGeodetic(position, gmst);
	const ground = ecfToEci(geodeticToEcf({ latitude: geodetic.latitude, longitude: geodetic.longitude, height: 0 }), gmst);
	const nadir = norm({ x: ground.x - position.x, y: ground.y - position.y, z: ground.z - position.z });
	const velocity = norm(state.velocity);
	const roll = (((x - 1568 / 2) / 1568) * SCAN_ANGLE + (tle.norad === 59051 ? -0.4 : -0.31)) * RAD;
	const side = cross(velocity, nadir);
	const ray = norm({
		x: nadir.x * Math.cos(roll) + side.x * Math.sin(roll),
		y: nadir.y * Math.cos(roll) + side.y * Math.sin(roll),
		z: nadir.z * Math.cos(roll) + side.z * Math.sin(roll),
	});
	const a2 = WGS84_A * WGS84_A;
	const b2 = WGS84_B * WGS84_B;
	const a = (ray.x * ray.x + ray.y * ray.y) / a2 + (ray.z * ray.z) / b2;
	const b = (2 * (position.x * ray.x + position.y * ray.y)) / a2 + (2 * position.z * ray.z) / b2;
	const c = (position.x * position.x + position.y * position.y) / a2 + (position.z * position.z) / b2 - 1;
	const discriminant = b * b - 4 * a * c;
	if (discriminant < 0) return null;
	const distance = (-b - Math.sqrt(discriminant)) / (2 * a);
	if (distance <= 0) return null;
	const intersection = {
		x: position.x + distance * ray.x,
		y: position.y + distance * ray.y,
		z: position.z + distance * ray.z,
	};
	const result = eciToGeodetic(intersection, gmst);
	const lat = result.latitude * DEG;
	return Math.abs(lat) <= MERCATOR_LIMIT ? { lat, lon: result.longitude * DEG } : null;
}

const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
const inverseY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * DEG;

/** Paint one source triangle onto the north-up Web Mercator raster. */
function paintTriangle(
	dest: Uint8ClampedArray,
	dw: number,
	dh: number,
	source: Uint8ClampedArray,
	sw: number,
	sh: number,
	p: Point,
	q: Point,
	r: Point,
): void {
	const det = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
	if (Math.abs(det) < 0.01) return;
	const minX = Math.max(0, Math.floor(Math.min(p.x, q.x, r.x)));
	const maxX = Math.min(dw - 1, Math.ceil(Math.max(p.x, q.x, r.x)));
	const minY = Math.max(0, Math.floor(Math.min(p.y, q.y, r.y)));
	const maxY = Math.min(dh - 1, Math.ceil(Math.max(p.y, q.y, r.y)));
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const dx = x + 0.5 - p.x;
			const dy = y + 0.5 - p.y;
			const u = (dx * (r.y - p.y) - dy * (r.x - p.x)) / det;
			const v = (dy * (q.x - p.x) - dx * (q.y - p.y)) / det;
			if (u < -0.001 || v < -0.001 || u + v > 1.001) continue;
			const sx = Math.round(p.sx + u * (q.sx - p.sx) + v * (r.sx - p.sx));
			const sy = Math.round(p.sy + u * (q.sy - p.sy) + v * (r.sy - p.sy));
			if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;
			const src = (sy * sw + sx) * 4;
			const dst = (y * dw + x) * 4;
			dest[dst] = source[src];
			dest[dst + 1] = source[src + 1];
			dest[dst + 2] = source[src + 2];
			dest[dst + 3] = 230;
		}
	}
}

function scanGrid(image: MeteorImage, tle: Tle): ScanGrid | null {
	const xs = Array.from({ length: Math.ceil((image.width - 1) / GRID_X) + 1 }, (_, i) => Math.min(i * GRID_X, image.width - 1));
	const ys = Array.from({ length: Math.ceil((image.rows - 1) / GRID_Y) + 1 }, (_, i) => Math.min(i * GRID_Y, image.rows - 1));
	const points: Array<Array<Point | null>> = [];
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	let referenceLon: number | null = null;
	for (const sy of ys) {
		const timeMs = image.timeAt(sy);
		const row: Array<Point | null> = [];
		for (const sx of xs) {
			const ground = timeMs === null || Math.abs(timeMs - tle.epoch.getTime()) > 7 * 86400e3 ? null : groundPoint(tle, timeMs, sx);
			if (!ground) {
				row.push(null);
				continue;
			}
			referenceLon ??= ground.lon;
			const lon = ground.lon + 360 * Math.round((referenceLon - ground.lon) / 360);
			const point = { x: lon * RAD, y: mercatorY(ground.lat), sx, sy };
			minX = Math.min(minX, point.x);
			maxX = Math.max(maxX, point.x);
			minY = Math.min(minY, point.y);
			maxY = Math.max(maxY, point.y);
			row.push(point);
		}
		points.push(row);
	}
	if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
	return { xs, ys, points, minX, maxX, minY, maxY };
}

/** Turn timed scan rows into an actual north-up raster that Leaflet can place over map tiles. */
export function projectImage(image: MeteorImage, tle: Tle, view: 'rgb' | 0 | 1 | 2): ProjectedImage | null {
	if (image.rows < 16 || image.timedBlocks < 2) return null;
	const grid = scanGrid(image, tle);
	if (!grid) return null;
	const { xs, ys, points, minX, maxX, minY, maxY } = grid;
	const scale = Math.min(MAX_RASTER / (maxX - minX), MAX_RASTER / (maxY - minY));
	const width = Math.max(1, Math.ceil((maxX - minX) * scale));
	const height = Math.max(1, Math.ceil((maxY - minY) * scale));
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) return null;
	const dest = context.createImageData(width, height);
	const source = image.rgba(view);
	const pixel = (point: Point): Point => ({ ...point, x: (point.x - minX) * scale, y: (maxY - point.y) * scale });
	for (let yi = 0; yi + 1 < ys.length; yi++) {
		const first = image.timeAt(ys[yi]);
		const last = image.timeAt(ys[yi + 1]);
		if (first === null || last === null || last <= first || last - first > (ys[yi + 1] - ys[yi]) * 1000) continue;
		for (let xi = 0; xi + 1 < xs.length; xi++) {
			const [a, b, c, d] = [points[yi][xi], points[yi][xi + 1], points[yi + 1][xi], points[yi + 1][xi + 1]];
			if (!a || !b || !c || !d) continue;
			paintTriangle(dest.data, width, height, source, image.width, image.rows, pixel(a), pixel(b), pixel(c));
			paintTriangle(dest.data, width, height, source, image.width, image.rows, pixel(d), pixel(c), pixel(b));
		}
	}
	context.putImageData(dest, 0, 0);
	return {
		canvas,
		bounds: [
			[inverseY(minY), minX * DEG],
			[inverseY(maxY), maxX * DEG],
		],
	};
}

export type Vec3 = { x: number; y: number; z: number };
export type Point = { x: number; y: number; sx: number; sy: number };
export interface ProjectedImage {
	canvas: HTMLCanvasElement;
	bounds: [[number, number], [number, number]];
}
export interface ScanGrid {
	xs: number[];
	ys: number[];
	points: Array<Array<Point | null>>;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

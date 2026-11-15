/** Positive soft bits represent zero, as expected by TetraEar's lower MAC. */
export interface TetraEarSymbols {
	type: 'tetraear_symbols';
	freq: number;
	session: number;
	bits?: ArrayBuffer;
	reset?: boolean;
	error?: string;
}

export type TetraEarCallback = (index: number, message: TetraEarSymbols) => void;

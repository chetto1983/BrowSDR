/**
 * The text of a continuous mode (CW, RTTY, PSK) cut into log lines: a line ends at a line feed, wraps at a word before
 * it grows past `maxChars`, and ends after `pauseSec` of signal time without a character. The line being received is
 * readable for the status line.
 */
export class TextLines {
	/** The line being received. */
	line = '';
	/** Signal time of its last character, s. */
	private last = 0;

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly pauseSec: number,
		private readonly maxChars = 80,
	) {}

	/** A character (or a token such as "<AR>") at `now` signal seconds; '\n' and '\r' end the line. */
	put(text: string, now: number): void {
		this.last = now;
		if (text === '\n' || text === '\r') {
			this.flush();
			return;
		}
		if (text === ' ' && (!this.line || this.line.endsWith(' '))) return;
		this.line += text;
		if (this.line.length >= this.maxChars) this.wrap();
	}

	/**
	 * Ends the line once the pause has lasted long enough: since the last character, or since `active` (a decoder that
	 * holds characters back, as CW's, says when the signal was last on the air).
	 */
	tick(now: number, active = this.last): void {
		if (this.line && now - active >= this.pauseSec) this.flush();
	}

	flush(): void {
		const line = this.line.trim();
		this.line = '';
		if (line) this.onLine(line);
	}

	/** The last `n` characters of the line being received. */
	tail(n: number): string {
		return this.line.length > n ? `…${this.line.slice(this.line.length - n + 1)}` : this.line;
	}

	private wrap(): void {
		const cut = this.line.lastIndexOf(' ');
		if (cut <= 0) {
			this.flush();
			return;
		}
		const head = this.line.slice(0, cut).trim();
		this.line = this.line.slice(cut + 1);
		if (head) this.onLine(head);
	}
}

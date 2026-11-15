/** One optional TetraEar voice timeslot, with a bounded playback queue. */
export class TetraEarAudio {
	private context?: AudioContext;
	private gain?: GainNode;
	private next = 0;
	async open(): Promise<void> {
		this.context = new AudioContext();
		this.gain = this.context.createGain();
		this.gain.connect(this.context.destination);
		await this.context.resume();
	}
	play(data: ArrayBuffer, volume: number): void {
		const context = this.context;
		if (!context || !this.gain || context.state !== 'running') return;
		if (this.next - context.currentTime > 0.5) return;
		const samples = new Float32Array(data);
		const buffer = context.createBuffer(1, samples.length, 8000);
		buffer.copyToChannel(samples, 0);
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(this.gain);
		this.gain.gain.value = Math.max(0, Math.min(1, volume / 100));
		this.next = Math.max(this.next, context.currentTime + 0.02);
		source.start(this.next);
		this.next += buffer.duration;
	}
	close(): void {
		void this.context?.close().catch(() => undefined);
		this.context = undefined;
		this.gain = undefined;
		this.next = 0;
	}
}

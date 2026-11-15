import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { proxy } from 'comlink';
import type { AppInstance } from '@/app/core/receiver.types';
import type { TetraEarSymbols } from '@/worker/decoders/tetraear/types';
import type { TetraEarFrame } from './types';
import { errorMessage } from '@/platform/errors';
import { TetraEarBridge } from './bridge';
import { TetraEarAudio } from './audio';

let nextSession = 0;

export function useTetraEar(receiver: AppInstance) {
	const address = ref(`${location.protocol === 'https:' ? 'wss' : 'ws'}://127.0.0.1:8766`);
	const status = ref('Start the local bridge, then connect a receiving VFO.');
	const connecting = ref(false),
		audioEnabled = ref(false),
		slot = ref(1);
	const frames = shallowRef<TetraEarFrame[]>([]);
	const counters = ref({ bursts: 0, valid: 0, rejected: 0 });
	const vfoIndex = computed({
		get: () => (receiver.tetraear.vfo ? receiver.vfos.findIndex((vfo) => vfo === receiver.tetraear.vfo) : receiver.activeVfoIndex),
		set: (value: number) => {
			receiver.activeVfoIndex = value;
		},
	});
	const selectedVfo = computed(() => receiver.vfos[vfoIndex.value]);
	let bridge: TetraEarBridge | undefined;
	const audio = new TetraEarAudio();
	let attempt = 0;

	function stop(message = 'TetraEar stopped.'): void {
		attempt++;
		bridge?.close();
		bridge = undefined;
		audio.close();
		connecting.value = false;
		receiver.tetraear.session = 0;
		receiver.tetraear.vfo = null;
		receiver.updateAllBackendVfoParams();
		status.value = message;
	}

	function clear(): void {
		frames.value = [];
		counters.value = { bursts: 0, valid: 0, rejected: 0 };
	}

	async function start(): Promise<void> {
		const vfo = selectedVfo.value;
		if (!vfo || !receiver.running || receiver.remoteMode === 'client' || connecting.value || receiver.tetraear.session) return;
		const current = ++attempt,
			session = ++nextSession,
			frequency = vfo.freq;
		connecting.value = true;
		receiver.tetraear.vfo = vfo;
		clear();
		status.value = 'Connecting to TetraEar…';
		try {
			if (audioEnabled.value) await audio.open();
			if (current !== attempt) return;
			bridge = new TetraEarBridge({
				batch: (batch) => {
					counters.value = { bursts: batch.bursts, valid: batch.valid, rejected: batch.rejected };
					if (batch.frames.length) frames.value = [...batch.frames.reverse(), ...frames.value].slice(0, 500);
				},
				audio: (data) => audio.play(data, receiver.soloAudioVfo && receiver.soloAudioVfo !== vfo ? 0 : vfo.volume),
				error: (message) => {
					if (current === attempt) stop(message);
				},
			});
			const message = await bridge.connect(address.value, { frequency, audio: audioEnabled.value, slot: slot.value });
			if (current !== attempt) return;
			await receiver.backend.setTetraEarCallback(
				proxy((index: number, data: TetraEarSymbols) => {
					if (
						current !== attempt ||
						!receiver.running ||
						receiver.vfos[index] !== vfo ||
						data.freq !== frequency ||
						data.session !== session
					)
						return;
					if (data.error) {
						stop(data.error);
						return;
					}
					if (data.reset) bridge?.reset();
					if (data.bits) bridge?.send(data.bits);
				}),
			);
			if (current !== attempt || !receiver.running || vfo.freq !== frequency || !receiver.vfos.includes(vfo)) return;
			receiver.tetraear.session = session;
			receiver.updateAllBackendVfoParams();
			connecting.value = false;
			status.value = message;
		} catch (error) {
			if (current === attempt) stop(errorMessage(error));
		}
	}

	watchSource(receiver, () => connecting.value || !!receiver.tetraear.session, stop);
	onBeforeUnmount(() => stop());
	return { address, status, connecting, audioEnabled, slot, frames, counters, selectedVfo, vfoIndex, start, stop, clear };
}

function watchSource(receiver: AppInstance, active: () => boolean, stop: (message: string) => void): void {
	watch(
		() => [
			receiver.running,
			receiver.radio.centerFreq,
			receiver.radio.sampleRate,
			receiver.remoteMode,
			receiver.tetraear.vfo?.freq,
			receiver.tetraear.vfo ? receiver.vfos.findIndex((vfo) => vfo === receiver.tetraear.vfo) : -1,
		],
		(_value, previous) => {
			// Ignore initial VFO selection; later source changes invalidate the session.
			if (active() && previous[4] !== undefined) stop('Reception or tuning changed. Connect again to decode the current channel.');
		},
		{ flush: 'sync' },
	);
}

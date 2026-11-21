import { computed, defineComponent, inject, nextTick, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { DIGIMODES, digimodeInfo } from '@/worker/decoders/digimode/catalog';
import { isLoraSat } from '@/worker/decoders/digimode/lora-sat/catalog';
import { loraConfigSummary } from '@/worker/decoders/digimode/lora-sat/tinygs';
import type { DigimodeInfo } from '@/worker/decoders/digimode/types';
import * as components from '@/ui';
import { digimodePicture } from './controller';
import type { DigimodeLogEntry } from './types';
import template from './panel.html?raw';

const families = [...new Set(DIGIMODES.map((mode) => mode.family))].map((family) => ({
	family,
	modes: DIGIMODES.filter((mode) => mode.family === family),
}));

function download(name: string, blob: Blob): void {
	const link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export default defineComponent({
	name: 'DigimodePanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('DigimodePanel requires a receiver');
		const canvas = ref<HTMLCanvasElement | null>(null);
		const query = ref('');
		const open = ref<DigimodeLogEntry | null>(null);
		const selectedVfo = computed(() => receiver.vfos[receiver.activeVfoIndex]);
		const selectedMode = computed<DigimodeInfo | undefined>(() => digimodeInfo(selectedVfo.value?.digimode));
		const preset = ref(0);
		watch(
			selectedMode,
			(mode) => {
				preset.value = mode?.presets[0]?.freqMHz ?? 0;
			},
			{ immediate: true },
		);
		const tinygsJson = ref('');
		const tinygsMessage = ref('');
		watch(selectedVfo, () => (tinygsMessage.value = ''));
		const loraSatState = computed(() => {
			const config = selectedVfo.value?.loraSatConfig;
			return config ? `Decoding with ${loraConfigSummary(config)}.` : 'Blind search: every SF, sync word and IQ of this bandwidth.';
		});
		const imageVfo = computed(() => {
			const index = receiver.vfos.findIndex((vfo) => digimodeInfo(vfo.digimode)?.image);
			return index < 0 ? receiver.activeVfoIndex : index;
		});
		const picture = computed(() => (receiver.digimodes.imageVersion, digimodePicture(receiver, imageVfo.value)));
		const imageRows = computed(() => (receiver.digimodes.imageVersion, picture.value.rows));
		const log = computed(() => receiver.digimodes.log);
		const filtered = computed(() => {
			const text = query.value.trim().toLowerCase();
			return text ? log.value.filter((entry) => entry.text.toLowerCase().includes(text)) : log.value;
		});

		const draw = () => {
			const element = canvas.value;
			const image = picture.value;
			if (!element || !image.rows) return;
			element.width = image.width;
			element.height = image.rows;
			element.getContext('2d')?.putImageData(new ImageData(image.rgba(), image.width, image.rows), 0, 0);
		};
		watch(
			() => [receiver.digimodes.imageVersion, imageVfo.value, receiver.digimodes.panelOpen],
			() => void nextTick(draw),
		);

		return {
			receiver,
			canvas,
			query,
			open,
			preset,
			families,
			loraSat: computed(() => isLoraSat(selectedMode.value?.id)),
			tinygsJson,
			tinygsMessage,
			loraSatState,
			useTinygs: () => (tinygsMessage.value = receiver.applyLoraSatConfig(receiver.activeVfoIndex, tinygsJson.value)),
			clearTinygs: () => {
				receiver.clearLoraSatConfig(receiver.activeVfoIndex);
				tinygsMessage.value = '';
			},
			selectedVfo,
			selectedMode,
			picture,
			imageRows,
			log,
			filtered,
			active: computed(() => receiver.vfos.some((vfo) => !!vfo.digimode)),
			clock: (time: number) => new Date(time).toLocaleTimeString(),
			modeLabel: (id: string) => digimodeInfo(id)?.label ?? id,
			exportLog: () =>
				download(`digital-modes-${stamp()}.json`, new Blob([JSON.stringify(log.value, null, 2)], { type: 'application/json' })),
			savePicture: () =>
				canvas.value?.toBlob((blob) => {
					if (blob) download(`${picture.value.title.replace(/\W+/g, '-').toLowerCase() || 'picture'}-${stamp()}.png`, blob);
				}, 'image/png'),
		};
	},
});

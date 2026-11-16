import { computed, defineComponent, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { isMeteorFrequency } from '@/worker/decoders/meteor';
import { passRows } from '@/satellites/format';
import type { PassRow } from '@/satellites/types';
import * as components from '@/ui';
import template from './panel.html?raw';
import { meteorImage } from './controller';

const VIEWS = [
	{ value: 'rgb', label: 'Colour' },
	{ value: 0, label: 'Channel 1' },
	{ value: 1, label: 'Channel 2' },
	{ value: 2, label: 'Channel 3' },
] as const;

function saveCanvas(canvas: HTMLCanvasElement, norad: number): void {
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
	canvas.toBlob((blob) => {
		if (!blob) return;
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = `meteor-${norad || 'unknown'}-${stamp}.png`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
	}, 'image/png');
}

export default defineComponent({
	name: 'MeteorPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('MeteorPanel requires a receiver');
		const canvas = ref<HTMLCanvasElement | null>(null);
		const now = ref(new Date());
		const latitude = ref(receiver.meteor.site?.lat ?? '');
		const longitude = ref(receiver.meteor.site?.lon ?? '');
		const imageVfo = computed(() => {
			const index = receiver.vfos.findIndex((vfo) => vfo.meteor);
			return index < 0 ? receiver.activeVfoIndex : index;
		});
		const imageRows = computed(() => (receiver.meteor.imageVersion, meteorImage(receiver, imageVfo.value).rows));
		const rows = computed<PassRow[]>(() => passRows(receiver.meteor.passes, now.value));

		const draw = () => {
			const element = canvas.value;
			const image = meteorImage(receiver, imageVfo.value);
			if (!element || !image.rows) return;
			element.width = image.width;
			element.height = image.rows;
			const context = element.getContext('2d');
			context?.putImageData(new ImageData(image.rgba(receiver.meteor.view), image.width, image.rows), 0, 0);
		};
		watch(
			() => [receiver.meteor.imageVersion, receiver.meteor.view, imageVfo.value, receiver.meteor.panelOpen],
			() => void nextTick(draw),
		);
		watch(
			() => receiver.meteor.panelOpen,
			(open) => {
				if (open) void receiver.meteorRefreshPasses();
			},
			{ immediate: true },
		);
		const clock = setInterval(() => (now.value = new Date()), 30_000);
		onBeforeUnmount(() => clearInterval(clock));

		return {
			receiver,
			canvas,
			rows,
			views: VIEWS,
			latitude,
			longitude,
			imageRows,
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			active: computed(() => receiver.vfos.some((vfo) => vfo.meteor)),
			isMeteorFrequency,
			setLocation: () => receiver.meteorSetLocation(Number(latitude.value), Number(longitude.value)),
			save: () => canvas.value && saveCanvas(canvas.value, receiver.meteor.norad),
		};
	},
});

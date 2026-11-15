import { computed, defineComponent, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import { isTetraFrequency } from '@/worker/decoders/tetra';
import * as components from '@/ui';
import template from './panel.html?raw';
import { cellLoadText, countryName, encryptionText, serviceList } from './interpret';

export default defineComponent({
	name: 'TetraPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('TetraPanel requires a receiver');
		const cells = computed(() =>
			receiver.tetra.sources
				.flatMap((source, index) => {
					const vfo = receiver.vfos[index];
					if (!vfo?.tetra || !source || source.freq !== vfo.freq) return [];
					return source.cells.map((cell) => ({ ...cell, key: `${index}:${cell.id}`, vfoIndex: index, frequency: vfo.freq }));
				})
				.sort((a, b) => b.lastSeen - a.lastSeen),
		);
		return {
			receiver,
			cells,
			selectedVfo: computed(() => receiver.vfos[receiver.activeVfoIndex]),
			active: computed(() => receiver.vfos.some((vfo) => vfo.tetra)),
			isTetraFrequency,
			countryName,
			encryptionText,
			serviceList,
			cellLoadText,
			time: (timestamp: number) => new Date(timestamp).toLocaleTimeString(),
		};
	},
});

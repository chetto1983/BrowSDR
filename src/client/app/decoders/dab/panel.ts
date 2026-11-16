import { defineComponent, type PropType } from 'vue';
import type { Vfo } from '@/app/core/types';
import type { DabStatus } from '@/worker/decoders/dabplus/types';
import { UiFormRow, UiSelect } from '@/ui';
import { DAB_CHANNELS } from './channels';
import template from './panel.html?raw';

export default defineComponent({
	name: 'DabPanel',
	components: { UiFormRow, UiSelect },
	template,
	props: {
		vfo: { type: Object as PropType<Vfo>, required: true },
		status: { type: Object as PropType<DabStatus | null>, default: null },
	},
	emits: ['service', 'channel'],
	data: () => ({ channels: DAB_CHANNELS }),
	computed: {
		channel(): number {
			return DAB_CHANNELS.find(([, mhz]) => Math.abs(mhz - this.vfo.freq) < 0.001)?.[1] ?? 0;
		},
		audioServices(): DabStatus['services'] {
			return (this.status?.services ?? []).filter((service) => service.components.some((component) => component.dabPlus));
		},
		otherServices(): number {
			return (this.status?.services.length ?? 0) - this.audioServices.length;
		},
	},
	methods: {
		hex: (sid: number) => `0x${sid.toString(16).toUpperCase()}`,
	},
});

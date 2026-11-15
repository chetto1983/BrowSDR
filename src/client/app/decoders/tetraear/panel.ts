import { defineComponent, inject } from 'vue';
import type { AppInstance } from '@/app/core/receiver.types';
import * as components from '@/ui';
import { useTetraEar } from './session';
import template from './panel.html?raw';

export default defineComponent({
	name: 'TetraEarPanel',
	template,
	components,
	setup() {
		const receiver = inject<AppInstance>('receiver');
		if (!receiver) throw new Error('TetraEarPanel requires a receiver');
		return { receiver, ...useTetraEar(receiver) };
	},
});

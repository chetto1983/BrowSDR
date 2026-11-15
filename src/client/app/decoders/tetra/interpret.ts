import type { TetraCell, TetraServices } from '@/worker/decoders/tetra/types';

/** Mobile country codes of the European countries most likely to be in range. */
const COUNTRIES: Record<number, string> = {
	202: 'Greece',
	204: 'Netherlands',
	206: 'Belgium',
	208: 'France',
	212: 'Monaco',
	213: 'Andorra',
	214: 'Spain',
	216: 'Hungary',
	219: 'Croatia',
	222: 'Italy',
	226: 'Romania',
	228: 'Switzerland',
	230: 'Czechia',
	231: 'Slovakia',
	232: 'Austria',
	234: 'United Kingdom',
	238: 'Denmark',
	240: 'Sweden',
	242: 'Norway',
	244: 'Finland',
	260: 'Poland',
	262: 'Germany',
	268: 'Portugal',
	270: 'Luxembourg',
	272: 'Ireland',
	278: 'Malta',
	292: 'San Marino',
	293: 'Slovenia',
	295: 'Liechtenstein',
};

export const countryName = (mcc: number): string => COUNTRIES[mcc] ?? 'Unknown country';

const SERVICE_LABELS: Array<[keyof TetraServices, string]> = [
	['voice', 'Voice'],
	['circuitData', 'Circuit data'],
	['packetData', 'Packet data'],
	['advancedLink', 'Advanced link'],
	['systemWideServices', 'System-wide'],
	['registrationRequired', 'Registration'],
	['migration', 'Migration'],
	['priorityCell', 'Priority cell'],
];

export function serviceList(services: TetraServices): string {
	return SERVICE_LABELS.filter(([key]) => services[key])
		.map(([, label]) => label)
		.join(', ');
}

/**
 * Air interface encryption as the cell advertises it; it says nothing about end-to-end encryption.
 * The hyperframe/cipher-key flag is not used here: cells alternate SYSINFOs carrying either field.
 */
export function encryptionText(cell: TetraCell): string {
	if (!cell.sysinfo) return '—';
	return cell.sysinfo.services.airEncryption ? 'Offered' : 'Not offered';
}

const LEVELS = ['Unknown', 'Low load', 'Medium load', 'High load'];
export const cellLoadText = (level: number): string => LEVELS[level] ?? 'Unknown';

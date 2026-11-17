import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { SatellitePassWindow, SatelliteRow, SatelliteTableFilters, SatelliteTableSort, SatelliteVisibility } from './types';

function matchesPassWindow(row: SatelliteRow, filters: SatelliteTableFilters): boolean {
	if (filters.window === 'all') return true;
	const pass = row.next?.pass;
	if (filters.window === 'none') return !pass;
	if (!pass) return false;
	if (filters.window === 'today') return pass.aos.getTime() < filters.tomorrow && pass.los.getTime() >= filters.time;
	return pass.aos.getTime() < filters.time + 86_400_000 && pass.los.getTime() >= filters.time;
}

function matchesRow(row: SatelliteRow, filters: SatelliteTableFilters): boolean {
	if (filters.orbcommOnly && !filters.orbcommIds.has(row.satellite.norad)) return false;
	if (filters.query && !`${row.satellite.name} ${row.satellite.norad}`.toLocaleLowerCase().includes(filters.query)) return false;
	const elevation = row.state?.look?.elevation;
	if (filters.visibility === 'above' && (elevation === undefined || elevation <= 0)) return false;
	if (filters.visibility === 'below' && (elevation === undefined || elevation > 0)) return false;
	return matchesPassWindow(row, filters);
}

function compareOptional(first: number | undefined, second: number | undefined, direction: number): number {
	if (first === undefined) return second === undefined ? 0 : 1;
	if (second === undefined) return -1;
	return direction * (first - second);
}

function compareRows(first: SatelliteRow, second: SatelliteRow, sort: SatelliteTableSort, direction: number): number {
	if (sort === 'name') return direction * first.satellite.name.localeCompare(second.satellite.name);
	if (sort === 'elevation') return compareOptional(first.state?.look?.elevation, second.state?.look?.elevation, direction);
	return compareOptional(first.next?.pass.aos.getTime(), second.next?.pass.aos.getTime(), direction);
}

/** Spreadsheet-style filters and column sorting for the satellite table. */
export function useSatelliteTable(
	rows: ComputedRef<SatelliteRow[]>,
	now: Ref<Date>,
	passFilter: Ref<number>,
	orbcommIds: ComputedRef<Set<number>>,
) {
	const satelliteQuery = ref('');
	const visibilityFilter = ref<SatelliteVisibility>('all');
	const passWindowFilter = ref<SatellitePassWindow>('all');
	const tableSort = ref<SatelliteTableSort>('catalog');
	const sortDescending = ref(false);
	const displayRows = computed(() => {
		const tomorrow = new Date(now.value);
		tomorrow.setHours(24, 0, 0, 0);
		const filters: SatelliteTableFilters = {
			query: satelliteQuery.value.trim().toLocaleLowerCase(),
			visibility: visibilityFilter.value,
			window: passWindowFilter.value,
			time: now.value.getTime(),
			tomorrow: tomorrow.getTime(),
			orbcommOnly: passFilter.value === -1,
			orbcommIds: orbcommIds.value,
		};
		const filtered = rows.value.filter((row) => matchesRow(row, filters));
		const sort = tableSort.value === 'catalog' && filters.orbcommOnly ? 'next' : tableSort.value;
		return sort === 'catalog' ? filtered : filtered.sort((a, b) => compareRows(a, b, sort, sortDescending.value ? -1 : 1));
	});
	const sortTable = (column: Exclude<SatelliteTableSort, 'catalog'>) => {
		if (tableSort.value === column) sortDescending.value = !sortDescending.value;
		else {
			tableSort.value = column;
			sortDescending.value = column === 'elevation';
		}
	};
	const clearTableFilters = () => {
		satelliteQuery.value = '';
		visibilityFilter.value = 'all';
		passWindowFilter.value = 'all';
		tableSort.value = 'catalog';
		sortDescending.value = false;
	};
	return { satelliteQuery, visibilityFilter, passWindowFilter, tableSort, sortDescending, displayRows, sortTable, clearTableFilters };
}

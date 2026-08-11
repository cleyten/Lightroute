// The Plan screen's compact row list: each row summarises one setting and
// opens #plan-setting-sheet on the matching pane. The controls themselves are
// not owned here — they are the original elements from the old inline form,
// still bound by main.ts and settings.ts. This module only reads state to
// build the one-line summaries and swaps which pane is showing.
import type { BikeType, HillPreference } from './settings';

export type PlanSettingPane = 'start' | 'distance' | 'bike' | 'hills';

const PANE_TITLES: Record<PlanSettingPane, string> = {
  start: 'Start',
  distance: 'Round trip distance',
  bike: 'Bike',
  hills: 'Hills & roads',
};

const BIKE_LABELS: Record<BikeType, string> = {
  race: 'Race',
  gravel: 'Gravel',
  mtb: 'MTB',
};

const HILL_LABELS: Record<HillPreference, string> = {
  avoid: 'Flat',
  mix: 'Mixed',
  prefer: 'Hilly',
};

const TRAFFIC_LABELS = ['fastest', 'quiet', 'very quiet'];

export interface PlanRowState {
  /** Reverse-geocoded place name for waypoint 1, if resolved. */
  startPlace: string | null;
  hasStart: boolean;
  distanceMinKm: number;
  distanceMaxKm: number;
  bike: BikeType;
  hills: HillPreference;
  traffic: number;
}

/** Writes the four row summaries. Called whenever any of the inputs change. */
export function renderPlanRows(state: PlanRowState): void {
  const set = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set(
    'row-value-start',
    state.startPlace ?? (state.hasStart ? 'On the map' : 'Tap the map'),
  );
  set('row-value-distance', `${state.distanceMinKm} – ${state.distanceMaxKm} km`);
  set('row-value-bike', BIKE_LABELS[state.bike]);
  // Road preference only applies to the road profile (see settings.ts), so it
  // is only worth naming in the summary when it is actually in effect.
  const trafficNote =
    state.bike === 'race' ? ` · ${TRAFFIC_LABELS[state.traffic] ?? TRAFFIC_LABELS[0]}` : '';
  set('row-value-hills', `${HILL_LABELS[state.hills]}${trafficNote}`);
}

/** Wires each row to open the sheet on its own pane. */
export function initPlanRows(onOpen: (pane: PlanSettingPane) => void): void {
  document.querySelectorAll<HTMLButtonElement>('[data-plan-setting]').forEach((row) => {
    row.addEventListener('click', () => {
      onOpen(row.dataset.planSetting as PlanSettingPane);
    });
  });
}

/** Shows one pane inside the settings sheet and titles it. */
export function showPlanSettingPane(pane: PlanSettingPane): void {
  document.querySelectorAll<HTMLElement>('.plan-setting-pane').forEach((el) => {
    el.hidden = el.dataset.pane !== pane;
  });
  const title = document.getElementById('plan-setting-title');
  if (title) title.textContent = PANE_TITLES[pane];
}

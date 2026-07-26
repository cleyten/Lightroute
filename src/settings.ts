// The rider's persisted preferences: bike type, how much traffic to tolerate,
// and whether round trips should seek out or avoid hills. Small enough for
// localStorage, and read back defensively because it is user-writable storage.

import { bikeButtons, hillsButtons, trafficLabel, trafficSelect } from './dom';

export type BikeType = 'race' | 'gravel' | 'mtb';
export type HillPreference = 'avoid' | 'mix' | 'prefer';

export interface Settings {
  bike: BikeType;
  /** 0 = fastest, 1 = low traffic, 2 = very low traffic (race only). */
  traffic: number;
  /** Round-trip elevation preference. */
  hills: HillPreference;
}

// Deliberately still 'lightroute-*': renaming the key would orphan every
// existing user's saved preferences for the sake of branding.
const SETTINGS_KEY = 'lightroute-settings';

const TRAFFIC_PROFILES = ['fastbike', 'fastbike-lowtraffic', 'fastbike-verylowtraffic'];

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (['race', 'gravel', 'mtb'].includes(parsed.bike)) {
        return {
          bike: parsed.bike,
          traffic: [0, 1, 2].includes(parsed.traffic) ? parsed.traffic : 0,
          hills: ['avoid', 'mix', 'prefer'].includes(parsed.hills) ? parsed.hills : 'mix',
        };
      }
    }
  } catch {
    // Corrupt settings fall through to the defaults.
  }
  return { bike: 'race', traffic: 0, hills: 'mix' };
}

/** Mutated in place by the control handlers, then persisted. */
export const settings: Settings = loadSettings();

export function persistSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Blocked or full storage must not abort the caller: persistSettings runs
    // partway through the bike/traffic/hills handlers and through every route
    // load, and throwing here would leave the UI half-updated.
  }
}

/** The BRouter profile the current settings imply. */
export function currentProfile(): string {
  if (settings.bike === 'gravel') return 'gravel';
  if (settings.bike === 'mtb') return 'mtb';
  return TRAFFIC_PROFILES[settings.traffic];
}

/** Reflects the current settings back into the controls. */
export function syncProfileUi(): void {
  bikeButtons.forEach((button) => {
    const active = button.dataset.bike === settings.bike;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  hillsButtons.forEach((button) => {
    const active = button.dataset.hills === settings.hills;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  // The traffic selector only applies to the road profile.
  trafficLabel.hidden = settings.bike !== 'race';
  trafficSelect.value = String(settings.traffic);
}

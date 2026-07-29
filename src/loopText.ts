// Human-readable wording for rejected round-trip candidates.
//
// Kept apart from ors.ts on purpose: this is the only thing the UI needed from
// that module besides types, and importing it from main.ts pulled the whole
// generation pipeline (and its geometry code) back into the main bundle, next
// to the copy already living in the worker chunk.

import type { LoopOption } from './ors';

export function rejectionText(option: LoopOption): string {
  switch (option.rejection) {
    case 'overlap':
      return `${Math.round(option.overlap * 100)}% of it doubles back on itself`;
    case 'backtrack':
      return `it rides back beside itself for about ${formatMeters(option.backtrackMeters)}`;
    case 'shape':
      return 'it is awkwardly shaped';
    case 'surface':
      return `only ${Math.round((option.unpaved ?? 0) * 100)}% of it is unpaved`;
    case 'distance':
      return `its distance is ${(option.route.distanceMeters / 1000).toFixed(1)} km`;
    default:
      return '';
  }
}

function formatMeters(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 50) * 50} m`;
}

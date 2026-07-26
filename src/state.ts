// All mutable application state, in one object.
//
// A single shared object rather than per-module variables: nearly every
// interaction reads the current route or waypoints, and threading them through
// call signatures would be noisier than it is worth at this size. Modules
// mutate it directly and then call the relevant render function, which is the
// convention the rest of the app follows.

import type maplibregl from 'maplibre-gl';
import type { LngLat, RouteResult } from './routing';
import type { LoopOption } from './ors';
import type { Climb } from './climbs';
import type { Cafe } from './cafes';
import type { WaterPoint } from './water';
import type { AvoidZone } from './avoidZones';

export const state = {
  waypoints: [] as LngLat[],
  markers: [] as maplibregl.Marker[],
  route: null as RouteResult | null,
  // Incremented per routing request so stale responses can be ignored.
  requestId: 0,
  // Round-trip suggestions currently on offer, and the selected one.
  loopOptions: [] as LoopOption[],
  selectedLoop: -1,
  climbs: [] as Climb[],
  selectedClimb: -1,
  cafes: [] as Cafe[],
  water: [] as WaterPoint[],
  // Route returns to waypoint 1 (a closed loop): set by generating a round
  // trip or by clicking near point 1.
  closed: false,
  // Raw text of a freshly imported, still-unedited route's original file (and
  // its format), so publishing can keep the original file. Cleared by any
  // reroute (see recalculateRoute).
  importedFileText: null as string | null,
  importedFileFormat: null as 'gpx' | 'tcx' | null,
  // Circular "avoid this area" zones for manual routes (BRouter nogos).
  // Round trips (ORS) don't support these yet; see syncAvoidZoneUi().
  avoidZones: [] as AvoidZone[],
  // Radius used for the NEXT zone placed, in meters.
  avoidZoneRadius: 60,
  // 'avoid' is a one-shot mode: the next map click places a zone, then this
  // reverts to 'normal' automatically.
  mode: 'normal' as 'normal' | 'avoid',
  // Last GPS fix, shared between the planner's locate button and the community
  // "Near me" sort / distance-away labels. Null until location is granted.
  lastKnownLocation: null as [number, number] | null,
};

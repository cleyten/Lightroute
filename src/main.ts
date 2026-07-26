import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchRoute, RouteCancelledError, type LngLat, type RouteResult } from './routing';
import { sanitizeWaypoints } from './waypoints';
import { downloadGpx } from './gpx';
import { downloadTcx } from './tcx';
import { parseTcx } from './tcximport';
import { haversineMeters, cumulativeDistances, elevationGain } from './geo';
import { renderGradeLegend } from './gradelegend';
import { surfaceBreakdown, renderSurfaceBar } from './surface';
import { saveRoute, listRoutes, deleteRoute, type SavedRoute } from './storage';
import { generateRoundTrips, rejectionText, type LoopOption } from './ors';
import { detectClimbs, type Climb } from './climbs';
import { compassLabel, type WindInfo } from './wind';
import { searchPlaces, reverseCity, type GeocodeResult } from './geocode';
import { buildRoutePreviewSvg } from './preview';
import { fetchCafes, type Cafe } from './cafes';
import { fetchWater, type WaterPoint } from './water';
import { buildShareUrl, parseShareUrl } from './share';
import { parseGpx, isClosedTrack } from './gpximport';
import { buildAvoidZonesGeoJson, type AvoidZone } from './avoidZones';
import { isSupabaseConfigured } from './supabaseConfig';
// `./chart` (chart.js/auto) and `./auth`/`./community` (@supabase/supabase-js)
// are code-split: only dynamically import()-ed below (loadChartModule(),
// loadCommunityBackend()), never statically, so neither heavy library is in
// the initial bundle. Type-only imports below are erased at build time and
// have no effect on this — they're the one safe exception.
import type { CommunityRoute, CommunitySort } from './community';
import type { User } from '@supabase/supabase-js';
import { registerSW } from 'virtual:pwa-register';

// The default injected registration only activates a new service worker in
// the background; an already-open tab (or a phone's installed PWA, reopened
// from its home-screen icon rather than truly relaunched) keeps running the
// OLD cached JS/CSS until it happens to be fully reloaded. Reload once here
// as soon as an update is detected, so a fresh deploy actually shows up.
registerSW({ immediate: true, onNeedRefresh: () => window.location.reload() });

type BikeType = 'race' | 'gravel' | 'mtb';

type HillPreference = 'avoid' | 'mix' | 'prefer';

interface Settings {
  bike: BikeType;
  traffic: number; // 0 = fastest, 1 = low traffic, 2 = very low traffic (race only)
  hills: HillPreference; // round-trip elevation preference
}

const SETTINGS_KEY = 'lightroute-settings';
const TRAFFIC_PROFILES = ['fastbike', 'fastbike-lowtraffic', 'fastbike-verylowtraffic'];

const settings: Settings = loadSettings();

// All application state lives in this one object.
const state = {
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
};

const statDistance = document.querySelector<HTMLElement>('#stat-distance')!;
const statAscend = document.querySelector<HTMLElement>('#stat-ascend')!;
const statsSection = document.querySelector<HTMLElement>('#stats')!;
const routeEmpty = document.querySelector<HTMLElement>('#route-empty')!;
const routePills = document.querySelector<HTMLElement>('#route-pills')!;
const gradeLegendEl = document.querySelector<HTMLElement>('#grade-legend')!;
const btnShare = document.querySelector<HTMLButtonElement>('#btn-share')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const statusBarEl = document.querySelector<HTMLElement>('#statusbar')!;
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnReverse = document.querySelector<HTMLButtonElement>('#btn-reverse')!;
const btnExport = document.querySelector<HTMLButtonElement>('#btn-export')!;
const btnExportTcx = document.querySelector<HTMLButtonElement>('#btn-export-tcx')!;
const btnSave = document.querySelector<HTMLButtonElement>('#btn-save')!;
const routeNameInput = document.querySelector<HTMLInputElement>('#route-name')!;
const savedList = document.querySelector<HTMLUListElement>('#saved-list')!;
const bikeButtons = [...document.querySelectorAll<HTMLButtonElement>('#bike-type button')];
const hillsButtons = [...document.querySelectorAll<HTMLButtonElement>('#hills-type button')];
const trafficLabel = document.querySelector<HTMLElement>('#traffic-label')!;
const trafficSelect = document.querySelector<HTMLSelectElement>('#traffic-select')!;
const chartWrap = document.querySelector<HTMLElement>('#chart-wrap')!;
const roundtripMin = document.querySelector<HTMLInputElement>('#roundtrip-min')!;
const roundtripMax = document.querySelector<HTMLInputElement>('#roundtrip-max')!;
const rangeValue = document.querySelector<HTMLElement>('#range-value')!;
const rangeTrack = document.querySelector<HTMLElement>('#range-track')!;
const btnRoundtrip = document.querySelector<HTMLButtonElement>('#btn-roundtrip')!;
const btnAvoidZone = document.querySelector<HTMLButtonElement>('#btn-avoid-zone')!;
const avoidZoneRadiusButtons = [...document.querySelectorAll<HTMLButtonElement>('#avoid-zone-radius button')];
const btnClearAvoidZones = document.querySelector<HTMLButtonElement>('#btn-clear-avoid-zones')!;
const chartCanvas = document.querySelector<HTMLCanvasElement>('#elevation-chart')!;
const surfaceEl = document.querySelector<HTMLElement>('#surface')!;
const loopOptionsEl = document.querySelector<HTMLElement>('#loop-options')!;
const windChipEl = document.querySelector<HTMLElement>('#wind-chip')!;
const climbsEl = document.querySelector<HTMLElement>('#climbs')!;
const climbsList = document.querySelector<HTMLUListElement>('#climbs-list')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const searchResults = document.querySelector<HTMLUListElement>('#search-results')!;
const btnLocate = document.querySelector<HTMLButtonElement>('#btn-locate')!;
const btnImportGpx = document.querySelector<HTMLButtonElement>('#btn-import-gpx')!;
const gpxFileInput = document.querySelector<HTMLInputElement>('#gpx-file-input')!;
const cafesEl = document.querySelector<HTMLElement>('#cafes')!;
const cafeKmInput = document.querySelector<HTMLInputElement>('#cafe-km')!;
const btnCafes = document.querySelector<HTMLButtonElement>('#btn-cafes')!;
const cafesList = document.querySelector<HTMLUListElement>('#cafes-list')!;
const waterEl = document.querySelector<HTMLElement>('#water')!;
const btnWater = document.querySelector<HTMLButtonElement>('#btn-water')!;
const waterList = document.querySelector<HTMLUListElement>('#water-list')!;
const btnPublish = document.querySelector<HTMLButtonElement>('#btn-publish')!;
const mainTabs = document.querySelector<HTMLElement>('#main-tabs')!;
const mainTabButtons = [...document.querySelectorAll<HTMLButtonElement>('#main-tabs .main-tab')];
const plannerPanel = document.querySelector<HTMLElement>('#tab-planner')!;
const communityPanel = document.querySelector<HTMLElement>('#tab-community')!;
const brandSub = document.querySelector<HTMLElement>('.brand-sub')!;
const accountSignedOut = document.querySelector<HTMLElement>('#account-signed-out')!;
const accountSignedIn = document.querySelector<HTMLElement>('#account-signed-in')!;
const accountEmail = document.querySelector<HTMLInputElement>('#account-email')!;
const btnSignin = document.querySelector<HTMLButtonElement>('#btn-signin')!;
const accountName = document.querySelector<HTMLElement>('#account-name')!;
const btnSignout = document.querySelector<HTMLButtonElement>('#btn-signout')!;
const communitySortButtons = [...document.querySelectorAll<HTMLButtonElement>('#community-sort button')];
const communityBikeButtons = [...document.querySelectorAll<HTMLButtonElement>('#community-bike button')];
const communityHillsButtons = [...document.querySelectorAll<HTMLButtonElement>('#community-hills button')];
const communityDistMin = document.querySelector<HTMLInputElement>('#community-dist-min')!;
const communityDistMax = document.querySelector<HTMLInputElement>('#community-dist-max')!;
const communityDistValue = document.querySelector<HTMLElement>('#community-dist-value')!;
const communityDistTrack = document.querySelector<HTMLElement>('#community-dist-track')!;
const authorField = document.querySelector<HTMLElement>('#author-field')!;
const authorNameInput = document.querySelector<HTMLInputElement>('#author-name')!;
const communityList = document.querySelector<HTMLUListElement>('#community-list')!;

// Last GPS fix, shared between the planner's locate button and the community
// "Near me" sort / distance-away labels. Null until the user grants location.
let lastKnownLocation: [number, number] | null = null;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [5.3, 51.9], // Netherlands
  zoom: 7,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Basemap switcher. "clean" is the vector positron base; terrain and cycling
// are raster layers drawn on top of it but below the route overlays.
const RASTER_BASEMAPS: Record<
  string,
  { tiles: string[]; attribution: string; maxzoom: number }
> = {
  terrain: {
    tiles: [
      'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
      'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
    ],
    attribution:
      'Map data: © OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    maxzoom: 17,
  },
};

// The "cycling" basemap is OpenCycleMap (Thunderforest), which needs a free API
// key injected at build time from VITE_THUNDERFOREST_KEY (never hardcoded).
// Registered only when the key is present; the button is removed otherwise
// (see the load handler).
const THUNDERFOREST_KEY: string = import.meta.env.VITE_THUNDERFOREST_KEY ?? '';
if (THUNDERFOREST_KEY) {
  RASTER_BASEMAPS.cycling = {
    tiles: ['a', 'b', 'c'].map(
      (s) => `https://${s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=${THUNDERFOREST_KEY}`,
    ),
    attribution: 'Maps © Thunderforest, Data © OpenStreetMap contributors',
    maxzoom: 22,
  };
}

// Route line color, the same across every basemap.
const ROUTE_COLOR = '#2424e8';

function setBasemap(style: string): void {
  if (map.getLayer('basemap-raster')) map.removeLayer('basemap-raster');
  if (map.getSource('basemap-raster')) map.removeSource('basemap-raster');
  // "clean" is always the light positron vector base, regardless of UI theme.
  const cfg = RASTER_BASEMAPS[style];
  if (cfg) {
    map.addSource('basemap-raster', {
      type: 'raster',
      tiles: cfg.tiles,
      tileSize: 256,
      maxzoom: cfg.maxzoom,
      attribution: cfg.attribution,
    });
    // Keep the raster below the route overlays so the route stays on top.
    const beforeId = map.getLayer('route-casing') ? 'route-casing' : undefined;
    map.addLayer({ id: 'basemap-raster', type: 'raster', source: 'basemap-raster' }, beforeId);
  }
}

// Dot shown on the map while hovering the elevation chart.
const hoverDotEl = document.createElement('div');
hoverDotEl.className = 'hover-dot';
const hoverMarker = new maplibregl.Marker({ element: hoverDotEl });
let hoverMarkerVisible = false;

map.on('load', () => {
  // Empty GeoJSON source; its data is replaced whenever a route is calculated.
  map.addSource('route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  // White casing under the route so it reads on any basemap.
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 7,
      'line-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': ROUTE_COLOR,
      'line-width': 4,
      'line-opacity': 0.95,
    },
  });
  // Café markers along the current route.
  map.addSource('cafes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'cafe-dots',
    type: 'circle',
    source: 'cafes',
    paint: {
      'circle-radius': 6,
      'circle-color': '#8a5a2b',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  map.on('click', 'cafe-dots', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties as { name: string; detail: string };
    new maplibregl.Popup({ offset: 10 })
      .setLngLat(event.lngLat)
      .setHTML(
        `<strong>${escapeHtml(props.name)}</strong><br>${escapeHtml(props.detail)}`,
      )
      .addTo(map);
  });
  map.on('mouseenter', 'cafe-dots', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'cafe-dots', () => {
    map.getCanvas().style.cursor = '';
  });

  // Drinking-water refill markers along the current route.
  map.addSource('water', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'water-dots',
    type: 'circle',
    source: 'water',
    paint: {
      'circle-radius': 6,
      'circle-color': '#1f9ed6',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  map.on('click', 'water-dots', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties as { name: string; detail: string };
    new maplibregl.Popup({ offset: 10 })
      .setLngLat(event.lngLat)
      .setHTML(
        `<strong>${escapeHtml(props.name)}</strong><br>${escapeHtml(props.detail)}`,
      )
      .addTo(map);
  });
  map.on('mouseenter', 'water-dots', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'water-dots', () => {
    map.getCanvas().style.cursor = '';
  });

  // Highlight layer for a selected climb, drawn on top of the route.
  map.addSource('climb-highlight', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'climb-line',
    type: 'line',
    source: 'climb-highlight',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#e8571a',
      'line-width': 5,
      'line-opacity': 0.95,
    },
  });
  map.on('mouseenter', 'route-line', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'route-line', () => {
    map.getCanvas().style.cursor = '';
  });

  // Circular "avoid this area" zones for manual routes.
  map.addSource('avoid-zones', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'avoid-zones-fill',
    type: 'fill',
    source: 'avoid-zones',
    paint: {
      'fill-color': '#d63e3e',
      'fill-opacity': 0.2,
    },
  });
  map.addLayer({
    id: 'avoid-zones-line',
    type: 'line',
    source: 'avoid-zones',
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': '#d63e3e',
      'line-width': 2,
      'line-dasharray': [2, 2],
    },
  });
  map.on('click', 'avoid-zones-fill', (event) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const index = (feature.properties as { zoneIndex: number }).zoneIndex;
    state.avoidZones.splice(index, 1);
    updateAvoidZonesSource();
    syncAvoidZoneUi();
    void recalculateRoute();
  });
  map.on('mouseenter', 'avoid-zones-fill', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'avoid-zones-fill', () => {
    map.getCanvas().style.cursor = '';
  });

  // Wire the basemap switcher now that the overlay layers exist.
  const mapstyleEl = document.querySelector<HTMLDivElement>('#mapstyle');
  if (mapstyleEl) {
    mapstyleEl.hidden = false;
    // OpenCycleMap (the cycling layer) only works with a Thunderforest key.
    if (!THUNDERFOREST_KEY) mapstyleEl.querySelector('[data-style="cycling"]')?.remove();
    mapstyleEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        setBasemap(btn.dataset.style ?? 'clean');
        mapstyleEl.querySelectorAll('button').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        });
      });
    });
  }

  // A shared route needs the 'route' source/layers above to already exist.
  void applySharedRoute();
});

map.on('click', (event) => {
  // Clicks on a café/water marker or an existing avoid-zone are handled by
  // their own layer-click listeners above, not by the branches below.
  const poiLayers = ['cafe-dots', 'water-dots', 'avoid-zones-fill'].filter((id) => map.getLayer(id));
  if (poiLayers.length > 0 && map.queryRenderedFeatures(event.point, { layers: poiLayers }).length > 0) {
    return;
  }
  // Avoid-area mode is one-shot: this click places a zone and reverts to
  // normal mode, overriding the route-editing clicks below entirely.
  if (state.mode === 'avoid') {
    state.avoidZones.push({
      lngLat: [event.lngLat.lng, event.lngLat.lat],
      radiusM: state.avoidZoneRadius,
    });
    state.mode = 'normal';
    updateAvoidZonesSource();
    syncAvoidZoneUi();
    void recalculateRoute();
    return;
  }
  // Clicking near point 1 closes an open route into a loop.
  if (!state.closed && state.waypoints.length >= 3 && nearFirstWaypoint(event.point)) {
    void closeLoop();
    return;
  }
  // A click on the route line inserts a via-point instead of appending.
  if (state.waypoints.length >= 2 && map.getLayer('route-line')) {
    const pad = 6;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [event.point.x - pad, event.point.y - pad],
      [event.point.x + pad, event.point.y + pad],
    ];
    if (map.queryRenderedFeatures(box, { layers: ['route-line'] }).length > 0) {
      insertViaPoint([event.lngLat.lng, event.lngLat.lat]);
      return;
    }
  }
  state.waypoints.push([event.lngLat.lng, event.lngLat.lat]);
  rebuildMarkers();
  void recalculateRoute();
});

/** True when a screen point is within grabbing distance of waypoint 1. */
function nearFirstWaypoint(point: maplibregl.Point): boolean {
  if (state.waypoints.length === 0) return false;
  const first = map.project(state.waypoints[0]);
  return Math.hypot(point.x - first.x, point.y - first.y) <= 16;
}

/** Closes the current open route so it returns to point 1. */
async function closeLoop(): Promise<void> {
  state.closed = true;
  await recalculateRoute();
  if (state.route) {
    setStatus('Loop closed. Drag points to adjust, or Reverse direction for the way back.');
  }
}

btnUndo.addEventListener('click', () => {
  // Undo reopens a closed loop first, then removes points one by one.
  if (state.closed) {
    state.closed = false;
  } else {
    state.waypoints.pop();
  }
  rebuildMarkers();
  void recalculateRoute();
});

btnClear.addEventListener('click', () => {
  state.waypoints = [];
  state.closed = false;
  state.avoidZones = [];
  state.mode = 'normal';
  updateAvoidZonesSource();
  syncAvoidZoneUi();
  rebuildMarkers();
  void recalculateRoute();
});

btnReverse.addEventListener('click', () => {
  if (!state.route) return;
  state.importedFileText = null; // reversed route no longer matches the imported file
  state.importedFileFormat = null;
  const reversed = [...state.route.coordinates].reverse();
  state.route = {
    ...state.route,
    coordinates: reversed,
    ascendMeters: elevationGain(reversed),
    geojson: lineFeatureCollection(reversed),
  };
  // Keep waypoints in step with the new direction so later edits reroute
  // correctly. For a closed loop, point 1 stays the start; only the order
  // of the points in between flips.
  if (state.closed && state.waypoints.length > 2) {
    state.waypoints = [state.waypoints[0], ...state.waypoints.slice(1).reverse()];
  } else {
    state.waypoints.reverse();
  }
  rebuildMarkers();
  setRouteData(state.route.geojson);
  renderRouteDetails();
  setStatus('Direction reversed. Export GPX now follows the route the other way round.');
});

/** Wraps a coordinate list in the FeatureCollection the map source expects. */
function lineFeatureCollection(coordinates: [number, number, number][]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } },
    ],
  };
}

btnExport.addEventListener('click', () => {
  if (!state.route) return;
  const name =
    routeNameInput.value.trim() || `Lightmile ${new Date().toISOString().slice(0, 10)}`;
  downloadGpx(state.route.coordinates, name);
});

btnExportTcx.addEventListener('click', () => {
  if (!state.route) return;
  const name =
    routeNameInput.value.trim() || `Lightmile ${new Date().toISOString().slice(0, 10)}`;
  downloadTcx(state.route.coordinates, name);
});

btnShare.addEventListener('click', async () => {
  if (!state.route || state.waypoints.length < 2) return;
  const url = buildShareUrl({
    waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
    bike: settings.bike,
    traffic: settings.traffic,
    closed: state.closed,
  });
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Lightmile route', url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // user cancelled
      // otherwise fall through to the clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Share link copied to clipboard.');
  } catch {
    setStatus(`Copy this link to share: ${url}`);
  }
});

btnSave.addEventListener('click', async () => {
  if (!state.route || state.waypoints.length < 2) return;
  const name =
    routeNameInput.value.trim() || `Route ${new Date().toISOString().slice(0, 10)}`;
  try {
    await saveRoute({
      name,
      waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
      bike: settings.bike,
      traffic: settings.traffic,
      distanceMeters: state.route.distanceMeters,
      createdAt: new Date().toISOString(),
      closed: state.closed,
    });
  } catch {
    // Private-browsing modes and full-storage quotas both land here. Silently
    // doing nothing would look like the save worked.
    setStatus('Could not save: this browser is blocking local storage.', true);
    return;
  }
  routeNameInput.value = '';
  await refreshSavedList();
  setStatus(`Route "${name}" saved.`);
});

btnRoundtrip.addEventListener('click', async () => {
  if (state.waypoints.length === 0) {
    setStatus('First click a start point on the map.', true);
    return;
  }
  const minKm = Number(roundtripMin.value);
  const maxKm = Number(roundtripMax.value);
  if (!minKm || !maxKm || minKm >= maxKm) {
    setStatus('Drag the two handles to set a distance range first.', true);
    return;
  }

  // A round trip replaces any multi-point route; only the start point remains.
  state.waypoints = [state.waypoints[0]];
  state.closed = false;
  rebuildMarkers();

  const requestId = ++state.requestId;
  setStatus('Generating and checking loops… (this can take ~15 s)');
  btnRoundtrip.disabled = true;
  setBusy(true);
  try {
    const result = await generateRoundTrips(
      state.waypoints[0],
      minKm * 1000,
      maxKm * 1000,
      settings.bike,
      settings.hills,
    );
    if (requestId !== state.requestId) return;

    renderWindChip(result.wind);
    if (result.options.length > 0) {
      state.loopOptions = result.options;
      renderLoopOptions();
      selectLoop(0);
      setStatus(
        result.options.length > 1
          ? 'Pick a loop below, or Generate again for new ones.'
          : 'One good loop found. Generate again for new ones.',
      );
    } else {
      state.loopOptions = [];
      state.route = null;
      setRouteData({ type: 'FeatureCollection', features: [] });
      renderRouteDetails();
      renderNoLoopFound(result.failReason, result.fallback);
    }
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.loopOptions = [];
    renderLoopOptions();
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', true);
  } finally {
    // Unconditionally: state.requestId is shared with recalculateRoute(), so
    // any map interaction during generation would bump it and leave the button
    // disabled forever. The stale-result guards above already prevent a
    // superseded run from writing state.
    btnRoundtrip.disabled = false;
    setBusy(false);
  }
  updateControls();
});

/** Renders the quality-passed loops as selectable options. */
function renderLoopOptions(): void {
  loopOptionsEl.innerHTML = '';
  loopOptionsEl.hidden = state.loopOptions.length === 0;
  state.loopOptions.forEach((option, index) => {
    const button = document.createElement('button');
    button.className = 'loop-option';
    button.classList.toggle('active', index === state.selectedLoop);

    const parts = [
      `${(option.route.distanceMeters / 1000).toFixed(1)} km`,
      `${Math.round(option.route.ascendMeters)} m up`,
    ];
    if (option.unpaved !== null) parts.push(`${Math.round(option.unpaved * 100)}% unpaved`);
    if (option.network !== null && option.network > 0.15) {
      parts.push(`${Math.round(option.network * 100)}% on cycle routes`);
    }
    const title = document.createElement('span');
    title.className = 'loop-title';
    title.textContent = `Loop ${index + 1}`;
    const detail = document.createElement('span');
    detail.className = 'loop-detail';
    detail.textContent = parts.join(' · ');
    button.append(title, detail);
    if (option.windNote) {
      const wind = document.createElement('span');
      wind.className = 'loop-wind';
      wind.textContent = option.windNote;
      button.append(wind);
    }
    button.addEventListener('click', () => selectLoop(index));
    loopOptionsEl.append(button);
  });
}

function selectLoop(index: number): void {
  const option = state.loopOptions[index];
  if (!option) return;
  state.selectedLoop = index;
  state.route = option.route;

  // Turn the generated loop into an editable route: drop a handful of
  // draggable waypoints along it and mark it closed. The ORS geometry stays
  // on screen until the user actually drags a point, which reroutes through
  // these waypoints via BRouter.
  const coords = option.route.coordinates;
  state.waypoints = extractTrackWaypoints(coords, true);
  state.closed = true;
  rebuildMarkers();

  setRouteData(option.route.geojson);
  renderRouteDetails();
  updateControls();
  [...loopOptionsEl.children].forEach((el, i) =>
    el.classList.toggle('active', i === index),
  );

  const bounds = coords.reduce(
    (acc, c) => acc.extend([c[0], c[1]]),
    new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
  );
  map.fitBounds(bounds, { padding: 60 });
}

/** Minimum spacing between editable waypoints (avoids clustering). */
const WP_MIN_GAP_M = 1500;
/** Maximum spacing: guarantees at least one waypoint per 5 km. */
const WP_MAX_GAP_M = 5000;
/** A vertex counts as a turn above this bearing change (degrees). */
const WP_TURN_DEG = 30;

/**
 * Picks editable waypoints along a generated loop or an imported track. Within
 * each 1.5-5 km window it places the waypoint on the sharpest turn (so
 * dragging reshapes real corners and junctions); if the stretch is straight
 * it falls back to the 5 km mark. The first waypoint is always the start.
 * `closesToStart` skips adding an explicit final waypoint for closed loops,
 * since `state.closed` already routes the last leg back to point 1; an open
 * track gets its actual endpoint appended instead.
 */
function extractTrackWaypoints(
  coords: [number, number, number][],
  closesToStart: boolean,
): LngLat[] {
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const waypoints: LngLat[] = [[coords[0][0], coords[0][1]]];
  if (total > WP_MAX_GAP_M) {
    const turns = turnMagnitudes(coords, cum);
    let lastDist = 0;
    // Keep placing until the closing/final leg is <= 5 km.
    while (total - lastDist > WP_MAX_GAP_M) {
      const windowStart = lastDist + WP_MIN_GAP_M;
      const windowEnd = Math.min(lastDist + WP_MAX_GAP_M, total - WP_MIN_GAP_M);

      let placeIdx = -1;
      let bestTurn = WP_TURN_DEG;
      for (let i = 0; i < coords.length; i++) {
        if (cum[i] < windowStart) continue;
        if (cum[i] > windowEnd) break;
        if (turns[i] > bestTurn) {
          bestTurn = turns[i];
          placeIdx = i;
        }
      }
      if (placeIdx < 0) placeIdx = indexAtDistance(cum, windowEnd); // straight: 5 km mark

      waypoints.push([coords[placeIdx][0], coords[placeIdx][1]]);
      lastDist = cum[placeIdx];
    }
  }
  if (!closesToStart) {
    const last = coords[coords.length - 1];
    waypoints.push([last[0], last[1]]);
  }
  return waypoints;
}

/** Bearing change (0-180 deg) at each vertex, over an ~80 m window each side. */
function turnMagnitudes(coords: [number, number, number][], cum: number[]): number[] {
  const WINDOW_M = 80;
  const out = new Array(coords.length).fill(0);
  for (let i = 1; i < coords.length - 1; i++) {
    let back = i;
    while (back > 0 && cum[i] - cum[back] < WINDOW_M) back--;
    let fwd = i;
    while (fwd < coords.length - 1 && cum[fwd] - cum[i] < WINDOW_M) fwd++;
    if (back === i || fwd === i) continue;
    out[i] = bearingChange(bearingDeg(coords[back], coords[i]), bearingDeg(coords[i], coords[fwd]));
  }
  return out;
}

function bearingDeg(a: [number, number, number], b: [number, number, number]): number {
  const x = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  const y = b[1] - a[1];
  return (Math.atan2(x, y) * 180) / Math.PI;
}

function bearingChange(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function indexAtDistance(cum: number[], distance: number): number {
  let i = 0;
  while (i < cum.length - 1 && cum[i] < distance) i++;
  return i;
}

/** Honest message when no loop passed the quality gates, with an escape hatch. */
function renderNoLoopFound(reason: string | null, fallback: LoopOption | null): void {
  setStatus(`No good loop found: ${reason ?? 'nothing suitable here'}. Try another distance or start point.`, true);
  loopOptionsEl.innerHTML = '';
  loopOptionsEl.hidden = fallback === null;
  if (!fallback) return;

  const button = document.createElement('button');
  button.className = 'loop-option fallback';
  const title = document.createElement('span');
  title.className = 'loop-title';
  title.textContent = 'Show best match anyway';
  const detail = document.createElement('span');
  detail.className = 'loop-detail';
  detail.textContent =
    `${(fallback.route.distanceMeters / 1000).toFixed(1)} km · but ${rejectionText(fallback)}`;
  button.append(title, detail);
  button.addEventListener('click', () => {
    state.loopOptions = [fallback];
    renderLoopOptions();
    selectLoop(0);
    setStatus('This loop did not pass the quality check; treat it as a rough suggestion.');
  });
  loopOptionsEl.append(button);
}

function renderWindChip(wind: WindInfo | null): void {
  windChipEl.hidden = wind === null;
  if (!wind) return;
  windChipEl.innerHTML = '';
  const arrow = document.createElement('span');
  arrow.className = 'wind-arrow';
  arrow.textContent = '➤';
  // The arrow glyph points east; rotate it to where the wind blows TO.
  arrow.style.transform = `rotate(${Math.round(wind.fromDeg + 90)}deg)`;
  const label = document.createElement('span');
  label.textContent = ` Wind now: ${Math.round(wind.speedKmh)} km/h from ${compassLabel(wind.fromDeg)}`;
  windChipEl.append(arrow, label);
}

// --- Address search & GPS locate -------------------------------------------

/** Adds a waypoint as if the user clicked the map there; flies there if it is the first. */
function addWaypoint(lngLat: LngLat, label?: string): void {
  const isFirst = state.waypoints.length === 0;
  state.waypoints.push(lngLat);
  rebuildMarkers();
  void recalculateRoute();
  if (isFirst) {
    map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 12) });
    setStatus(label ? `Start set at ${label}.` : 'Start point set.');
  } else if (label) {
    setStatus(`Added ${label} as point ${state.waypoints.length}.`);
  }
}

let searchTimer: number | undefined;
let searchAbort: AbortController | null = null;

searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 3) {
    renderSearchResults([]);
    return;
  }
  searchTimer = window.setTimeout(async () => {
    searchAbort?.abort();
    searchAbort = new AbortController();
    try {
      const center = map.getCenter();
      const results = await searchPlaces(query, [center.lng, center.lat], searchAbort.signal);
      renderSearchResults(results);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        renderSearchResults([]);
        setStatus('Address search failed; try again.', true);
      }
    }
  }, 350);
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') renderSearchResults([]);
});

function renderSearchResults(results: GeocodeResult[]): void {
  searchResults.innerHTML = '';
  searchResults.hidden = results.length === 0;
  for (const result of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'search-result';
    const label = document.createElement('span');
    label.className = 'search-label';
    label.textContent = result.label;
    const detail = document.createElement('span');
    detail.className = 'search-detail';
    detail.textContent = result.detail;
    button.append(label, detail);
    button.addEventListener('click', () => {
      searchInput.value = '';
      renderSearchResults([]);
      addWaypoint([...result.lngLat] as LngLat, result.label);
    });
    item.append(button);
    searchResults.append(item);
  }
}

btnLocate.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    setStatus('This browser does not support GPS location.', true);
    return;
  }
  setStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      lastKnownLocation = [position.coords.longitude, position.coords.latitude];
      addWaypoint(lastKnownLocation, 'your location');
    },
    () => setStatus('Could not get your location. Check the location permission.', true),
    { timeout: 10000, maximumAge: 60000 },
  );
});

btnImportGpx.addEventListener('click', () => gpxFileInput.click());

gpxFileInput.addEventListener('change', async () => {
  const file = gpxFileInput.files?.[0];
  gpxFileInput.value = ''; // allow re-selecting the same file later
  if (!file) return;
  try {
    const text = await file.text();
    const isTcx = file.name.toLowerCase().endsWith('.tcx');
    const coords = isTcx ? parseTcx(text) : parseGpx(text);
    const closed = isClosedTrack(coords);
    state.waypoints = extractTrackWaypoints(coords, closed);
    state.closed = closed;
    rebuildMarkers();
    await recalculateRoute();
    // Keep the original file so publishing this route can preserve the exact
    // ridden track. recalculateRoute() cleared it above, so set it back here.
    state.importedFileText = text;
    state.importedFileFormat = isTcx ? 'tcx' : 'gpx';
    if (state.route) {
      const bounds = coords.reduce(
        (acc, c) => acc.extend([c[0], c[1]]),
        new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
      );
      map.fitBounds(bounds, { padding: 60 });
      setStatus(
        `Imported "${file.name}". Turned into an editable route; dragging a point re-routes from there.`,
      );
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not read that file.', true);
  }
});

// --- Round-trip distance range slider ----------------------------------------

/** Keeps the two thumbs apart and paints the label and the selected track segment. */
function syncRangeSlider(moved: 'min' | 'max'): void {
  const step = Number(roundtripMin.step) || 5;
  let min = Number(roundtripMin.value);
  let max = Number(roundtripMax.value);
  if (min > max - step) {
    if (moved === 'min') {
      min = max - step;
      roundtripMin.value = String(min);
    } else {
      max = min + step;
      roundtripMax.value = String(max);
    }
  }
  rangeValue.textContent = `${min} – ${max}`;
  const lo = Number(roundtripMin.min);
  const hi = Number(roundtripMin.max);
  const fromPct = ((min - lo) / (hi - lo)) * 100;
  const toPct = ((max - lo) / (hi - lo)) * 100;
  rangeTrack.style.background =
    `linear-gradient(to right, var(--color-border) ${fromPct}%, ` +
    `var(--color-accent) ${fromPct}%, var(--color-accent) ${toPct}%, ` +
    `var(--color-border) ${toPct}%)`;
}

roundtripMin.addEventListener('input', () => syncRangeSlider('min'));
roundtripMax.addEventListener('input', () => syncRangeSlider('max'));
syncRangeSlider('min');

// --- Cafés along the route ---------------------------------------------------

btnCafes.addEventListener('click', async () => {
  if (!state.route) return;
  btnCafes.disabled = true;
  setStatus('Searching cafés along the route…');
  setBusy(true);
  // Overpass can take 20s. Pin the geometry the results belong to: if the
  // route changed meanwhile, their km marks and off-route distances describe a
  // route that no longer exists.
  const searchedRoute = state.route;
  try {
    const cafes = await fetchCafes(searchedRoute.coordinates);
    if (state.route !== searchedRoute) return;
    state.cafes = cafes;
    renderCafes();
    setStatus(state.cafes.length === 0 ? 'No cafés found along this route.' : '');
  } catch (error) {
    if (state.route !== searchedRoute) return;
    setStatus(error instanceof Error ? error.message : 'Café search failed.', true);
  } finally {
    setBusy(false);
    btnCafes.disabled = false;
  }
});

cafeKmInput.addEventListener('input', () => {
  if (state.cafes.length > 0) renderCafes();
});

/** Renders the café list (optionally filtered around a km mark) and the map dots. */
function renderCafes(): void {
  const aroundKm = Number(cafeKmInput.value);
  const filtered =
    cafeKmInput.value !== '' && !Number.isNaN(aroundKm)
      ? state.cafes.filter((cafe) => Math.abs(cafe.atKm - aroundKm) <= 5)
      : state.cafes;

  cafesList.innerHTML = '';
  if (state.cafes.length > 0 && filtered.length === 0) {
    const note = document.createElement('li');
    note.className = 'cafe-empty';
    note.textContent = `No cafés within 5 km of km ${aroundKm}.`;
    cafesList.append(note);
  }
  for (const cafe of filtered.slice(0, 25)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'cafe-item';
    button.innerHTML =
      `<span class="cafe-where">km ${cafe.atKm.toFixed(1)}</span>` +
      `<span class="cafe-name">${escapeHtml(cafe.name)}</span>` +
      `<span class="cafe-detour">${Math.round(cafe.offRouteM)} m</span>`;
    if (cafe.openingHours) button.title = `Opening hours: ${cafe.openingHours}`;
    button.addEventListener('click', () => {
      map.flyTo({ center: cafe.lngLat, zoom: 15 });
    });
    item.append(button);
    cafesList.append(item);
  }
  setCafeData(filtered);
  renderRoutePills();
}

function setCafeData(cafes: Cafe[]): void {
  const source = map.getSource('cafes') as maplibregl.GeoJSONSource | undefined;
  source?.setData({
    type: 'FeatureCollection',
    features: cafes.map((cafe) => ({
      type: 'Feature',
      properties: {
        name: cafe.name,
        detail:
          `at km ${cafe.atKm.toFixed(1)}, ${Math.round(cafe.offRouteM)} m off route` +
          (cafe.openingHours ? `<br>${cafe.openingHours}` : ''),
      },
      geometry: { type: 'Point', coordinates: cafe.lngLat },
    })),
  });
}

function clearCafes(): void {
  state.cafes = [];
  cafesList.innerHTML = '';
  cafeKmInput.value = '';
  setCafeData([]);
}

// --- Drinking water along the route ------------------------------------------

btnWater.addEventListener('click', async () => {
  if (!state.route) return;
  btnWater.disabled = true;
  setStatus('Searching drinking water along the route…');
  setBusy(true);
  // Same staleness guard as the café search above.
  const searchedRoute = state.route;
  try {
    const water = await fetchWater(searchedRoute.coordinates);
    if (state.route !== searchedRoute) return;
    state.water = water;
    renderWater();
    setStatus(state.water.length === 0 ? 'No drinking water found along this route.' : '');
  } catch (error) {
    if (state.route !== searchedRoute) return;
    setStatus(error instanceof Error ? error.message : 'Water search failed.', true);
  } finally {
    setBusy(false);
    btnWater.disabled = false;
  }
});

/** Renders the drinking-water list and the map dots. */
function renderWater(): void {
  waterList.innerHTML = '';
  for (const point of state.water.slice(0, 25)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'cafe-item water-item';
    button.innerHTML =
      `<span class="cafe-where">km ${point.atKm.toFixed(1)}</span>` +
      `<span class="cafe-name">${escapeHtml(point.name)}</span>` +
      `<span class="water-detour">${Math.round(point.offRouteM)} m</span>`;
    button.addEventListener('click', () => {
      map.flyTo({ center: point.lngLat, zoom: 15 });
    });
    item.append(button);
    waterList.append(item);
  }
  setWaterData(state.water);
  renderRoutePills();
}

function setWaterData(points: WaterPoint[]): void {
  const source = map.getSource('water') as maplibregl.GeoJSONSource | undefined;
  source?.setData({
    type: 'FeatureCollection',
    features: points.map((point) => ({
      type: 'Feature',
      properties: {
        name: point.name,
        detail: `at km ${point.atKm.toFixed(1)}, ${Math.round(point.offRouteM)} m off route`,
      },
      geometry: { type: 'Point', coordinates: point.lngLat },
    })),
  });
}

function clearWater(): void {
  state.water = [];
  waterList.innerHTML = '';
  setWaterData([]);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Wires a chevron toggle button to show/hide the content it controls, collapsed
 * by default. Used for "Bike, traffic & hills" and "Sort & filter" so the
 * primary action (search/generate, the route list) sits above the fold on
 * mobile instead of being pushed down by settings most visits don't change.
 */
function initDisclosure(toggleSelector: string, bodySelector: string): void {
  const toggle = document.querySelector<HTMLButtonElement>(toggleSelector);
  const body = document.querySelector<HTMLElement>(bodySelector);
  if (!toggle || !body) return;
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    body.hidden = expanded;
  });
}

initDisclosure('#planner-options-toggle', '#planner-options-body');
initDisclosure('#community-filters-toggle', '#community-filters-body');

bikeButtons.forEach((button) =>
  button.addEventListener('click', () => {
    settings.bike = button.dataset.bike as BikeType;
    persistSettings();
    syncProfileUi();
    void recalculateRoute();
  }),
);

// Hills preference only affects the next round trip, so no reroute here.
hillsButtons.forEach((button) =>
  button.addEventListener('click', () => {
    settings.hills = button.dataset.hills as HillPreference;
    persistSettings();
    syncProfileUi();
  }),
);

trafficSelect.addEventListener('change', () => {
  settings.traffic = Number(trafficSelect.value);
  persistSettings();
  void recalculateRoute();
});

btnAvoidZone.addEventListener('click', () => {
  state.mode = state.mode === 'avoid' ? 'normal' : 'avoid';
  syncAvoidZoneUi();
});

avoidZoneRadiusButtons.forEach((button) =>
  button.addEventListener('click', () => {
    state.avoidZoneRadius = Number(button.dataset.radius);
    avoidZoneRadiusButtons.forEach((b) => {
      const active = b === button;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }),
);

btnClearAvoidZones.addEventListener('click', () => {
  state.avoidZones = [];
  updateAvoidZonesSource();
  syncAvoidZoneUi();
  void recalculateRoute();
});

chartCanvas.addEventListener('mouseleave', () => {
  if (hoverMarkerVisible) {
    hoverMarker.remove();
    hoverMarkerVisible = false;
  }
});

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

function persistSettings(): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Blocked or full storage must not abort the caller: persistSettings runs
    // partway through the bike/traffic/hills handlers and through every route
    // load, and throwing here would leave the UI half-updated.
  }
}

function currentProfile(): string {
  if (settings.bike === 'gravel') return 'gravel';
  if (settings.bike === 'mtb') return 'mtb';
  return TRAFFIC_PROFILES[settings.traffic];
}

function syncProfileUi(): void {
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
  trafficLabel.hidden = settings.bike !== 'race';
  trafficSelect.value = String(settings.traffic);
}

/** Recreates all markers from state.waypoints, keeping numbering correct. */
function rebuildMarkers(): void {
  state.markers.forEach((marker) => marker.remove());
  state.markers = state.waypoints.map((waypoint, index) => {
    const el = document.createElement('div');
    el.className = 'waypoint-marker';
    el.textContent = String(index + 1);
    el.title =
      index === 0
        ? 'Point 1 (start). Drag to move; click to close the loop.'
        : 'Drag to move; click to remove this point.';
    const marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(waypoint)
      .addTo(map);

    // Distinguish a click (remove/close) from a drag (move): a drag fires
    // dragstart, which suppresses the click that the browser fires on release.
    let dragged = false;
    marker.on('dragstart', () => {
      dragged = true;
    });
    marker.on('dragend', () => {
      const markerIndex = state.markers.indexOf(marker);
      const position = marker.getLngLat();
      state.waypoints[markerIndex] = [position.lng, position.lat];
      void recalculateRoute();
    });
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (dragged) {
        dragged = false;
        return;
      }
      const markerIndex = state.markers.indexOf(marker);
      if (markerIndex === 0) {
        // Point 1 is the start/anchor: a click closes an open loop but never
        // deletes the point (use Clear to start over).
        if (!state.closed && state.waypoints.length >= 3) void closeLoop();
        return;
      }
      removeWaypoint(markerIndex);
    });
    return marker;
  });
}

/** Removes one waypoint by index, keeping a routable minimum. */
function removeWaypoint(index: number): void {
  if (index < 0 || index >= state.waypoints.length) return;
  const floor = state.closed ? 3 : 2;
  if (state.waypoints.length <= floor) {
    setStatus(
      state.closed
        ? 'A loop needs at least 3 points. Use Clear to start over.'
        : 'Use Undo or Clear to remove the last points.',
      true,
    );
    return;
  }
  state.waypoints.splice(index, 1);
  rebuildMarkers();
  void recalculateRoute();
}

/** Inserts a via-point into the leg it deviates least from (straight-line heuristic). */
function insertViaPoint(point: LngLat): void {
  let bestIndex = 1;
  let bestDetour = Infinity;
  for (let i = 0; i < state.waypoints.length - 1; i++) {
    const detour =
      haversineMeters(state.waypoints[i], point) +
      haversineMeters(point, state.waypoints[i + 1]) -
      haversineMeters(state.waypoints[i], state.waypoints[i + 1]);
    if (detour < bestDetour) {
      bestDetour = detour;
      bestIndex = i + 1;
    }
  }
  state.waypoints.splice(bestIndex, 0, point);
  rebuildMarkers();
  void recalculateRoute();
}

async function recalculateRoute(): Promise<void> {
  const requestId = ++state.requestId;
  // Any reroute means the route no longer matches the original imported file.
  state.importedFileText = null;
  state.importedFileFormat = null;

  // Manual routing replaces any round-trip suggestions.
  if (state.loopOptions.length > 0) {
    state.loopOptions = [];
    state.selectedLoop = -1;
    renderLoopOptions();
  }

  if (state.waypoints.length < 2) {
    state.closed = false;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus('');
    updateControls();
    return;
  }

  // A closed loop routes back to point 1 by repeating it as the final target.
  const routingWaypoints = state.closed
    ? [...state.waypoints, state.waypoints[0]]
    : state.waypoints;

  // Cancel whatever was in flight. Without this, dragging a point repeatedly
  // leaves every earlier request running, and the public BRouter server queues
  // the newest one (the only one anybody wants) behind all of them.
  routeAbort?.abort();
  const abort = new AbortController();
  routeAbort = abort;

  setStatus('Calculating route…');
  setBusy(true);
  try {
    const route = await fetchRoute(routingWaypoints, currentProfile(), state.avoidZones, abort.signal);
    if (requestId !== state.requestId) return; // a newer request superseded this one
    state.route = route;
    setRouteData(route.geojson);
    renderRouteDetails();
    setStatus('');
  } catch (error) {
    if (error instanceof RouteCancelledError) return;
    if (requestId !== state.requestId) return;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', true);
  } finally {
    setBusy(false);
    if (routeAbort === abort) routeAbort = null;
  }
  updateControls();
}

/** In-flight manual route request, so a newer one can cancel it. */
let routeAbort: AbortController | null = null;

/**
 * Komoot-style lazy re-validation: a saved or published route stores only its
 * waypoints, so loading it re-runs the router against today's map data and the
 * result can legitimately differ from what was saved. Say so when it does,
 * rather than silently showing a different distance than the list promised.
 *
 * The threshold keeps ordinary router jitter quiet; only real reroutes speak up.
 */
function routeChangeNote(savedMeters: number | null | undefined): string {
  if (!savedMeters || !state.route) return '';
  const diff = state.route.distanceMeters - savedMeters;
  if (Math.abs(diff) < Math.max(150, savedMeters * 0.01)) return '';
  const km = (Math.abs(diff) / 1000).toFixed(1);
  return ` Route updated to current map data: ${km} km ${diff > 0 ? 'longer' : 'shorter'} than when it was saved.`;
}

function setRouteData(data: FeatureCollection): void {
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

function updateAvoidZonesSource(): void {
  const source = map.getSource('avoid-zones') as maplibregl.GeoJSONSource | undefined;
  source?.setData(buildAvoidZonesGeoJson(state.avoidZones));
}

/**
 * Round trips (ORS) don't support avoid zones yet (BRouter's nogos and ORS's
 * avoid_polygons are incompatible shapes), so the toggle is disabled whenever
 * a round trip is active.
 */
function syncAvoidZoneUi(): void {
  btnAvoidZone.disabled = state.closed;
  btnAvoidZone.title = state.closed
    ? 'Not available for round trips yet'
    : 'Click the map to mark a circular area to avoid';
  btnAvoidZone.classList.toggle('active', state.mode === 'avoid');
  btnAvoidZone.setAttribute('aria-pressed', String(state.mode === 'avoid'));
  btnAvoidZone.textContent = state.mode === 'avoid' ? 'Click the map…' : 'Mark area';
  avoidZoneRadiusButtons.forEach((button) => (button.disabled = state.closed));
  btnClearAvoidZones.hidden = state.avoidZones.length === 0;
}

/** Renders stats, elevation chart, surface bar and climbs for the current route (or clears them). */
// The elevation chart (chart.js/auto) is only ever needed once a route
// exists, so it's dynamically imported here rather than statically at the
// top of the file, keeping the heavy library out of the initial bundle.
// Cached after the first load so later route updates reuse the same module.
type ChartModule = typeof import('./chart');
let chartModulePromise: Promise<ChartModule> | null = null;
function loadChartModule(): Promise<ChartModule> {
  if (!chartModulePromise) chartModulePromise = import('./chart');
  return chartModulePromise;
}

function renderRouteDetails(): void {
  // Any route change invalidates café results found for the previous route.
  clearCafes();
  clearWater();
  cafesEl.hidden = !state.route;
  waterEl.hidden = !state.route;
  statsSection.hidden = !state.route;
  routeEmpty.hidden = !!state.route;

  if (state.route) {
    statDistance.textContent = `${(state.route.distanceMeters / 1000).toFixed(1)} km`;
    statAscend.textContent = `${Math.round(state.route.ascendMeters)} m`;

    state.climbs = detectClimbs(state.route.coordinates);
    state.selectedClimb = -1;
    setClimbHighlight(null);
    renderClimbsList();

    chartWrap.hidden = false;
    gradeLegendEl.hidden = false;
    void loadChartModule().then(({ renderElevationChart }) => {
      // The route may have changed again while the chart module was loading;
      // read state.route fresh here rather than capturing it earlier.
      if (!state.route) return;
      renderElevationChart(chartCanvas, state.route.coordinates, (index) => {
        const [lng, lat] = state.route!.coordinates[index];
        hoverMarker.setLngLat([lng, lat]);
        if (!hoverMarkerVisible) {
          hoverMarker.addTo(map);
          hoverMarkerVisible = true;
        }
      });
    });

    const totals = state.route.surface ?? surfaceBreakdown(state.route.messages);
    if (totals) {
      surfaceEl.hidden = false;
      renderSurfaceBar(surfaceEl, totals);
    } else {
      surfaceEl.hidden = true;
    }
  } else {
    statDistance.textContent = '–';
    statAscend.textContent = '–';
    chartWrap.hidden = true;
    gradeLegendEl.hidden = true;
    surfaceEl.hidden = true;
    climbsEl.hidden = true;
    state.climbs = [];
    state.selectedClimb = -1;
    setClimbHighlight(null);
    // Nothing to clear if the chart module was never loaded (no route yet).
    if (chartModulePromise) {
      void chartModulePromise.then(({ clearElevationChart }) => clearElevationChart());
    }
    if (hoverMarkerVisible) {
      hoverMarker.remove();
      hoverMarkerVisible = false;
    }
  }
  renderRoutePills();
}

/** Compact at-a-glance pills summarizing climbs and coffee stops. */
function renderRoutePills(): void {
  const pills: string[] = [];
  if (state.climbs.length > 0) {
    const n = state.climbs.length;
    const gain = Math.round(state.climbs.reduce((sum, c) => sum + c.gainM, 0));
    pills.push(`<span class="pill climb">▲ ${n} climb${n > 1 ? 's' : ''} · +${gain} m</span>`);
  }
  if (state.cafes.length > 0) {
    const n = state.cafes.length;
    pills.push(`<span class="pill cafe">☕ ${n} coffee stop${n > 1 ? 's' : ''}</span>`);
  }
  if (state.water.length > 0) {
    const n = state.water.length;
    pills.push(`<span class="pill water">💧 ${n} water</span>`);
  }
  routePills.innerHTML = pills.join('');
  routePills.hidden = pills.length === 0;
}

/** Lists detected climbs; clicking one highlights it on the map and zooms to it. */
function renderClimbsList(): void {
  climbsEl.hidden = state.climbs.length === 0;
  climbsList.innerHTML = '';
  state.climbs.forEach((climb, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'climb-item';
    button.innerHTML =
      `<span class="climb-where">km ${climb.startKm.toFixed(1)}</span>` +
      `<span>${(climb.lengthM / 1000).toFixed(1)} km at ${climb.avgPct.toFixed(1)}%</span>` +
      `<span class="climb-gain">+${Math.round(climb.gainM)} m</span>`;
    button.title = `Steepest 100 m: ${climb.maxPct.toFixed(0)}%`;
    button.addEventListener('click', () => {
      if (state.selectedClimb === index) {
        state.selectedClimb = -1;
        setClimbHighlight(null);
      } else {
        state.selectedClimb = index;
        setClimbHighlight(climb);
        const coords = state.route!.coordinates.slice(climb.startIndex, climb.endIndex + 1);
        const bounds = coords.reduce(
          (acc, c) => acc.extend([c[0], c[1]]),
          new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
        );
        map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
      }
      [...climbsList.querySelectorAll('.climb-item')].forEach((el, i) =>
        el.classList.toggle('active', i === state.selectedClimb),
      );
    });
    item.append(button);
    climbsList.append(item);
  });
}

function setClimbHighlight(climb: Climb | null): void {
  const source = map.getSource('climb-highlight') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  if (!climb || !state.route) {
    source.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  source.setData({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: state.route.coordinates.slice(climb.startIndex, climb.endIndex + 1),
        },
      },
    ],
  });
}

async function refreshSavedList(): Promise<void> {
  const routes = await listRoutes();
  savedList.innerHTML = '';
  for (const route of routes) {
    const item = document.createElement('li');

    const label = document.createElement('button');
    label.className = 'saved-name';
    label.textContent = `${route.name} · ${(route.distanceMeters / 1000).toFixed(1)} km`;
    label.title = 'Load this route';
    label.addEventListener('click', () => void loadSaved(route));

    const remove = document.createElement('button');
    remove.className = 'saved-delete';
    remove.textContent = '✕';
    remove.title = 'Delete';
    remove.addEventListener('click', async () => {
      try {
        await deleteRoute(route.id!);
      } catch {
        setStatus('Could not delete that saved route.', true);
        return;
      }
      await refreshSavedList();
    });

    item.append(label, remove);
    savedList.append(item);
  }
}

async function loadSaved(route: SavedRoute): Promise<void> {
  const waypoints = sanitizeWaypoints(route.waypoints);
  if (!waypoints) {
    setStatus(`"${route.name}" could not be loaded; its saved points are unreadable.`, true);
    return;
  }
  state.waypoints = waypoints;
  state.closed = route.closed ?? false;
  settings.bike = (['race', 'gravel', 'mtb'].includes(route.bike) ? route.bike : 'race') as BikeType;
  settings.traffic = [0, 1, 2].includes(route.traffic) ? route.traffic : 0;
  persistSettings();
  syncProfileUi();
  rebuildMarkers();

  const bounds = state.waypoints.reduce(
    (acc, wp) => acc.extend(wp),
    new maplibregl.LngLatBounds(state.waypoints[0], state.waypoints[0]),
  );
  map.fitBounds(bounds, { padding: 60 });

  // Awaited before setting the status, or recalculateRoute's own status flow
  // would immediately clobber it.
  await recalculateRoute();
  setStatus(`Loaded "${route.name}".${routeChangeNote(route.distanceMeters)}`);
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
  syncStatusBar();
}

/**
 * Counted rather than boolean: several things can be in flight at once (a
 * reroute plus a café search, say), and the first one to finish must not clear
 * the indicator while the others are still running.
 */
let busyCount = 0;

function setBusy(busy: boolean): void {
  busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
  syncStatusBar();
}

// Routing, search and the community library all need the network. Cached map
// tiles keep the map itself usable offline, which makes the failure mode
// confusing: everything looks fine until an action silently fails with a raw
// "Failed to fetch". Say it plainly instead.
window.addEventListener('offline', () => {
  setStatus('You are offline. The map still works, but routing and search do not.', true);
});
window.addEventListener('online', () => {
  if (statusEl.classList.contains('error')) setStatus('Back online.');
});

function syncStatusBar(): void {
  statusBarEl.dataset.state = busyCount > 0
    ? 'busy'
    : statusEl.textContent
      ? 'message'
      : 'idle';
}

function updateControls(): void {
  btnUndo.disabled = state.waypoints.length === 0 && !state.closed;
  btnClear.disabled = state.waypoints.length === 0;
  btnReverse.disabled = !state.route;
  btnExport.disabled = !state.route;
  btnExportTcx.disabled = !state.route;
  btnSave.disabled = !state.route || state.waypoints.length < 2;
  btnShare.disabled = !state.route || state.waypoints.length < 2;
  syncAvoidZoneUi();
  updatePublishButton();
}

/** Loads a route shared via URL (see share.ts), if the link carries one. */
async function applySharedRoute(): Promise<void> {
  const shared = parseShareUrl(window.location.search);
  if (!shared) return;
  state.waypoints = shared.waypoints;
  state.closed = shared.closed;
  settings.bike = shared.bike as BikeType;
  settings.traffic = shared.traffic;
  persistSettings();
  syncProfileUi();
  rebuildMarkers();
  const bounds = state.waypoints.reduce(
    (acc, wp) => acc.extend(wp),
    new maplibregl.LngLatBounds(state.waypoints[0], state.waypoints[0]),
  );
  map.fitBounds(bounds, { padding: 60 });
  await recalculateRoute();
  if (state.route) setStatus('Loaded a shared route.');
}

syncProfileUi();
syncAvoidZoneUi();
void refreshSavedList();
renderGradeLegend(gradeLegendEl);

// --- Community library (Supabase) ------------------------------------------
// Publishing/rating needs sign-in; browsing is public. The whole section only
// appears when the backend is configured, so the planner works without it.
let currentUser: User | null = null;
// 'near' is a client-side proximity sort layered on a newest fetch.
type CommunitySortMode = CommunitySort | 'near';
let communitySort: CommunitySortMode = 'newest';
let communityBikeFilter: 'all' | 'race' | 'gravel' | 'mtb' = 'all';
let communityHillsFilter: 'all' | 'flat' | 'hilly' = 'all';
// Last fetched page, kept so changing a client-side filter re-renders without
// hitting the network again.
let communityRoutes: CommunityRoute[] = [];
let communityRatings = new Map<string, number>();

const AUTHOR_KEY = 'lightmile-author';
const CITY_CACHE_KEY = 'lightmile-city-cache';

// Metres of climbing per km above which a route counts as "hilly".
const HILLY_THRESHOLD = 10;
// Distance slider ceiling (km); the max thumb here means "no upper limit".
const DIST_MAX = 200;

// Reverse-geocoded town per route id, cached across sessions so the community
// list needs no extra DB column and no repeat lookups.
const cityCache = new Map<string, string>();
try {
  const raw = localStorage.getItem(CITY_CACHE_KEY);
  if (raw) {
    for (const [id, city] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      cityCache.set(id, city);
    }
  }
} catch {
  /* corrupt cache: ignore, it rebuilds itself */
}

function rememberCity(id: string, city: string): void {
  cityCache.set(id, city);
  try {
    localStorage.setItem(CITY_CACHE_KEY, JSON.stringify(Object.fromEntries(cityCache)));
  } catch {
    /* storage full or unavailable: the in-memory cache still works this session */
  }
}

function routeIsHilly(route: CommunityRoute): boolean {
  const km = route.distanceMeters / 1000;
  if (km <= 0) return false;
  return route.ascendMeters / km >= HILLY_THRESHOLD;
}

function routeCentroid(route: CommunityRoute): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [lng, lat] of route.waypoints) {
    sx += lng;
    sy += lat;
  }
  const n = route.waypoints.length || 1;
  return [sx / n, sy / n];
}

/** Nearest approach (metres) of the route to the user, or null without a fix. */
function routeDistanceFromUser(route: CommunityRoute): number | null {
  if (!lastKnownLocation) return null;
  let min = Infinity;
  for (const wp of route.waypoints) {
    const d = haversineMeters(lastKnownLocation, wp);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

function filteredCommunityRoutes(): CommunityRoute[] {
  const distMin = Number(communityDistMin.value);
  const distMax = Number(communityDistMax.value);
  const list = communityRoutes.filter((route) => {
    if (communityBikeFilter !== 'all' && route.bike !== communityBikeFilter) return false;
    if (communityHillsFilter === 'flat' && routeIsHilly(route)) return false;
    if (communityHillsFilter === 'hilly' && !routeIsHilly(route)) return false;
    const km = route.distanceMeters / 1000;
    if (km < distMin) return false;
    if (distMax < DIST_MAX && km > distMax) return false;
    return true;
  });
  if (communitySort === 'near' && lastKnownLocation) {
    list.sort(
      (a, b) => (routeDistanceFromUser(a) ?? Infinity) - (routeDistanceFromUser(b) ?? Infinity),
    );
  }
  return list;
}

function updatePublishButton(): void {
  if (!isSupabaseConfigured) return;
  btnPublish.disabled = !state.route || state.waypoints.length < 2 || !currentUser;
  btnPublish.title = currentUser ? '' : 'Sign in on the Community tab to publish';
}

// Everything below, up to the end of deleteCommunityRoute(), only runs once
// the community backend chunk (chart-free, but pulls in @supabase/supabase-js
// via ./auth and ./community) has loaded — see loadCommunityBackend() and its
// call site further down. `auth`/`community` are the resolved module
// namespaces, passed in once, rather than re-imported at each call site.
function initCommunityFeature(
  auth: typeof import('./auth'),
  community: typeof import('./community'),
): void {
/** Switches between the Route planner and Community tabs. */
function setActiveTab(name: 'planner' | 'community'): void {
  mainTabButtons.forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  plannerPanel.hidden = name !== 'planner';
  communityPanel.hidden = name !== 'community';
  brandSub.textContent = name === 'community' ? 'Community' : 'Route planner';
  if (name === 'community') void refreshCommunity();
}

if (isSupabaseConfigured) {
  mainTabs.hidden = false;
  btnPublish.hidden = false;

  mainTabButtons.forEach((btn) => {
    btn.addEventListener('click', () =>
      setActiveTab(btn.dataset.tab === 'community' ? 'community' : 'planner'),
    );
  });

  auth.onAuthChange((user) => {
    currentUser = user;
    accountSignedOut.hidden = !!user;
    accountSignedIn.hidden = !user;
    authorField.hidden = !user;
    if (user) {
      accountName.textContent = user.email ?? 'you';
      // Prefill the display name from last time, else the email's local part.
      if (!authorNameInput.value) {
        authorNameInput.value =
          localStorage.getItem(AUTHOR_KEY) ?? user.email?.split('@')[0] ?? '';
      }
      // Clean up this owner's routes whose grace period has passed.
      void community.purgeExpiredRoutes();
    }
    updatePublishButton();
    void refreshCommunity();
  });

  authorNameInput.addEventListener('input', () => {
    localStorage.setItem(AUTHOR_KEY, authorNameInput.value.trim());
  });

  btnSignin.addEventListener('click', async () => {
    const email = accountEmail.value.trim();
    if (!email) {
      setStatus('Enter your email to get a sign-in link.', true);
      return;
    }
    btnSignin.disabled = true;
    try {
      await auth.sendMagicLink(email);
      setStatus(`Sign-in link sent to ${email}. Open it on this device to finish.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not send the sign-in link.', true);
    } finally {
      btnSignin.disabled = false;
    }
  });

  btnSignout.addEventListener('click', async () => {
    await auth.signOut();
    setStatus('Signed out.');
  });

  btnPublish.addEventListener('click', async () => {
    if (!state.route || state.waypoints.length < 2 || !currentUser) return;
    const name =
      routeNameInput.value.trim() || `Route ${new Date().toISOString().slice(0, 10)}`;
    btnPublish.disabled = true;
    setStatus('Publishing…');
    setBusy(true);
    try {
      await community.publishRoute({
        name,
        authorName: authorNameInput.value.trim() || null,
        waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
        bike: settings.bike,
        traffic: settings.traffic,
        closed: state.closed,
        distanceMeters: state.route.distanceMeters,
        ascendMeters: state.route.ascendMeters,
        source: state.importedFileText ? 'imported' : 'planned',
        originalFileText: state.importedFileText,
        originalFileFormat: state.importedFileFormat,
      });
      setStatus(`Published "${name}" to the community library.`);
      await refreshCommunity();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not publish this route.', true);
    } finally {
      setBusy(false);
      updatePublishButton();
    }
  });

  // Newest/Top are server-side (they change the query order), so they refetch.
  // "Near me" plus bike/hills/distance are client-side over the fetched page.
  communitySortButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sort = (btn.dataset.sort as CommunitySortMode) ?? 'newest';
      if (sort === 'near' && !(await ensureLocation())) return; // no fix: keep current sort
      communitySort = sort;
      setActiveInGroup(communitySortButtons, btn);
      void refreshCommunity();
    });
  });

  communityBikeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      communityBikeFilter = (btn.dataset.bike as typeof communityBikeFilter) ?? 'all';
      setActiveInGroup(communityBikeButtons, btn);
      renderCommunityList(filteredCommunityRoutes(), communityRatings);
    });
  });

  communityHillsButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      communityHillsFilter = (btn.dataset.hills as typeof communityHillsFilter) ?? 'all';
      setActiveInGroup(communityHillsButtons, btn);
      renderCommunityList(filteredCommunityRoutes(), communityRatings);
    });
  });

  const onDistInput = (moved: 'min' | 'max') => () => {
    syncCommunityDistSlider(moved);
    renderCommunityList(filteredCommunityRoutes(), communityRatings);
  };
  communityDistMin.addEventListener('input', onDistInput('min'));
  communityDistMax.addEventListener('input', onDistInput('max'));
  syncCommunityDistSlider('min');
}

/** Resolves to the user's location, requesting a GPS fix once if needed. */
function ensureLocation(): Promise<[number, number] | null> {
  if (lastKnownLocation) return Promise.resolve(lastKnownLocation);
  if (!('geolocation' in navigator)) {
    setStatus('This browser does not support GPS location.', true);
    return Promise.resolve(null);
  }
  setStatus('Getting your location…');
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        lastKnownLocation = [position.coords.longitude, position.coords.latitude];
        setStatus('');
        resolve(lastKnownLocation);
      },
      () => {
        setStatus('Could not get your location. Check the location permission.', true);
        resolve(null);
      },
      { timeout: 10000, maximumAge: 60000 },
    );
  });
}

/** Keeps the two distance thumbs apart and paints the label and track fill. */
function syncCommunityDistSlider(moved: 'min' | 'max'): void {
  const step = Number(communityDistMin.step) || 5;
  let min = Number(communityDistMin.value);
  let max = Number(communityDistMax.value);
  if (min > max - step) {
    if (moved === 'min') {
      min = max - step;
      communityDistMin.value = String(min);
    } else {
      max = min + step;
      communityDistMax.value = String(max);
    }
  }
  const maxLabel = max >= DIST_MAX ? `${DIST_MAX}+` : String(max);
  communityDistValue.textContent =
    min === 0 && max >= DIST_MAX ? 'Any length' : `${min} – ${maxLabel} km`;
  const lo = Number(communityDistMin.min);
  const hi = Number(communityDistMin.max);
  const fromPct = ((min - lo) / (hi - lo)) * 100;
  const toPct = ((max - lo) / (hi - lo)) * 100;
  communityDistTrack.style.background =
    `linear-gradient(to right, var(--color-border) ${fromPct}%, ` +
    `var(--color-accent) ${fromPct}%, var(--color-accent) ${toPct}%, ` +
    `var(--color-border) ${toPct}%)`;
}

/** Marks one button active within a segmented group, clearing the rest. */
function setActiveInGroup(buttons: HTMLButtonElement[], active: HTMLButtonElement): void {
  buttons.forEach((b) => {
    const on = b === active;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

async function refreshCommunity(): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    // 'near' has no server ordering; fetch newest and sort by distance client-side.
    const serverSort: CommunitySort = communitySort === 'near' ? 'newest' : communitySort;
    const [routes, myRatings] = await Promise.all([
      community.fetchCommunityRoutes(serverSort),
      community.fetchMyRatings(),
    ]);
    communityRoutes = routes;
    communityRatings = myRatings;
    renderCommunityList(filteredCommunityRoutes(), communityRatings);
  } catch (error) {
    // Non-fatal: the planner keeps working even if the library can't load.
    console.warn('Could not load community routes:', error);
  }
}

function renderCommunityList(routes: CommunityRoute[], myRatings: Map<string, number>): void {
  communityList.innerHTML = '';
  if (routes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'community-empty';
    empty.textContent =
      communityRoutes.length === 0
        ? 'No routes published yet. Plan one and hit Publish.'
        : 'No routes match these filters.';
    communityList.append(empty);
    return;
  }
  for (const route of routes) {
    const item = document.createElement('li');
    item.className = 'community-item';

    const head = document.createElement('div');
    head.className = 'community-head';
    const name = document.createElement('span');
    name.className = 'community-name';
    name.textContent = route.name;
    const meta = document.createElement('span');
    meta.className = 'community-meta';
    meta.textContent =
      `${(route.distanceMeters / 1000).toFixed(1)} km · +${Math.round(route.ascendMeters)} m · ${route.bike}`;
    const author = document.createElement('span');
    author.className = 'community-author';
    const authorName = route.authorName?.trim() || 'Anonymous';
    author.innerHTML = 'by ';
    const authorStrong = document.createElement('strong');
    authorStrong.textContent = authorName;
    author.append(authorStrong);
    const loc = document.createElement('span');
    loc.className = 'community-loc';
    loc.textContent = communityLocLabel(route);
    loc.hidden = loc.textContent === '';
    head.append(name, meta, author, loc);
    void fillCity(route, loc);

    const ratingRow = document.createElement('div');
    ratingRow.className = 'community-rating';
    ratingRow.append(buildStars(route, myRatings.get(route.id) ?? 0));
    const summary = document.createElement('span');
    summary.className = 'rating-summary';
    summary.textContent =
      route.ratingCount > 0
        ? `${route.avgRating.toFixed(1)} (${route.ratingCount})`
        : 'no ratings yet';
    ratingRow.append(summary);

    const actions = document.createElement('div');
    actions.className = 'community-actions';
    const load = document.createElement('button');
    load.className = 'community-load';
    load.type = 'button';
    load.textContent = 'Load';
    load.addEventListener('click', () => void loadCommunityRoute(route));
    actions.append(load);
    if (route.gpxPath) {
      const url = community.fileDownloadUrl(route.gpxPath);
      if (url) {
        // Rows published before file_format existed are all GPX (the only
        // format the app produced back then).
        const format = route.fileFormat ?? 'gpx';
        const download = document.createElement('a');
        download.className = 'community-gpx';
        download.href = url;
        download.textContent = format.toUpperCase();
        download.setAttribute('download', `${route.name.replace(/[^\w-]+/g, '_')}.${format}`);
        actions.append(download);
      }
    }
    if (currentUser && route.ownerId === currentUser.id) {
      const del = document.createElement('button');
      del.className = 'community-delete';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', () => void deleteCommunityRoute(route));
      actions.append(del);
    }

    const body = document.createElement('div');
    body.className = 'community-body';
    body.append(head, ratingRow, actions);

    const preview = buildRoutePreviewSvg(route.waypoints as [number, number][], route.closed);
    item.append(preview, body);
    communityList.append(item);
  }
}

/** City (once reverse-geocoded) plus distance-from-you, for a route's location line. */
function communityLocLabel(route: CommunityRoute): string {
  const parts: string[] = [];
  const city = cityCache.get(route.id);
  if (city) parts.push(city);
  const away = routeDistanceFromUser(route);
  if (away != null) {
    const km = away / 1000;
    parts.push(`${km < 10 ? km.toFixed(1) : Math.round(km)} km away`);
  }
  return parts.join(' · ');
}

/** Fills in a route's town name once, lazily, then updates its location line. */
async function fillCity(route: CommunityRoute, loc: HTMLElement): Promise<void> {
  if (cityCache.has(route.id)) return;
  try {
    const city = await reverseCity(routeCentroid(route));
    if (!city) return;
    rememberCity(route.id, city);
    loc.textContent = communityLocLabel(route);
    loc.hidden = loc.textContent === '';
  } catch {
    /* best-effort: a missing town label is not worth surfacing */
  }
}

/** A 5-star widget: interactive buttons when signed in, static stars otherwise. */
function buildStars(route: CommunityRoute, myStars: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'stars';
  const interactive = !!currentUser;
  wrap.classList.toggle('interactive', interactive);
  // Fill to the user's own rating if they rated, otherwise the rounded average.
  const fillTo = myStars || Math.round(route.avgRating);
  for (let n = 1; n <= 5; n++) {
    const star = document.createElement(interactive ? 'button' : 'span');
    star.className = 'star';
    star.classList.toggle('filled', n <= fillTo);
    if (myStars) star.classList.toggle('mine', n <= myStars);
    star.textContent = '★';
    if (interactive) {
      const button = star as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-label', `Rate ${n} star${n > 1 ? 's' : ''}`);
      button.addEventListener('click', async () => {
        try {
          await community.rateRoute(route.id, n);
          setStatus(`Rated "${route.name}" ${n} star${n > 1 ? 's' : ''}.`);
          await refreshCommunity();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Could not save your rating.', true);
        }
      });
    }
    wrap.append(star);
  }
  return wrap;
}

/** Loads a community route: same as a saved route, recomputed via BRouter. */
async function loadCommunityRoute(route: CommunityRoute): Promise<void> {
  state.waypoints = route.waypoints.map((wp) => [...wp] as LngLat);
  state.closed = route.closed;
  settings.bike = (['race', 'gravel', 'mtb'].includes(route.bike) ? route.bike : 'race') as BikeType;
  settings.traffic = [0, 1, 2].includes(route.traffic) ? route.traffic : 0;
  persistSettings();
  syncProfileUi();
  rebuildMarkers();
  const bounds = state.waypoints.reduce(
    (acc, wp) => acc.extend(wp),
    new maplibregl.LngLatBounds(state.waypoints[0], state.waypoints[0]),
  );
  map.fitBounds(bounds, { padding: 60 });
  await recalculateRoute();
  if (state.route) setStatus(`Loaded "${route.name}".${routeChangeNote(route.distanceMeters)}`);
}

/** Soft-deletes the owner's own community route after a confirmation. */
async function deleteCommunityRoute(route: CommunityRoute): Promise<void> {
  const confirmed = window.confirm(
    `Delete "${route.name}" from the community? It disappears from the library right away, ` +
      `and is kept recoverable for ${community.GRACE_DAYS} days before it is removed for good.`,
  );
  if (!confirmed) return;
  try {
    await community.softDeleteRoute(route.id);
    setStatus(`Deleted "${route.name}". Recoverable for ${community.GRACE_DAYS} days.`);
    await refreshCommunity();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not delete this route.', true);
  }
}
} // end initCommunityFeature

// Load the community backend (chart-free, but pulls in the heavy
// @supabase/supabase-js via ./auth and ./community) off the critical path:
// kicked off during idle time rather than gated behind the user actually
// opening the Community tab, so it's typically ready by the time they do,
// without delaying first paint/interactivity of the map and planner.
// isSupabaseConfigured itself needs no heavy import (see supabaseConfig.ts),
// so this only ever runs when the backend is actually configured. One
// consequence: the Community tab and Publish button (revealed inside
// initCommunityFeature) pop in a beat after first paint rather than being
// present immediately.
if (isSupabaseConfigured) {
  const runWhenIdle: (cb: () => void) => void =
    window.requestIdleCallback ?? ((cb) => window.setTimeout(cb, 2000));
  runWhenIdle(() => {
    void Promise.all([import('./auth'), import('./community')]).then(([auth, community]) =>
      initCommunityFeature(auth, community),
    );
  });
}

// --- Mobile bottom sheet ---
// On phones the panel is a draggable sheet over a full-screen map. Dragging
// the handle snaps it between peek / half / full; tapping the handle cycles up.
(() => {
  const sheet = document.querySelector<HTMLElement>('#sidebar');
  const handle = document.querySelector<HTMLElement>('#sheet-handle');
  if (!sheet || !handle) return;
  const sheetEl = sheet;
  const handleEl = handle;
  const fab = document.querySelector<HTMLElement>('#gps-fab');
  const locateEl = document.querySelector<HTMLButtonElement>('#btn-locate');
  const distEl = document.querySelector<HTMLElement>('#stat-distance');

  const isMobile = () => window.matchMedia('(max-width: 700px)').matches;
  // Default to half (not peek): search/generate and the community list should
  // be visible without dragging first, and the map shouldn't dominate the
  // screen on load.
  let snap = 1; // 0 = peek, 1 = half, 2 = full

  // Offsets in px to translate the sheet down by, per snap level.
  function offsets(): number[] {
    const h = sheetEl.offsetHeight;
    const peekVisible = 250;
    return [Math.max(0, h - peekVisible), Math.round(h * 0.45), 0];
  }

  function currentY(): number {
    const m = /translateY\(([-\d.]+)px\)/.exec(sheetEl.style.transform);
    return m ? parseFloat(m[1]) : offsets()[snap];
  }

  function apply(index: number, animate = true): void {
    snap = Math.max(0, Math.min(2, index));
    sheetEl.style.transition = animate ? '' : 'none';
    sheetEl.style.transform = `translateY(${offsets()[snap]}px)`;
    handleEl.setAttribute('aria-expanded', String(snap > 0));
    if (fab) {
      fab.style.opacity = snap === 0 ? '1' : '0';
      fab.style.pointerEvents = snap === 0 ? 'auto' : 'none';
    }
  }

  // Clear inline styles on desktop so the sheet transform never leaks there.
  function reset(): void {
    if (isMobile()) {
      apply(snap, false);
    } else {
      sheetEl.style.transform = '';
      sheetEl.style.transition = '';
      if (fab) {
        fab.style.opacity = '';
        fab.style.pointerEvents = '';
      }
    }
  }

  let dragging = false;
  let startY = 0;
  let startOffset = 0;

  handleEl.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    dragging = true;
    startY = e.clientY;
    startOffset = currentY();
    sheetEl.style.transition = 'none';
    handleEl.setPointerCapture(e.pointerId);
  });
  handleEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = sheetEl.offsetHeight;
    const y = Math.min(Math.max(0, startOffset + (e.clientY - startY)), h - 80);
    sheetEl.style.transform = `translateY(${y}px)`;
  });
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = '';
    const y = currentY();
    // A tap (barely moved) cycles peek -> half -> full -> peek.
    if (Math.abs(y - startOffset) < 6) {
      apply(snap >= 2 ? 0 : snap + 1);
      return;
    }
    const offs = offsets();
    let best = 0;
    let bestDist = Infinity;
    offs.forEach((o, i) => {
      const d = Math.abs(o - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    apply(best);
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);

  // Keyboard: Enter/Space cycles up, arrows step between snap levels.
  handleEl.addEventListener('keydown', (e) => {
    if (!isMobile()) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      apply(snap >= 2 ? 0 : snap + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      apply(snap + 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      apply(snap - 1);
    }
  });

  // Raise to half the first time a route appears so the stats come into view.
  if (distEl) {
    const observer = new MutationObserver(() => {
      const text = distEl.textContent ?? '';
      if (isMobile() && snap === 0 && text && text !== '–') apply(1);
    });
    observer.observe(distEl, { childList: true, characterData: true, subtree: true });
  }

  if (fab && locateEl) {
    fab.addEventListener('click', () => locateEl.click());
  }

  window.addEventListener('resize', reset);
  reset();
})();

// Dev-only handle for verification in the browser console; stripped from
// the production build by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV) {
  (window as unknown as { __lr: unknown }).__lr = { map, state };
}

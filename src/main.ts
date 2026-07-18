import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchRoute, type LngLat, type RouteResult } from './routing';
import { downloadGpx } from './gpx';
import { downloadTcx } from './tcx';
import { parseTcx } from './tcximport';
import { haversineMeters, cumulativeDistances, elevationGain } from './geo';
import { renderElevationChart, clearElevationChart, renderGradeLegend } from './chart';
import { surfaceBreakdown, renderSurfaceBar, surfaceRuns, type SurfaceClass } from './surface';
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
import { isSupabaseConfigured } from './supabase';
import { sendMagicLink, signOut, onAuthChange } from './auth';
import {
  publishRoute,
  fetchCommunityRoutes,
  fetchRouteGeometries,
  rateRoute,
  fetchMyRatings,
  fileDownloadUrl,
  softDeleteRoute,
  purgeExpiredRoutes,
  GRACE_DAYS,
  type CommunityRoute,
  type CommunitySort,
} from './community';
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
};

const statDistance = document.querySelector<HTMLElement>('#stat-distance')!;
const statAscend = document.querySelector<HTMLElement>('#stat-ascend')!;
const statsSection = document.querySelector<HTMLElement>('#stats')!;
const routeEmpty = document.querySelector<HTMLElement>('#route-empty')!;
const routePills = document.querySelector<HTMLElement>('#route-pills')!;
const gradeLegendEl = document.querySelector<HTMLElement>('#grade-legend')!;
const btnShare = document.querySelector<HTMLButtonElement>('#btn-share')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
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
const chartCanvas = document.querySelector<HTMLCanvasElement>('#elevation-chart')!;
const surfaceEl = document.querySelector<HTMLElement>('#surface')!;
const routeBadge = document.querySelector<HTMLElement>('#route-badge');
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
// Mobile bottom tab bar mirrors the top tabs; both drive setActiveTab.
const bottomTabButtons = [...document.querySelectorAll<HTMLButtonElement>('#bottom-nav .bottom-tab')];
const plannerPanel = document.querySelector<HTMLElement>('#tab-planner')!;
const communityPanel = document.querySelector<HTMLElement>('#tab-community')!;
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

// Route line color, the same across every basemap (matches the UI accent).
const ROUTE_COLOR = '#2f5bff';

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
    // Keep the raster at the bottom of our overlays: below the heatmap (when
    // present) and below the route, so both always read on top of it.
    const beforeId = map.getLayer('heatmap-layer')
      ? 'heatmap-layer'
      : map.getLayer('route-casing')
        ? 'route-casing'
        : undefined;
    map.addLayer({ id: 'basemap-raster', type: 'raster', source: 'basemap-raster' }, beforeId);
  }
}

// --- Community heatmap ------------------------------------------------------
let heatmapLoaded = false;
let heatmapStale = false; // set after publishing so the next open refetches

/** Down-sample a dense routed line to ~one point per `minGapM` metres and drop
 *  elevation — compact enough to store per route and to feed the heatmap. */
function simplifyForHeatmap(
  coords: [number, number, number][],
  minGapM = 40,
): LngLat[] {
  const round = (n: number): number => Number(n.toFixed(5));
  const out: LngLat[] = [];
  let last: LngLat | null = null;
  for (const c of coords) {
    const p: LngLat = [round(c[0]), round(c[1])];
    if (!last || haversineMeters(last, p) >= minGapM) {
      out.push(p);
      last = p;
    }
  }
  const end = coords[coords.length - 1];
  if (end) {
    const p: LngLat = [round(end[0]), round(end[1])];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/** Loads every community route's geometry as heatmap points. Returns the
 *  number of routes mapped. */
async function loadHeatmapData(): Promise<number> {
  const geometries = await fetchRouteGeometries();
  const features = geometries.flatMap((geometry) =>
    geometry.map((coord) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: coord },
      properties: {},
    })),
  );
  const source = map.getSource('heatmap') as maplibregl.GeoJSONSource | undefined;
  source?.setData({ type: 'FeatureCollection', features });
  heatmapLoaded = true;
  heatmapStale = false;
  return geometries.length;
}

/** Wires the map's Heatmap toggle. Shown only when the community backend is
 *  configured, since the heatmap is built from published community routes. */
function initHeatmap(): void {
  const toggle = document.querySelector<HTMLButtonElement>('#heatmap-toggle');
  if (!toggle || !isSupabaseConfigured) return;
  toggle.hidden = false;
  toggle.addEventListener('click', async () => {
    const on = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.classList.toggle('active', on);
    if (!map.getLayer('heatmap-layer')) return;
    map.setLayoutProperty('heatmap-layer', 'visibility', on ? 'visible' : 'none');
    if (on && (!heatmapLoaded || heatmapStale)) {
      toggle.disabled = true;
      setStatus('Loading community heatmap…');
      try {
        const count = await loadHeatmapData();
        setStatus(count > 0 ? '' : 'No community routes on the heatmap yet.');
      } catch {
        setStatus('Could not load the community heatmap.', true);
      } finally {
        toggle.disabled = false;
      }
    }
  });
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
  // Surface-coloured overlay on top of the base line: paved reads as the
  // accent, cobbles amber, unpaved warm brown. Empty (falls back to the solid
  // line) when no surface data is available.
  map.addSource('route-surface', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'route-surface-line',
    type: 'line',
    source: 'route-surface',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-width': 4,
      'line-opacity': 0.98,
      'line-color': [
        'match',
        ['get', 'surface'],
        'unpaved', '#b8641e',
        'cobbles', '#d98a1e',
        'paved', ROUTE_COLOR,
        ROUTE_COLOR,
      ],
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

  // Community heatmap: density of published routes, below the route overlays.
  // Hidden until toggled on; populated on first activation (see initHeatmap).
  map.addSource('heatmap', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer(
    {
      id: 'heatmap-layer',
      type: 'heatmap',
      source: 'heatmap',
      layout: { visibility: 'none' },
      paint: {
        'heatmap-weight': 0.7,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 7, 0.7, 14, 1.5],
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 7, 6, 11, 14, 15, 26],
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.85, 15, 0.6],
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0, 'rgba(47, 91, 255, 0)',
          0.15, 'rgba(47, 91, 255, 0.55)',
          0.4, 'rgba(56, 150, 255, 0.75)',
          0.65, 'rgba(90, 200, 170, 0.85)',
          0.85, 'rgba(240, 180, 40, 0.9)',
          1, 'rgba(230, 80, 30, 0.95)',
        ],
      },
    },
    map.getLayer('route-casing') ? 'route-casing' : undefined,
  );

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

  // Map-style chooser: a popover opened from the layers tool in the stack.
  const mapstyleEl = document.querySelector<HTMLDivElement>('#mapstyle');
  const layersToggle = document.querySelector<HTMLButtonElement>('#layers-toggle');
  if (mapstyleEl && layersToggle) {
    // OpenCycleMap (the cycling layer) only works with a Thunderforest key.
    if (!THUNDERFOREST_KEY) mapstyleEl.querySelector('[data-style="cycling"]')?.remove();
    const setStyleMenuOpen = (open: boolean): void => {
      mapstyleEl.hidden = !open;
      layersToggle.setAttribute('aria-expanded', String(open));
    };
    layersToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setStyleMenuOpen(Boolean(mapstyleEl.hidden));
    });
    // A click anywhere else closes the popover.
    document.addEventListener('click', (event) => {
      if (mapstyleEl.hidden) return;
      const target = event.target as Node;
      if (!mapstyleEl.contains(target) && !layersToggle.contains(target)) {
        setStyleMenuOpen(false);
      }
    });
    mapstyleEl.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        setBasemap(btn.dataset.style ?? 'clean');
        mapstyleEl.querySelectorAll('button').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        });
        setStyleMenuOpen(false);
      });
    });
  }

  initHeatmap();

  // A shared route needs the 'route' source/layers above to already exist.
  void applySharedRoute();
});

map.on('click', (event) => {
  // Clicks on a café or water marker open its popup instead of adding a waypoint.
  const poiLayers = ['cafe-dots', 'water-dots'].filter((id) => map.getLayer(id));
  if (poiLayers.length > 0 && map.queryRenderedFeatures(event.point, { layers: poiLayers }).length > 0) {
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
  await saveRoute({
    name,
    waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
    bike: settings.bike,
    traffic: settings.traffic,
    distanceMeters: state.route.distanceMeters,
    createdAt: new Date().toISOString(),
    closed: state.closed,
  });
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
  btnRoundtrip.classList.add('is-loading');
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
    if (requestId === state.requestId) {
      btnRoundtrip.disabled = false;
      btnRoundtrip.classList.remove('is-loading');
    }
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
  arrow.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h14"/><path d="M12 6l6 6-6 6"/></svg>';
  // The arrow points east; rotate it to where the wind blows TO.
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
    // Import lives on the Community tab now; jump back to the planner so the
    // imported route is visible and editable.
    setActiveTab('planner');
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
  try {
    state.cafes = await fetchCafes(state.route.coordinates);
    renderCafes();
    setStatus(state.cafes.length === 0 ? 'No cafés found along this route.' : '');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Café search failed.', true);
  } finally {
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
  try {
    state.water = await fetchWater(state.route.coordinates);
    renderWater();
    setStatus(state.water.length === 0 ? 'No drinking water found along this route.' : '');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Water search failed.', true);
  } finally {
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

initDisclosure('#community-filters-toggle', '#community-filters-body');

// --- Light/dark theme toggle -------------------------------------------------
// The UI follows the OS by default; toggling sets an explicit, persisted
// preference on <html data-theme>. The map basemap stays light either way.
(() => {
  const toggle = document.querySelector<HTMLButtonElement>('#theme-toggle');
  if (!toggle) return;
  const THEME_KEY = 'lightmile-theme';
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const effectiveTheme = (): 'light' | 'dark' => {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced === 'light' || forced === 'dark') return forced;
    return darkQuery.matches ? 'dark' : 'light';
  };

  const sync = (): void => {
    const dark = effectiveTheme() === 'dark';
    toggle.classList.toggle('is-dark', dark);
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  };

  toggle.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: preference just won't persist */
    }
    sync();
  });

  // Reflect OS changes while the user hasn't set an explicit preference.
  darkQuery.addEventListener('change', () => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      stored = null;
    }
    if (stored !== 'light' && stored !== 'dark') sync();
  });

  sync();
})();

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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
    // The start point (1) reads green like a route origin; the rest are accent.
    el.className = index === 0 ? 'waypoint-marker start' : 'waypoint-marker';
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

  setStatus('Calculating route…');
  try {
    const route = await fetchRoute(routingWaypoints, currentProfile());
    if (requestId !== state.requestId) return; // a newer request superseded this one
    state.route = route;
    setRouteData(route.geojson);
    renderRouteDetails();
    setStatus('');
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setStatus(error instanceof Error ? error.message : 'Something went wrong.', true);
  }
  updateControls();
}

function setRouteData(data: FeatureCollection): void {
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

/**
 * Splits the route geometry into per-surface LineString runs so the line can be
 * coloured by surface (paved / cobbles / unpaved). BRouter's messages give a
 * distance + surface per way; we walk them in step with the cumulative
 * geometry distance and assign each coordinate segment a class, then merge
 * consecutive same-class segments. Any problem yields an empty collection, so
 * the solid fallback line underneath simply shows through.
 */
function buildSurfaceLine(
  coords: [number, number, number][],
  messages: string[][],
): FeatureCollection {
  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
  try {
    const runs = surfaceRuns(messages);
    if (!runs || runs.length === 0 || coords.length < 2) return empty;
    const cum = cumulativeDistances(coords);
    const runEnds: number[] = [];
    let acc = 0;
    for (const r of runs) {
      acc += r.meters;
      runEnds.push(acc);
    }
    // Class per coordinate segment (i → i+1), by its midpoint distance.
    const segClass: SurfaceClass[] = [];
    let ri = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const mid = (cum[i] + cum[i + 1]) / 2;
      while (ri < runs.length - 1 && mid > runEnds[ri]) ri++;
      segClass.push(runs[ri].cls);
    }
    // Merge consecutive same-class segments into LineStrings (sharing the
    // boundary vertex so there is no visual gap between runs).
    const features: FeatureCollection['features'] = [];
    let start = 0;
    for (let i = 1; i <= segClass.length; i++) {
      if (i === segClass.length || segClass[i] !== segClass[start]) {
        features.push({
          type: 'Feature',
          properties: { surface: segClass[start] },
          geometry: {
            type: 'LineString',
            coordinates: coords.slice(start, i + 1).map((c) => [c[0], c[1]]),
          },
        });
        start = i;
      }
    }
    return { type: 'FeatureCollection', features };
  } catch {
    return empty;
  }
}

/** On-map chip summarising the route's paved vs unpaved split (Strava-style). */
function updateRouteBadge(totals: ReturnType<typeof surfaceBreakdown>): void {
  if (!routeBadge) return;
  const known = totals ? totals.totalMeters - totals.unknown : 0;
  if (!totals || known < totals.totalMeters * 0.4) {
    routeBadge.hidden = true;
    return;
  }
  const pavedPct = Math.round((totals.paved / known) * 100);
  const offPct = 100 - pavedPct;
  routeBadge.textContent = pavedPct >= offPct ? `${pavedPct}% paved` : `${offPct}% unpaved`;
  routeBadge.hidden = false;
}

/** Updates the surface-coloured overlay for the current route (or clears it). */
function setSurfaceLine(): void {
  const source = map.getSource('route-surface') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData(
    state.route ? buildSurfaceLine(state.route.coordinates, state.route.messages) : { type: 'FeatureCollection', features: [] },
  );
}

/** Renders stats, elevation chart, surface bar and climbs for the current route (or clears them). */
function renderRouteDetails(): void {
  // Any route change invalidates café results found for the previous route.
  clearCafes();
  clearWater();
  cafesEl.hidden = !state.route;
  waterEl.hidden = !state.route;
  const statsWereHidden = statsSection.hidden;
  statsSection.hidden = !state.route;
  routeEmpty.hidden = !!state.route;
  setSurfaceLine();

  if (state.route) {
    const km = state.route.distanceMeters / 1000;
    const ascend = Math.round(state.route.ascendMeters);
    // Count the numbers up the first time a route appears; snap on later
    // re-routes (e.g. while dragging) so it doesn't flicker.
    if (statsWereHidden) {
      animateStat(statDistance, km, 'km', 1);
      animateStat(statAscend, ascend, 'm', 0);
    } else {
      setStatValue(statDistance, km, 'km', 1);
      setStatValue(statAscend, ascend, 'm', 0);
    }

    state.climbs = detectClimbs(state.route.coordinates);
    state.selectedClimb = -1;
    setClimbHighlight(null);
    renderClimbsList();

    chartWrap.hidden = false;
    gradeLegendEl.hidden = false;
    renderElevationChart(chartCanvas, state.route.coordinates, (index) => {
      const [lng, lat] = state.route!.coordinates[index];
      hoverMarker.setLngLat([lng, lat]);
      if (!hoverMarkerVisible) {
        hoverMarker.addTo(map);
        hoverMarkerVisible = true;
      }
    });

    const totals = state.route.surface ?? surfaceBreakdown(state.route.messages);
    if (totals) {
      surfaceEl.hidden = false;
      renderSurfaceBar(surfaceEl, totals);
    } else {
      surfaceEl.hidden = true;
    }
    updateRouteBadge(totals);
  } else {
    updateRouteBadge(null);
    statDistance.textContent = '–';
    statAscend.textContent = '–';
    chartWrap.hidden = true;
    gradeLegendEl.hidden = true;
    surfaceEl.hidden = true;
    climbsEl.hidden = true;
    state.climbs = [];
    state.selectedClimb = -1;
    setClimbHighlight(null);
    clearElevationChart();
    if (hoverMarkerVisible) {
      hoverMarker.remove();
      hoverMarkerVisible = false;
    }
  }
  renderRoutePills();
}

/** Consistent outline icons for the at-a-glance summary pills. */
const PILL_ICONS = {
  climb:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18L13.5 6l-3.5 6-2-3z"/></svg>',
  cafe:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M6 3v2M10 3v2"/></svg>',
  water:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3s6 6.2 6 10.2A6 6 0 0 1 6 13.2C6 9.2 12 3 12 3z"/></svg>',
};

/** Compact at-a-glance pills summarizing climbs and coffee stops. */
function renderRoutePills(): void {
  const pills: string[] = [];
  if (state.climbs.length > 0) {
    const n = state.climbs.length;
    const gain = Math.round(state.climbs.reduce((sum, c) => sum + c.gainM, 0));
    pills.push(
      `<span class="pill climb">${PILL_ICONS.climb} ${n} climb${n > 1 ? 's' : ''} · +${gain} m</span>`,
    );
  }
  if (state.cafes.length > 0) {
    const n = state.cafes.length;
    pills.push(
      `<span class="pill cafe">${PILL_ICONS.cafe} ${n} coffee stop${n > 1 ? 's' : ''}</span>`,
    );
  }
  if (state.water.length > 0) {
    const n = state.water.length;
    pills.push(`<span class="pill water">${PILL_ICONS.water} ${n} water</span>`);
  }
  routePills.innerHTML = pills.join('');
  routePills.hidden = pills.length === 0;
}

/** Lists detected climbs; clicking one highlights it on the map and zooms to it. */
/** Writes a stat value with its small unit label. */
function setStatValue(el: HTMLElement, value: number, unit: string, decimals: number): void {
  el.innerHTML = `${value.toFixed(decimals)}<span class="unit">${unit}</span>`;
}

/** Counts a stat up from zero (easeOutCubic); snaps instantly under reduced motion. */
function animateStat(el: HTMLElement, target: number, unit: string, decimals: number): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setStatValue(el, target, unit, decimals);
    return;
  }
  const duration = 550;
  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    setStatValue(el, target * eased, unit, decimals);
    if (t < 1) requestAnimationFrame(step);
    else setStatValue(el, target, unit, decimals);
  };
  requestAnimationFrame(step);
}

/** Steepness → chip colour, mild green through to hard red (Strava-like). */
function climbGradeColor(pct: number): string {
  if (pct >= 10) return '#c0392b';
  if (pct >= 7) return '#e0621a';
  if (pct >= 4.5) return '#d98a1e';
  return '#4a9e5b';
}

function renderClimbsList(): void {
  climbsEl.hidden = state.climbs.length === 0;
  climbsList.innerHTML = '';
  state.climbs.forEach((climb, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'climb-item';
    button.innerHTML =
      `<span class="climb-grade" style="background:${climbGradeColor(climb.avgPct)}">${climb.avgPct.toFixed(1)}%</span>` +
      `<span class="climb-info"><span class="climb-where">km ${climb.startKm.toFixed(1)}</span>` +
      `<span class="climb-len">${(climb.lengthM / 1000).toFixed(1)} km climb</span></span>` +
      `<span class="climb-gain">+${Math.round(climb.gainM)} m</span>`;
    button.title = `Average ${climb.avgPct.toFixed(1)}%, steepest 100 m ${climb.maxPct.toFixed(0)}%`;
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
    item.className = 'saved-item';

    const preview = buildRoutePreviewSvg(route.waypoints, route.closed ?? false);
    preview.classList.add('saved-preview');

    const label = document.createElement('button');
    label.className = 'saved-name';
    label.title = 'Load this route';
    const bikeLabel =
      route.bike === 'mtb' ? 'MTB' : route.bike.charAt(0).toUpperCase() + route.bike.slice(1);
    label.innerHTML =
      `<span class="saved-title">${escapeHtml(route.name)}</span>` +
      `<span class="saved-meta">${(route.distanceMeters / 1000).toFixed(1)} km · ${bikeLabel}</span>`;
    label.addEventListener('click', () => loadSaved(route));

    const remove = document.createElement('button');
    remove.className = 'saved-delete';
    remove.textContent = '✕';
    remove.title = 'Delete';
    remove.addEventListener('click', async () => {
      await deleteRoute(route.id!);
      await refreshSavedList();
    });

    item.append(preview, label, remove);
    savedList.append(item);
  }
}

function loadSaved(route: SavedRoute): void {
  state.waypoints = route.waypoints.map((wp) => [...wp] as LngLat);
  state.closed = route.closed ?? false;
  settings.bike = (['race', 'gravel', 'mtb'].includes(route.bike) ? route.bike : 'race') as BikeType;
  settings.traffic = [0, 1, 2].includes(route.traffic) ? route.traffic : 0;
  persistSettings();
  syncProfileUi();
  rebuildMarkers();
  void recalculateRoute();

  const bounds = state.waypoints.reduce(
    (acc, wp) => acc.extend(wp),
    new maplibregl.LngLatBounds(state.waypoints[0], state.waypoints[0]),
  );
  map.fitBounds(bounds, { padding: 60 });
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateControls(): void {
  btnUndo.disabled = state.waypoints.length === 0 && !state.closed;
  btnClear.disabled = state.waypoints.length === 0;
  btnReverse.disabled = !state.route;
  btnExport.disabled = !state.route;
  btnExportTcx.disabled = !state.route;
  btnSave.disabled = !state.route || state.waypoints.length < 2;
  btnShare.disabled = !state.route || state.waypoints.length < 2;
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

/** Switches between the Route planner and Community tabs. */
function setActiveTab(name: 'planner' | 'community'): void {
  [...mainTabButtons, ...bottomTabButtons].forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  plannerPanel.hidden = name !== 'planner';
  communityPanel.hidden = name !== 'community';
  if (name === 'community') void refreshCommunity();
}

if (isSupabaseConfigured) {
  mainTabs.hidden = false;
  btnPublish.hidden = false;
  // Reveals the mobile bottom tab bar and docks the sheet above it (see CSS).
  document.body.classList.add('has-community');

  [...mainTabButtons, ...bottomTabButtons].forEach((btn) => {
    btn.addEventListener('click', () =>
      setActiveTab(btn.dataset.tab === 'community' ? 'community' : 'planner'),
    );
  });

  onAuthChange((user) => {
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
      void purgeExpiredRoutes();
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
      await sendMagicLink(email);
      setStatus(`Sign-in link sent to ${email}. Open it on this device to finish.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not send the sign-in link.', true);
    } finally {
      btnSignin.disabled = false;
    }
  });

  btnSignout.addEventListener('click', async () => {
    await signOut();
    setStatus('Signed out.');
  });

  btnPublish.addEventListener('click', async () => {
    if (!state.route || state.waypoints.length < 2 || !currentUser) return;
    const name =
      routeNameInput.value.trim() || `Route ${new Date().toISOString().slice(0, 10)}`;
    btnPublish.disabled = true;
    setStatus('Publishing…');
    try {
      await publishRoute({
        name,
        authorName: authorNameInput.value.trim() || null,
        waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
        bike: settings.bike,
        traffic: settings.traffic,
        closed: state.closed,
        distanceMeters: state.route.distanceMeters,
        ascendMeters: state.route.ascendMeters,
        source: state.importedFileText ? 'imported' : 'planned',
        geometry: simplifyForHeatmap(state.route.coordinates),
        originalFileText: state.importedFileText,
        originalFileFormat: state.importedFileFormat,
      });
      heatmapStale = true; // a new route should appear next time the heatmap opens
      setStatus(`Published "${name}" to the community library.`);
      await refreshCommunity();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not publish this route.', true);
    } finally {
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
  // Show skeletons on the first load (empty list) so the panel doesn't flash blank.
  if (communityList.childElementCount === 0) renderCommunitySkeletons();
  try {
    // 'near' has no server ordering; fetch newest and sort by distance client-side.
    const serverSort: CommunitySort = communitySort === 'near' ? 'newest' : communitySort;
    const [routes, myRatings] = await Promise.all([
      fetchCommunityRoutes(serverSort),
      fetchMyRatings(),
    ]);
    communityRoutes = routes;
    communityRatings = myRatings;
    renderCommunityList(filteredCommunityRoutes(), communityRatings);
  } catch (error) {
    // Non-fatal: the planner keeps working even if the library can't load.
    console.warn('Could not load community routes:', error);
  }
}

/** Placeholder shimmer rows shown while the community library loads. */
function renderCommunitySkeletons(count = 3): void {
  communityList.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const li = document.createElement('li');
    li.className = 'community-item skeleton';
    li.innerHTML =
      '<div class="sk sk-thumb"></div>' +
      '<div class="community-body">' +
      '<div class="sk sk-line sk-line-lg"></div>' +
      '<div class="sk sk-line"></div>' +
      '<div class="sk sk-line sk-line-sm"></div>' +
      '</div>';
    communityList.append(li);
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
    const bikeLabel =
      route.bike === 'mtb' ? 'MTB' : route.bike.charAt(0).toUpperCase() + route.bike.slice(1);
    meta.textContent =
      `${(route.distanceMeters / 1000).toFixed(1)} km · +${Math.round(route.ascendMeters)} m · ${bikeLabel}`;
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
      const url = fileDownloadUrl(route.gpxPath);
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
          await rateRoute(route.id, n);
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
  if (state.route) setStatus(`Loaded "${route.name}".`);
}

/** Soft-deletes the owner's own community route after a confirmation. */
async function deleteCommunityRoute(route: CommunityRoute): Promise<void> {
  const confirmed = window.confirm(
    `Delete "${route.name}" from the community? It disappears from the library right away, ` +
      `and is kept recoverable for ${GRACE_DAYS} days before it is removed for good.`,
  );
  if (!confirmed) return;
  try {
    await softDeleteRoute(route.id);
    setStatus(`Deleted "${route.name}". Recoverable for ${GRACE_DAYS} days.`);
    await refreshCommunity();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not delete this route.', true);
  }
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
  // Peek shows the handle + top of the panel; half ~48% of the viewport;
  // full is the whole 92vh sheet.
  function offsets(): number[] {
    const h = sheetEl.offsetHeight;
    const peekVisible = 112;
    return [Math.max(0, h - peekVisible), Math.round(h * 0.48), 0];
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
  }

  // Clear inline styles on desktop so the sheet transform never leaks there.
  function reset(): void {
    if (isMobile()) {
      apply(snap, false);
    } else {
      sheetEl.style.transform = '';
      sheetEl.style.transition = '';
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

import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchRoute, RouteCancelledError, type LngLat } from './routing';
import { downloadGpx } from './gpx';
import { downloadTcx } from './tcx';
import { parseTcx } from './tcximport';
import { haversineMeters, cumulativeDistances, elevationGain } from './geo';
// ./chart pulls in chart.js/auto and is only needed once a route exists, so it
// is dynamically imported (see loadChartModule) and never statically. Type-only
// imports are erased at build time and do not affect that.
// Kept out of chart.ts so the static grade swatches do not depend on Chart.js.
import { renderGradeLegend } from './gradelegend';
import { escapeHtml, initDisclosure, setBusy, setStatus } from './ui';
import { initDualRange } from './dualRange';
import { initBottomSheet } from './bottomSheet';
import {
  currentProfile, persistSettings, settings, syncProfileUi,
  type BikeType, type HillPreference,
} from './settings';
import { state } from './state';
import { sanitizeWaypoints } from './waypoints';
import { surfaceBreakdown, renderSurfaceBar, surfaceRuns, type SurfaceClass } from './surface';
import { saveRoute, listRoutes, deleteRoute, type SavedRoute } from './storage';
import type { LoopOption } from './ors';
import { rejectionText } from './loopText';
import { generateRoundTripsAsync } from './roundtripClient';
import { detectClimbs, type Climb } from './climbs';
import { compassLabel, type WindInfo } from './wind';
import { searchPlaces, type GeocodeResult } from './geocode';
import { buildRoutePreviewSvg } from './preview';
import { fetchCafes, type Cafe } from './cafes';
import { fetchWater, type WaterPoint } from './water';
import { buildShareUrl, parseShareUrl } from './share';
import { parseGpx, isClosedTrack } from './gpximport';
import {
  bikeButtons,
  btnCafes, btnClear, btnExport, btnExportTcx, btnImportGpx,
  btnLocate, btnReverse, btnRoundtrip, btnSave, btnShare,
  btnUndo, btnWater, cafeKmInput, cafesEl, cafesList, chartCanvas,
  chartWrap, climbsEl, climbsList, gpxFileInput, gradeLegendEl, hillsButtons,
  loopOptionsEl, rangeTrack, rangeValue, roundtripMax,
  roundtripMin, routeEmpty, routeNameInput, routePills, savedList, searchInput, searchResults,
  statAscend, statDistance, statsSection, surfaceEl, trafficSelect,
  waterEl, waterList, windChipEl,
} from './dom';
// ./auth and ./community both pull in @supabase/supabase-js. They are loaded on
// demand via loadBackend() (see backend.ts) so the client stays out of the
// initial bundle; the planner works without a backend at all. isSupabaseConfigured
// comes from supabaseConfig.ts specifically so it can be checked eagerly without
// triggering that load.
import { isSupabaseConfigured } from './supabaseConfig';
import { loadBackend } from './backend';
import { initCommunityUi, setActiveTab, updatePublishButton } from './communityUi';
import { registerSW } from 'virtual:pwa-register';

// The default injected registration only activates a new service worker in
// the background; an already-open tab (or a phone's installed PWA, reopened
// from its home-screen icon rather than truly relaunched) keeps running the
// OLD cached JS/CSS until it happens to be fully reloaded. Reload once here
// as soon as an update is detected, so a fresh deploy actually shows up.
registerSW({ immediate: true, onNeedRefresh: () => window.location.reload() });



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

// The "cycling" basemap is OpenCycleMap (Thunderforest), which needs an API
// key. When no key is baked into the bundle (the Cloudflare build) the tiles
// go through the same-origin Worker proxy, which adds the key server-side;
// GitHub Pages / local dev bake a key and fetch tiles directly. The button is
// removed when neither is available (see the load handler). The PROD guard
// keeps local dev without a key from showing a broken OpenCycleMap option.
const THUNDERFOREST_KEY: string = import.meta.env.VITE_THUNDERFOREST_KEY ?? '';
const USE_PROXY =
  import.meta.env.VITE_USE_PROXY === '1' || (import.meta.env.PROD && !THUNDERFOREST_KEY);
const CYCLING_AVAILABLE = USE_PROXY || Boolean(THUNDERFOREST_KEY);
if (CYCLING_AVAILABLE) {
  RASTER_BASEMAPS.cycling = {
    tiles: USE_PROXY
      ? ['/api/tiles/thunderforest/cycle/{z}/{x}/{y}.png']
      : ['a', 'b', 'c'].map(
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
  const { community } = await loadBackend();
  const geometries = await community.fetchRouteGeometries();
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
    // OpenCycleMap (the cycling layer) needs a Thunderforest key or the proxy.
    if (!CYCLING_AVAILABLE) mapstyleEl.querySelector('[data-style="cycling"]')?.remove();
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
  // Clicks on a café/water marker are handled by their own layer-click
  // listeners above, not by the branches below.
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
  setStatus('Planning loops…');
  btnRoundtrip.disabled = true;
  btnRoundtrip.classList.add('is-loading');
  setBusy(true);
  try {
    const result = await generateRoundTripsAsync({
      start: state.waypoints[0],
      minMeters: minKm * 1000,
      maxMeters: maxKm * 1000,
      bike: settings.bike,
      hills: settings.hills,
      onProgress: (done, total, phase) => {
        // A superseded run must not narrate over the current one.
        if (requestId !== state.requestId) return;
        setStatus(done > 0 && done < total ? `${phase}… ${done} of ${total}` : `${phase}…`);
      },
    });
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
    btnRoundtrip.classList.remove('is-loading');
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
      state.lastKnownLocation = [position.coords.longitude, position.coords.latitude];
      addWaypoint(state.lastKnownLocation, 'your location');
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

initDualRange({
  min: roundtripMin,
  max: roundtripMax,
  label: rangeValue,
  track: rangeTrack,
  format: (min, max) => `${min} – ${max}`,
});

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

  // Cancel whatever was in flight. Without this, dragging a point repeatedly
  // leaves every earlier request running, and the public BRouter server queues
  // the newest one (the only one anybody wants) behind all of them.
  routeAbort?.abort();
  const abort = new AbortController();
  routeAbort = abort;

  setStatus('Calculating route…');
  setBusy(true);
  try {
    const route = await fetchRoute(routingWaypoints, currentProfile(), abort.signal);
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

/** Updates the surface-coloured overlay for the current route (or clears it). */
function setSurfaceLine(): void {
  const source = map.getSource('route-surface') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  source.setData(
    state.route ? buildSurfaceLine(state.route.coordinates, state.route.messages) : { type: 'FeatureCollection', features: [] },
  );
}

/** Renders stats, elevation chart, surface bar and climbs for the current route (or clears them). */
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
    void loadChartModule().then(({ renderElevationChart }) => {
      // The route may have changed again while the chart module was loading,
      // so read state.route fresh here rather than capturing it earlier.
      if (!state.route) return;
      renderElevationChart(chartCanvas, state.route.coordinates, (index) => {
        const coord = state.route?.coordinates[index];
        if (!coord) return; // chart still holds indices from a previous route
        hoverMarker.setLngLat([coord[0], coord[1]]);
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

    item.append(preview, label, remove);
    savedList.append(item);
  }
}

async function loadSaved(route: SavedRoute): Promise<void> {
  // Records written by an older version, or a partially-written one, must not
  // reach maplibre as NaN coordinates.
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
// The whole Community tab lives in communityUi.ts; it is handed the few planner-
// core hooks it needs here. updatePublishButton and setActiveTab are imported
// from there because the planner core also calls them (updateControls and the
// GPX-import handler).
initCommunityUi({
  map,
  recalculateRoute,
  rebuildMarkers,
  routeChangeNote,
  simplifyForHeatmap,
  markHeatmapStale: () => {
    heatmapStale = true;
  },
});

// --- Mobile bottom sheet ---
initBottomSheet();

// Dev-only handle for verification in the browser console; stripped from
// the production build by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV) {
  (window as unknown as { __lr: unknown }).__lr = { map, state };
}

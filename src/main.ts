import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
// Self-hosted so the fonts are part of the build and get precached with
// everything else (see vite.config.ts's workbox comment on why offline
// matters here); weights match exactly what style.css actually uses.
import '@fontsource/archivo/400.css';
import '@fontsource/archivo/500.css';
import '@fontsource/archivo/600.css';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/archivo/900.css';
import '@fontsource/archivo/900-italic.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './style.css';
import { fetchRoute, RouteCancelledError, type LngLat } from './routing';
import { downloadGpx } from './gpx';
import { downloadTcx } from './tcx';
import { parseTcx } from './tcximport';
import { haversineMeters, cumulativeDistances, elevationGain } from './geo';
// ./chart pulls in chart.js/auto and is only needed once a route exists, so it
// is dynamically imported (see loadChartModule) and never statically. Type-only
// imports are erased at build time and do not affect that.
import { escapeHtml, setActiveInGroup, setBusy, setStatus } from './ui';
import { initDualRange } from './dualRange';
import { initBottomSheet } from './bottomSheet';
import {
  currentProfile, persistSettings, settings, syncProfileUi,
  type BikeType, type HillPreference,
} from './settings';
import { state } from './state';
import { sanitizeWaypoints } from './waypoints';
import { surfaceBreakdown, surfaceRuns, type SurfaceClass } from './surface';
import { saveRoute, listRoutes, deleteRoute, type SavedRoute } from './storage';
import type { LoopOption } from './ors';
import { rejectionText } from './loopText';
import { generateRoundTripsAsync, RoundTripCancelledError } from './roundtripClient';
import { initPlannerScreens, setPlannerScreen, getPlannerScreen } from './plannerScreen';
import { detectClimbs, type Climb } from './climbs';
import { compassLabel, type WindInfo } from './wind';
import { searchPlaces, reverseCity, type GeocodeResult } from './geocode';
import { buildRoutePreviewSvg } from './preview';
import { fetchCafes, type Cafe } from './cafes';
import { fetchWater, type WaterPoint } from './water';
import { estimateMovingTimeHours } from './rideTime';
import { renderCandidateCards, renderCandidateDots, type CandidateCardData } from './candidateCards';
import { initLibrarySegment, renderSavedList } from './librarySheet';
import { initDialogSheet } from './dialogSheet';
import { setApplyButtonCount, resetFilterControls } from './sortFilterSheet';
import { wireAltFormatButton, openSaveExportSheet } from './saveExportSheet';
import {
  initPlanRows, renderPlanRows, showPlanSettingPane, type PlanRowState,
} from './planRows';
import {
  renderRouteDetailFullscreen, renderRouteDetailPanel, clearRouteDetail,
  type RouteDetailData, type RouteDetailCallbacks,
} from './routeDetailView';
import { buildShareUrl, parseShareUrl } from './share';
import { parseGpx, isClosedTrack } from './gpximport';
import {
  DEFAULT_SIGNIN_HINT, accountAvatar, accountCode, accountEmail, accountName, accountSignedIn,
  accountSignedOut, authorField, authorNameInput, bikeButtons, bottomTabButtons,
  btnApplyFilters, btnBookmarkLoop, btnBuildDone, btnCancelGenerate, btnCandidatesBack, btnClear,
  btnCloseLoop, btnExport,
  btnExportTcx, btnImportGpx,
  btnLocate, btnOpenFilters, btnOpenSaveExport, btnPlanSettingDone, btnPublish, btnResetFilters,
  btnReverse, btnRoundtrip,
  btnSave, btnShare, btnSignin, btnSigninBack,
  btnSignout, btnUndo, btnUseLoop, btnVerify, buildAscend, buildDistance,
  buildActionsEl, buildPoints, btnChangeCandidates, candidateDotsEl, candidatesHeadingEl,
  candidatesHeadingText, controlsEl,
  codeRow, communityBikeButtons, communityDiscoverEl, communityDistMax,
  communityDistMin, communityDistTrack, communityDistValue, communityHillsButtons, communityLibraryEl,
  communityList, communityPanel, communitySegmentEl, communitySortButtons, emailRow, gpxFileInput,
  hillsButtons, libraryTabButtons,
  loopOptionsEl, mainTabButtons, mainTabs, plannerPanel, publishedList, rangeTrack, rangeValue,
  planSettingBackdrop, planSettingSheetEl,
  roundtripMax, roundtripMin, routeDetailMobile, routeDetailPanel, routeNameInput, saveExportBackdrop,
  saveExportSheetEl, savedList,
  screenBuild, screenCandidates, screenGenerating, screenPlan, searchInput,
  searchResults, signinHint, sortFilterBackdrop, sortFilterSheetEl, trafficSelect, windChipEl,
} from './dom';
// ./auth and ./community both pull in @supabase/supabase-js. They are loaded on
// demand via loadBackend() so the client stays out of the initial bundle; the
// planner works without a backend at all. isSupabaseConfigured comes from
// supabaseConfig.ts specifically so it can be checked eagerly without
// triggering that load. Type-only imports below are erased at build time.
import { isSupabaseConfigured } from './supabaseConfig';
import type { CommunityRoute, CommunitySort } from './community';

type AuthModule = typeof import('./auth');
type CommunityModule = typeof import('./community');

/** Resolved backend modules once loaded, for the few synchronous call sites. */
let backend: { auth: AuthModule; community: CommunityModule } | null = null;
let backendPromise: Promise<{ auth: AuthModule; community: CommunityModule }> | null = null;

function loadBackend(): Promise<{ auth: AuthModule; community: CommunityModule }> {
  if (!backendPromise) {
    backendPromise = Promise.all([import('./auth'), import('./community')]).then(
      ([auth, community]) => {
        backend = { auth, community };
        return backend;
      },
    );
  }
  return backendPromise;
}
import type { User } from '@supabase/supabase-js';
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

/** Place name for waypoint 1, plus the point it describes so a moved start
 *  invalidates it. Declared up here rather than beside syncPlanRows() so the
 *  early map-load path can refresh the rows without hitting a TDZ error. */
let startPlaceLabel: string | null = null;
let startPlaceFor: string | null = null;

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
  // Starting to place points by hand from the Plan screen enters the
  // dedicated Build screen (mobile only; harmless no-op on desktop, which
  // ignores plannerScreen and always shows #controls).
  if (getPlannerScreen() === 'plan' && state.waypoints.length === 0) {
    setPlannerScreen('build');
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

btnCloseLoop.addEventListener('click', () => {
  void closeLoop();
});

btnBuildDone.addEventListener('click', () => {
  if (!state.route) return;
  setPlannerScreen('detail');
});

btnCandidatesBack.addEventListener('click', () => {
  setPlannerScreen('plan');
});

btnChangeCandidates.addEventListener('click', () => {
  setPlannerScreen('plan');
});

btnUseLoop.addEventListener('click', () => {
  if (state.selectedLoop < 0) return;
  setPlannerScreen('detail');
});

btnBookmarkLoop.addEventListener('click', () => openSaveExportSheet(saveExportDialog, routeNameInput));

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
  saveExportDialog.close();
});

/** Aborts the in-flight round-trip generation; null once it settles. */
let generateAbort: AbortController | null = null;

btnCancelGenerate.addEventListener('click', () => {
  generateAbort?.abort();
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
  setPlannerScreen('generating');
  const abort = new AbortController();
  generateAbort = abort;
  try {
    const result = await generateRoundTripsAsync({
      start: state.waypoints[0],
      minMeters: minKm * 1000,
      maxMeters: maxKm * 1000,
      bike: settings.bike,
      hills: settings.hills,
      signal: abort.signal,
      onProgress: (done, total, phase) => {
        // A superseded run must not narrate over the current one.
        if (requestId !== state.requestId) return;
        setGeneratingProgress(done, total);
        setStatus(done > 0 && done < total ? `${phase}… ${done} of ${total}` : `${phase}…`);
      },
    });
    if (requestId !== state.requestId) return;

    renderWindChip(result.wind);
    if (result.options.length > 0) {
      state.loopOptions = result.options;
      state.selectedLoop = -1;
      candidatesHeadingPlace = null;
      selectLoop(0);
      setPlannerScreen('candidates');
      const startedFrom = state.waypoints[0];
      void reverseCity(startedFrom).then((place) => {
        if (state.waypoints[0] !== startedFrom || !place) return;
        candidatesHeadingPlace = place;
        renderCandidatesHeadingText();
      });
      setStatus(
        result.options.length > 1
          ? 'Pick a loop below, or Find loops again for new ones.'
          : 'One good loop found. Find loops again for new ones.',
      );
    } else {
      state.loopOptions = [];
      state.route = null;
      setRouteData({ type: 'FeatureCollection', features: [] });
      renderRouteDetails();
      renderNoLoopFound(result.failReason, result.fallback);
      setPlannerScreen('plan');
    }
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.loopOptions = [];
    renderLoopOptions();
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderRouteDetails();
    setPlannerScreen('plan');
    if (!(error instanceof RoundTripCancelledError)) {
      setStatus(error instanceof Error ? error.message : 'Something went wrong.', true);
    }
  } finally {
    // Unconditionally: state.requestId is shared with recalculateRoute(), so
    // any map interaction during generation would bump it and leave the button
    // disabled forever. The stale-result guards above already prevent a
    // superseded run from writing state.
    btnRoundtrip.disabled = false;
    btnRoundtrip.classList.remove('is-loading');
    setBusy(false);
    generateAbort = null;
  }
  updateControls();
});

/** Downsamples a coordinate list for the cards' mini route-shape icon (preview.ts). */
function iconWaypoints(coordinates: [number, number, number][]): [number, number][] {
  const stride = Math.max(1, Math.ceil(coordinates.length / 150));
  const out: [number, number][] = [];
  for (let i = 0; i < coordinates.length; i += stride) out.push([coordinates[i][0], coordinates[i][1]]);
  return out;
}

function loopOptionToCardData(option: LoopOption): CandidateCardData {
  const km = option.route.distanceMeters / 1000;
  const ascend = option.route.ascendMeters;
  return {
    title: `Loop ${state.loopOptions.indexOf(option) + 1}`,
    distanceKm: km,
    ascendM: ascend,
    timeHours: estimateMovingTimeHours(km, ascend, settings.bike),
    closed: true,
    waypoints: iconWaypoints(option.route.coordinates),
    coordinates: option.route.coordinates,
    surfaceTotals: option.route.surface ?? surfaceBreakdown(option.route.messages),
    climbCount: detectClimbs(option.route.coordinates).length,
  };
}

/** How many still-generating slots to show as skeleton cards (see setGeneratingProgress). */
let generatingSkeletonCount = 0;

/** Sizes the Generating screen's skeleton row from the real progress total. */
function setGeneratingProgress(_done: number, total: number): void {
  generatingSkeletonCount = Math.max(0, total);
  renderLoopOptions();
}

/**
 * Renders #loop-options: shared by the Generating screen (skeletons only, no
 * real cards yet — results arrive as one batch, staggered in visually, not
 * streamed one by one; see the redesign plan) and the Candidates screen
 * (real cards). Hidden outside both screens; always shown on desktop
 * whenever there are options, exactly like before this redesign.
 */
function renderLoopOptions(): void {
  const screen = getPlannerScreen();
  const showing = screen === 'generating' || screen === 'candidates';
  loopOptionsEl.hidden = !showing || (screen === 'candidates' && state.loopOptions.length === 0);
  if (screen === 'generating') {
    renderCandidateCards(loopOptionsEl, [], -1, () => {}, generatingSkeletonCount);
  } else {
    renderCandidateCards(
      loopOptionsEl,
      state.loopOptions.map(loopOptionToCardData),
      state.selectedLoop,
      selectLoop,
    );
  }
  renderCandidateDots(candidateDotsEl, state.loopOptions.length, state.selectedLoop);
  candidatesHeadingEl.hidden = screen !== 'candidates' || state.loopOptions.length === 0;
  if (!candidatesHeadingEl.hidden) renderCandidatesHeadingText();
}

/** "N loops from <place>": place resolves async and is cached per generation. */
let candidatesHeadingPlace: string | null = null;
function renderCandidatesHeadingText(): void {
  const n = state.loopOptions.length;
  const base = `${n} loop${n === 1 ? '' : 's'}`;
  candidatesHeadingText.textContent = candidatesHeadingPlace
    ? `${base} from ${candidatesHeadingPlace}`
    : base;
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
  // Rebuilds the cards so the newly-selected one expands with its elevation
  // bars, surface bar and caption (not just a class toggle: a compact card's
  // DOM genuinely differs from its expanded form).
  renderLoopOptions();

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
      // Picking a place is the whole point of the Start pane, so get out of the
      // way and let the map show where it landed.
      planSettingDialog.close();
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
  // Keeps the Plan screen's Distance row in step while the sheet is open.
  onInput: () => syncPlanRows(),
});

// --- Points of interest along the route (cafés, drinking water) -------------
// Fetched automatically whenever a route appears rather than button-gated:
// the route detail view's Stops tab is the only place these are listed, and
// its hero pills need real counts as soon as they can have them. Both are a
// nice-to-have, so a failure here is silent rather than an error banner.

/** Route a POI fetch is in flight (or done) for, so a route doesn't get fetched twice. */
let poisFetchedForRoute: typeof state.route = null;

function fetchPoisIfNeeded(): void {
  if (!state.route || poisFetchedForRoute === state.route) return;
  const searchedRoute = state.route;
  poisFetchedForRoute = searchedRoute;
  void Promise.all([fetchCafes(searchedRoute.coordinates), fetchWater(searchedRoute.coordinates)])
    .then(([cafes, water]) => {
      if (state.route !== searchedRoute) return;
      state.cafes = cafes;
      state.water = water;
      setCafeData(cafes);
      setWaterData(water);
      renderRouteDetails();
    })
    .catch(() => {
      // Leave state.cafes/water empty; the hero pills and Stops tab just stay empty too.
    });
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
  setCafeData([]);
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
  setWaterData([]);
}

const sortFilterDialog = initDialogSheet(sortFilterSheetEl, sortFilterBackdrop);
btnOpenFilters.addEventListener('click', () => {
  setApplyButtonCount(btnApplyFilters, filteredCommunityRoutes().length);
  sortFilterDialog.open();
});
btnApplyFilters.addEventListener('click', () => sortFilterDialog.close());
btnResetFilters.addEventListener('click', () => {
  resetFilterControls(
    communitySortButtons[0],
    communityBikeButtons[0],
    communityHillsButtons[0],
    communityDistMin,
    communityDistMax,
  );
});

const planSettingDialog = initDialogSheet(planSettingSheetEl, planSettingBackdrop);
initPlanRows((pane) => {
  showPlanSettingPane(pane);
  planSettingDialog.open();
  if (pane === 'start') searchInput.focus();
});
btnPlanSettingDone.addEventListener('click', () => {
  planSettingDialog.close();
  syncPlanRows();
});

function planRowState(): PlanRowState {
  return {
    startPlace: startPlaceLabel,
    hasStart: state.waypoints.length > 0,
    distanceMinKm: Number(roundtripMin.value),
    distanceMaxKm: Number(roundtripMax.value),
    bike: settings.bike,
    hills: settings.hills,
    traffic: settings.traffic,
  };
}

/** Refreshes the Plan row summaries, resolving the start's place name if it moved. */
function syncPlanRows(): void {
  const start = state.waypoints[0];
  const key = start ? `${start[0].toFixed(4)},${start[1].toFixed(4)}` : null;
  if (key !== startPlaceFor) {
    startPlaceFor = key;
    startPlaceLabel = null;
    if (start) {
      void reverseCity(start)
        .then((place) => {
          if (startPlaceFor !== key) return; // start moved while this was in flight
          startPlaceLabel = place;
          renderPlanRows(planRowState());
        })
        .catch(() => {
          // No place name is fine; the row falls back to "On the map".
        });
    }
  }
  renderPlanRows(planRowState());
}

const saveExportDialog = initDialogSheet(saveExportSheetEl, saveExportBackdrop);
wireAltFormatButton(btnExportTcx);
btnOpenSaveExport.addEventListener('click', () => openSaveExportSheet(saveExportDialog, routeNameInput));

initLibrarySegment(communitySegmentEl, (segment) => {
  communityDiscoverEl.hidden = segment !== 'discover';
  communityLibraryEl.hidden = segment !== 'library';
  if (segment === 'library') renderPublishedList();
});

libraryTabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setActiveInGroup(libraryTabButtons, button);
    const tab = button.dataset.libraryTab;
    savedList.hidden = tab !== 'saved';
    publishedList.hidden = tab !== 'published';
  });
});

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
    syncPlanRows();
    void recalculateRoute();
  }),
);

// Hills preference only affects the next round trip, so no reroute here.
hillsButtons.forEach((button) =>
  button.addEventListener('click', () => {
    settings.hills = button.dataset.hills as HillPreference;
    persistSettings();
    syncProfileUi();
    syncPlanRows();
  }),
);

trafficSelect.addEventListener('change', () => {
  settings.traffic = Number(trafficSelect.value);
  persistSettings();
  syncPlanRows();
  void recalculateRoute();
});

function hideHoverMarkerOnLeave(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('mouseleave', () => {
    if (hoverMarkerVisible) {
      hoverMarker.remove();
      hoverMarkerVisible = false;
    }
  });
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

/**
 * Renders the route detail view (mobile full-screen + desktop panel) for the
 * current route, or clears both when there is none. `poisFetchedForRoute`
 * doubles as "have we already handled a route change for this exact route
 * object": this function runs again once cafés/water arrive (to show their
 * counts) and must NOT re-detect climbs or re-clear POIs on that second pass,
 * only on a genuine route change.
 */
function renderRouteDetails(): void {
  const isNewRoute = state.route !== poisFetchedForRoute;
  if (isNewRoute) {
    clearCafes();
    clearWater();
  }
  setSurfaceLine();

  if (!state.route) {
    clearRouteDetail(routeDetailMobile, routeDetailPanel);
    routeDetailPanel.hidden = true;
    state.climbs = [];
    state.selectedClimb = -1;
    setClimbHighlight(null);
    poisFetchedForRoute = null;
    // Nothing to clear if the chart module was never loaded (no route yet).
    if (chartModulePromise) {
      void chartModulePromise.then(({ clearElevationChart }) => clearElevationChart());
    }
    if (hoverMarkerVisible) {
      hoverMarker.remove();
      hoverMarkerVisible = false;
    }
    return;
  }

  if (isNewRoute) {
    state.climbs = detectClimbs(state.route.coordinates);
    state.selectedClimb = -1;
    setClimbHighlight(null);
  }

  // #route-detail-mobile's own visibility comes from plannerScreen === 'detail'
  // (see initPlannerScreens below), not from route existence: candidates can
  // preview a route on the map without jumping straight to its full detail.
  routeDetailPanel.hidden = false;

  const km = state.route.distanceMeters / 1000;
  const ascend = Math.round(state.route.ascendMeters);
  const data: RouteDetailData = {
    title: routeNameInput.value.trim() || 'Your route',
    distanceKm: km,
    ascendM: ascend,
    timeHours: estimateMovingTimeHours(km, ascend, settings.bike),
    closed: state.closed,
    coordinates: state.route.coordinates,
    climbs: state.climbs,
    selectedClimb: state.selectedClimb,
    surfaceTotals: state.route.surface ?? surfaceBreakdown(state.route.messages),
    cafes: state.cafes,
    water: state.water,
  };
  // The mobile bookmark opens the Save/Export dialog (matching Candidates'
  // bookmark and the mockup); the desktop panel's Save/Export GPX stay
  // direct one-tap actions, as decided when the panel was first built.
  const mobileCallbacks: RouteDetailCallbacks = {
    onBack: () => setPlannerScreen(state.loopOptions.length > 0 ? 'candidates' : 'plan'),
    onShare: () => btnShare.click(),
    onSave: () => openSaveExportSheet(saveExportDialog, routeNameInput),
    onExportGpx: () => btnExport.click(),
    onClimbClick: selectClimb,
    onPoiClick: (lngLat) => map.flyTo({ center: lngLat, zoom: 15 }),
  };
  const mobileCanvas = renderRouteDetailFullscreen(routeDetailMobile, data, mobileCallbacks);
  const panelCanvas = renderRouteDetailPanel(routeDetailPanel, data, {
    onSave: () => btnSave.click(),
    onExportGpx: () => btnExport.click(),
  });
  hideHoverMarkerOnLeave(mobileCanvas);
  hideHoverMarkerOnLeave(panelCanvas);

  void loadChartModule().then(({ renderElevationChart }) => {
    // The route may have changed again while the chart module was loading,
    // so read state.route fresh here rather than capturing it earlier.
    if (!state.route) return;
    const onHover = (index: number): void => {
      const coord = state.route?.coordinates[index];
      if (!coord) return; // chart still holds indices from a previous route
      hoverMarker.setLngLat([coord[0], coord[1]]);
      if (!hoverMarkerVisible) {
        hoverMarker.addTo(map);
        hoverMarkerVisible = true;
      }
    };
    renderElevationChart(mobileCanvas, state.route.coordinates, onHover);
    renderElevationChart(panelCanvas, state.route.coordinates, onHover);
  });

  fetchPoisIfNeeded();
}

/** Highlights a climb's stretch on the live map and zooms to it; called from routeDetailView.ts. */
function selectClimb(climb: Climb, index: number): void {
  state.selectedClimb = index;
  setClimbHighlight(climb);
  const coords = state.route!.coordinates.slice(climb.startIndex, climb.endIndex + 1);
  const bounds = coords.reduce(
    (acc, c) => acc.extend([c[0], c[1]]),
    new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
  );
  map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
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
  renderSavedList(savedList, routes, {
    onLoad: (route) => void loadSaved(route),
    onDelete: async (route) => {
      try {
        await deleteRoute(route.id!);
      } catch {
        setStatus('Could not delete that saved route.', true);
        return;
      }
      await refreshSavedList();
    },
  });
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
  btnCloseLoop.disabled = state.closed || state.waypoints.length < 3;
  btnBuildDone.disabled = !state.route;
  updatePublishButton();
  renderBuildReadout();
  syncEditToolbar();
  syncPlanRows();
}

/**
 * Shows the Undo/Clear/Reverse toolbar whenever there is actually something to
 * edit, on whichever screen the user is on.
 *
 * Deliberately keyed off state rather than off the planner screen: waypoints
 * arrive from more places than the Build screen. Loading a saved route, opening
 * a shared link, importing a GPX and picking a generated loop all leave
 * editable points on screen without ever passing through 'build', and hiding
 * the toolbar there left no way to undo or clear them.
 */
function syncEditToolbar(): void {
  const screen = getPlannerScreen();
  const somethingToEdit = state.waypoints.length > 0 || state.closed;
  // Generating/Candidates hand the sheet over to the candidate cards, and the
  // route detail is a full-screen overlay carrying its own actions.
  const screenHasRoomForIt = screen === 'plan' || screen === 'build';
  controlsEl.hidden = !somethingToEdit || !screenHasRoomForIt;
  buildActionsEl.hidden = screen !== 'build';
}

/** The Build screen's big distance/gain/point-count readout (mobile only). */
function renderBuildReadout(): void {
  const km = state.route ? state.route.distanceMeters / 1000 : 0;
  const ascend = state.route ? Math.round(state.route.ascendMeters) : 0;
  buildDistance.innerHTML = `${km.toFixed(1)}<span class="unit">km</span>`;
  buildAscend.innerHTML = `+${ascend}<span class="unit">m</span>`;
  buildPoints.textContent = `${state.waypoints.length} point${state.waypoints.length === 1 ? '' : 's'}`;
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
  if (!state.lastKnownLocation) return null;
  let min = Infinity;
  for (const wp of route.waypoints) {
    const d = haversineMeters(state.lastKnownLocation, wp);
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
  if (communitySort === 'near' && state.lastKnownLocation) {
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
  // The two tabs are very different heights, and the middle snap is measured
  // from whichever is showing.
  bottomSheet?.refresh();
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

  void loadBackend().then(({ auth, community }) => {
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
        accountAvatar.textContent = (authorNameInput.value || user.email || '?')[0].toUpperCase();
        // Clean up this owner's routes whose grace period has passed.
        void community.purgeExpiredRoutes();
      }
      updatePublishButton();
      void refreshCommunity();
    });
  });

  authorNameInput.addEventListener('input', () => {
    try {
      localStorage.setItem(AUTHOR_KEY, authorNameInput.value.trim());
    } catch {
      // Blocked storage just means the name is not remembered next visit.
    }
    if (currentUser) {
      accountAvatar.textContent = (authorNameInput.value || currentUser.email || '?')[0].toUpperCase();
    }
  });

  // Email code (OTP) sign-in. A typed code rather than a magic link so it works
  // inside an installed PWA, where a link would open Safari (see auth.ts).
  let pendingEmail = '';

  function showCodeEntry(email: string): void {
    pendingEmail = email;
    emailRow.hidden = true;
    codeRow.hidden = false;
    btnSigninBack.hidden = false;
    signinHint.textContent = `Enter the code we emailed to ${email}.`;
    accountCode.value = '';
    accountCode.focus();
  }

  function resetSignInForm(): void {
    pendingEmail = '';
    codeRow.hidden = true;
    emailRow.hidden = false;
    btnSigninBack.hidden = true;
    signinHint.textContent = DEFAULT_SIGNIN_HINT;
  }

  btnSignin.addEventListener('click', async () => {
    const email = accountEmail.value.trim();
    if (!email) {
      setStatus('Enter your email to get a sign-in code.', true);
      return;
    }
    btnSignin.disabled = true;
    try {
      await (await loadBackend()).auth.sendEmailCode(email);
      showCodeEntry(email);
      setStatus(`Code sent to ${email}. Enter it here to finish.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not send the sign-in code.', true);
    } finally {
      btnSignin.disabled = false;
    }
  });

  async function submitCode(): Promise<void> {
    // Supabase's OTP length is a per-project setting, not always 6, so accept
    // any plausible numeric code rather than assuming a fixed length.
    const token = accountCode.value.trim();
    if (!/^\d{4,12}$/.test(token)) {
      setStatus('Enter the code from the email.', true);
      return;
    }
    btnVerify.disabled = true;
    try {
      await (await loadBackend()).auth.verifyEmailCode(pendingEmail, token);
      // onAuthChange swaps to the signed-in UI; tidy the form for next time.
      resetSignInForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That code was not valid. Try again.', true);
    } finally {
      btnVerify.disabled = false;
    }
  }

  btnVerify.addEventListener('click', () => void submitCode());
  accountCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submitCode();
  });
  accountEmail.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') btnSignin.click();
  });
  btnSigninBack.addEventListener('click', resetSignInForm);

  btnSignout.addEventListener('click', async () => {
    await (await loadBackend()).auth.signOut();
    resetSignInForm();
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
      await (await loadBackend()).community.publishRoute({
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

  initDualRange({
    min: communityDistMin,
    max: communityDistMax,
    label: communityDistValue,
    track: communityDistTrack,
    format: (min, max) =>
      min === 0 && max >= DIST_MAX
        ? 'Any length'
        : `${min} – ${max >= DIST_MAX ? `${DIST_MAX}+` : max} km`,
    onInput: () => renderCommunityList(filteredCommunityRoutes(), communityRatings),
  });
}

/** Resolves to the user's location, requesting a GPS fix once if needed. */
function ensureLocation(): Promise<[number, number] | null> {
  if (state.lastKnownLocation) return Promise.resolve(state.lastKnownLocation);
  if (!('geolocation' in navigator)) {
    setStatus('This browser does not support GPS location.', true);
    return Promise.resolve(null);
  }
  setStatus('Getting your location…');
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.lastKnownLocation = [position.coords.longitude, position.coords.latitude];
        setStatus('');
        resolve(state.lastKnownLocation);
      },
      () => {
        setStatus('Could not get your location. Check the location permission.', true);
        resolve(null);
      },
      { timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function refreshCommunity(): Promise<void> {
  if (!isSupabaseConfigured) return;
  // Show skeletons on the first load (empty list) so the panel doesn't flash blank.
  if (communityList.childElementCount === 0) renderCommunitySkeletons();
  try {
    // 'near' has no server ordering; fetch newest and sort by distance client-side.
    const serverSort: CommunitySort = communitySort === 'near' ? 'newest' : communitySort;
    const { community } = await loadBackend();
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

function renderCommunityList(
  routes: CommunityRoute[],
  myRatings: Map<string, number>,
  container: HTMLUListElement = communityList,
): void {
  if (container === communityList) setApplyButtonCount(btnApplyFilters, routes.length);
  container.innerHTML = '';
  if (routes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'community-empty';
    empty.textContent =
      container === publishedList
        ? "You haven't published any routes yet."
        : communityRoutes.length === 0
          ? 'No routes published yet. Plan one and hit Publish.'
          : 'No routes match these filters.';
    container.append(empty);
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
      // Safe to read synchronously: the list only renders after the routes
      // were fetched through this same module.
      const url = backend?.community.fileDownloadUrl(route.gpxPath) ?? null;
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
    container.append(item);
  }
}

/** Renders the Library's Published tab: routes owned by the signed-in user. */
function renderPublishedList(): void {
  const mine = currentUser ? communityRoutes.filter((r) => r.ownerId === currentUser!.id) : [];
  renderCommunityList(mine, communityRatings, publishedList);
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
          await (await loadBackend()).community.rateRoute(route.id, n);
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
  const { community } = await loadBackend();
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

// --- Mobile bottom sheet ---
const bottomSheet = initBottomSheet();

// --- Mobile planner screens (plan / generating / candidates / detail / build) ---
initPlannerScreens(
  {
    plan: screenPlan,
    generating: screenGenerating,
    candidates: screenCandidates,
    detail: routeDetailMobile,
    build: screenBuild,
  },
  (screen) => {
    // #loop-options is shared across the Generating and Candidates screens
    // rather than duplicated (see index.html's comments), so it needs its
    // own visibility check on every screen change, not just when its data
    // changes.
    renderLoopOptions();
    syncEditToolbar();
    if (screen === 'generating' || screen === 'candidates') bottomSheet?.raiseToHalf();
    // The middle snap is measured from the sheet's contents, so a screen swap
    // has to re-measure or the sheet keeps the previous screen's height.
    bottomSheet?.refresh();
  },
);

// Reflect the initial state (a shared link may already have loaded a route).
syncEditToolbar();
syncPlanRows();

// Dev-only handle for verification in the browser console; stripped from
// the production build by the `import.meta.env.DEV` guard.
if (import.meta.env.DEV) {
  (window as unknown as { __lr: unknown }).__lr = { map, state };
}

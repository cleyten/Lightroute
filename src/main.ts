import maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchRoute, type LngLat, type RouteResult } from './routing';
import { downloadGpx } from './gpx';

// All application state lives in this one object.
const state = {
  waypoints: [] as LngLat[],
  markers: [] as maplibregl.Marker[],
  route: null as RouteResult | null,
  // Incremented per routing request so stale responses can be ignored.
  requestId: 0,
};

const statDistance = document.querySelector<HTMLElement>('#stat-distance')!;
const statAscend = document.querySelector<HTMLElement>('#stat-ascend')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const btnUndo = document.querySelector<HTMLButtonElement>('#btn-undo')!;
const btnClear = document.querySelector<HTMLButtonElement>('#btn-clear')!;
const btnExport = document.querySelector<HTMLButtonElement>('#btn-export')!;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [5.3, 51.9], // Netherlands
  zoom: 7,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');

map.on('load', () => {
  // Empty GeoJSON source; its data is replaced whenever a route is calculated.
  map.addSource('route', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#d1342f',
      'line-width': 4,
      'line-opacity': 0.85,
    },
  });
});

map.on('click', (event) => {
  addWaypoint([event.lngLat.lng, event.lngLat.lat]);
});

btnUndo.addEventListener('click', () => {
  state.waypoints.pop();
  state.markers.pop()?.remove();
  void recalculateRoute();
  updateControls();
});

btnClear.addEventListener('click', () => {
  state.waypoints = [];
  state.markers.forEach((marker) => marker.remove());
  state.markers = [];
  void recalculateRoute();
  updateControls();
});

btnExport.addEventListener('click', () => {
  if (!state.route) return;
  const today = new Date().toISOString().slice(0, 10);
  downloadGpx(state.route.coordinates, `Lightroute ${today}`);
});

function addWaypoint(lngLat: LngLat): void {
  state.waypoints.push(lngLat);

  const el = document.createElement('div');
  el.className = 'waypoint-marker';
  el.textContent = String(state.waypoints.length);
  const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  state.markers.push(marker);

  void recalculateRoute();
  updateControls();
}

async function recalculateRoute(): Promise<void> {
  const requestId = ++state.requestId;

  if (state.waypoints.length < 2) {
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderStats();
    setStatus('');
    updateControls();
    return;
  }

  setStatus('Route berekenen…');
  try {
    const route = await fetchRoute(state.waypoints);
    if (requestId !== state.requestId) return; // a newer request superseded this one
    state.route = route;
    setRouteData(route.geojson);
    renderStats();
    setStatus('');
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.route = null;
    setRouteData({ type: 'FeatureCollection', features: [] });
    renderStats();
    setStatus(error instanceof Error ? error.message : 'Er ging iets mis.', true);
  }
  updateControls();
}

function setRouteData(data: FeatureCollection): void {
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  source?.setData(data);
}

function renderStats(): void {
  if (state.route) {
    statDistance.textContent = `${(state.route.distanceMeters / 1000).toFixed(1)} km`;
    statAscend.textContent = `${Math.round(state.route.ascendMeters)} m`;
  } else {
    statDistance.textContent = '–';
    statAscend.textContent = '–';
  }
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateControls(): void {
  btnUndo.disabled = state.waypoints.length === 0;
  btnClear.disabled = state.waypoints.length === 0;
  btnExport.disabled = !state.route;
}

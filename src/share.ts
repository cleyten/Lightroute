// Route sharing via a compact URL. The payload only needs the few waypoints
// that drive routing (a manual route's clicked points, or a generated loop's
// turn-aware waypoints — see extractLoopWaypoints in main.ts) plus the bike
// profile, not the full track geometry: the receiving app recalculates the
// actual route from these via BRouter, exactly like loading a saved route.
// That keeps shared links short (a handful of points, not hundreds).

import type { LngLat } from './routing';

export interface SharePayload {
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
}

const PARAM = 'r';

export function buildShareUrl(payload: SharePayload): string {
  const compact = {
    w: payload.waypoints.map(([lng, lat]) => [round5(lng), round5(lat)]),
    b: payload.bike,
    t: payload.traffic,
    c: payload.closed ? 1 : 0,
  };
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(PARAM, toBase64Url(JSON.stringify(compact)));
  return url.toString();
}

export function parseShareUrl(search: string): SharePayload | null {
  const raw = new URLSearchParams(search).get(PARAM);
  if (!raw) return null;
  try {
    const compact = JSON.parse(fromBase64Url(raw)) as {
      w: [number, number][];
      b: string;
      t: number;
      c: number;
    };
    if (!Array.isArray(compact.w) || compact.w.length < 2) return null;
    return {
      waypoints: compact.w.map(([lng, lat]) => [lng, lat] as LngLat),
      bike: ['race', 'gravel', 'mtb'].includes(compact.b) ? compact.b : 'race',
      traffic: [0, 1, 2].includes(compact.t) ? compact.t : 0,
      closed: !!compact.c,
    };
  } catch {
    return null;
  }
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

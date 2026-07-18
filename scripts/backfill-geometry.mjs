#!/usr/bin/env node
// One-off backfill: reconstruct and store `geometry` for community routes that
// were published before the `geometry` column existed, so they show up in the
// map heatmap. Each route's stored waypoints are re-routed through BRouter
// exactly as the app does, then simplified with the same rule the app uses
// (simplifyForHeatmap: drop points closer than 40 m, round to 5 decimals), and
// written back.
//
// Safe to re-run: it only touches routes whose geometry is still null, and it
// never deletes anything.
//
// It uses the Supabase service_role key so it can update routes regardless of
// owner (RLS would otherwise allow each owner to update only their own). That
// key bypasses Row Level Security — keep it out of the client, out of git, and
// only paste it into this one command.
//
// Usage (Node 18+, from the repo root):
//
//   SUPABASE_URL=https://YOURPROJECT.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   node scripts/backfill-geometry.mjs
//
// or: npm run backfill:geometry  (with the two env vars set)
//
// Get the service_role key from Supabase → Project Settings → API →
// "service_role" secret (NOT the anon/publishable key).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, e.g.\n\n' +
      '  SUPABASE_URL=https://YOURPROJECT.supabase.co \\\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=eyJ... \\\n' +
      '  node scripts/backfill-geometry.mjs\n',
  );
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// --- Mirror of the app's routing + simplify logic ---------------------------
// Keep these in sync with src/routing.ts (fetchRoute), src/main.ts
// (currentProfile, TRAFFIC_PROFILES, simplifyForHeatmap) and the closed-loop
// rule at src/main.ts (routingWaypoints).

const BROUTER_URL = 'https://brouter.de/brouter';
const TRAFFIC_PROFILES = ['fastbike', 'fastbike-lowtraffic', 'fastbike-verylowtraffic'];

/** BRouter profile for a route's bike type + traffic preference. */
function profileFor(bike, traffic) {
  if (bike === 'gravel') return 'gravel';
  if (bike === 'mtb') return 'mtb';
  return TRAFFIC_PROFILES[Number(traffic) || 0] ?? 'fastbike-lowtraffic';
}

/** Route the waypoints through BRouter; returns [lng, lat, ele][]. */
async function fetchRoute(waypoints, profile) {
  const lonlats = waypoints
    .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
    .join('|');
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  const res = await fetch(url);
  const text = await res.text();
  // BRouter sometimes returns plain-text errors with HTTP 200; parse to check.
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.trim().slice(0, 160) || 'invalid routing response');
  }
  const feature = data.features?.[0];
  if (!feature || feature.geometry?.type !== 'LineString') {
    throw new Error('routing server returned no track');
  }
  return feature.geometry.coordinates;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Same thinning the app applies before storing a heatmap track. */
function simplifyForHeatmap(coords, minGapM = 40) {
  const round = (n) => Number(n.toFixed(5));
  const out = [];
  let last = null;
  for (const c of coords) {
    const p = [round(c[0]), round(c[1])];
    if (!last || haversineMeters(last, p) >= minGapM) {
      out.push(p);
      last = p;
    }
  }
  const end = coords[coords.length - 1];
  if (end) {
    const p = [round(end[0]), round(end[1])];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Backfill ---------------------------------------------------------------

async function main() {
  const { data: routes, error } = await db
    .from('routes')
    .select('id, name, waypoints, bike, traffic, closed')
    .is('deleted_at', null)
    .is('geometry', null);

  if (error) {
    console.error('Query failed:', error.message);
    process.exit(1);
  }
  if (!routes || routes.length === 0) {
    console.log('Nothing to backfill — every visible route already has geometry.');
    return;
  }

  console.log(`Backfilling ${routes.length} route(s) via BRouter…\n`);
  let updated = 0;
  let skipped = 0;

  for (const r of routes) {
    const wps = Array.isArray(r.waypoints) ? r.waypoints : null;
    if (!wps || wps.length < 2) {
      console.warn(`  ✗ ${r.name || r.id}: fewer than 2 waypoints, skipped`);
      skipped++;
      continue;
    }
    // A closed loop routes back to point 1 by repeating it as the final target.
    const routingWps = r.closed ? [...wps, wps[0]] : wps;
    try {
      const coords = await fetchRoute(routingWps, profileFor(r.bike, r.traffic));
      const geometry = simplifyForHeatmap(coords);
      if (geometry.length < 2) {
        console.warn(`  ✗ ${r.name || r.id}: empty geometry, skipped`);
        skipped++;
        continue;
      }
      const { error: upErr } = await db.from('routes').update({ geometry }).eq('id', r.id);
      if (upErr) {
        console.warn(`  ✗ ${r.name || r.id}: update failed (${upErr.message})`);
        skipped++;
        continue;
      }
      updated++;
      console.log(`  ✓ ${r.name || r.id} — ${geometry.length} points`);
    } catch (e) {
      console.warn(`  ✗ ${r.name || r.id}: ${e.message}`);
      skipped++;
    }
    // Be polite to the free public BRouter server.
    await sleep(1200);
  }

  console.log(`\nDone. Updated ${updated}, skipped ${skipped}.`);
  if (skipped > 0) {
    console.log('Skipped routes keep their null geometry; re-running is safe.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

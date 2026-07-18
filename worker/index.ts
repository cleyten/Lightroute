// Cloudflare Worker that fronts the static site and proxies the two upstream
// APIs that need secret keys, so the keys live only here (as Worker secrets)
// and never ship in the client bundle.
//
//   /api/ors/<profile>/geojson              -> OpenRouteService directions
//   /api/tiles/thunderforest/<...>.png      -> Thunderforest (OpenCycleMap)
//
// Everything else is served from the static assets (./dist), with an SPA
// fallback via `not_found_handling` in wrangler.jsonc.

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  // Accepted under either name: the plain runtime-secret name (ORS_KEY) or the
  // VITE_-prefixed one, since the dashboard's "Variables and Secrets" UI leads
  // people to reuse the build-variable names. See orsKey()/tfKey() below.
  ORS_KEY?: string;
  VITE_ORS_KEY?: string;
  THUNDERFOREST_KEY?: string;
  VITE_THUNDERFOREST_KEY?: string;
}

// The proxy reads ORS_KEY / THUNDERFOREST_KEY, but the two upstream keys are
// easy to set under their VITE_-prefixed build-variable names by mistake, so
// accept either. (VITE_ has no meaning at runtime; it's just a naming habit.)
const orsKey = (env: Env): string => env.ORS_KEY || env.VITE_ORS_KEY || '';
const tfKey = (env: Env): string => env.THUNDERFOREST_KEY || env.VITE_THUNDERFOREST_KEY || '';

const ORS_PREFIX = '/api/ors/';
const TILE_RE = /^\/api\/tiles\/thunderforest\/(.+)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // --- OpenRouteService (round trips) -----------------------------------
    if (pathname.startsWith(ORS_PREFIX)) {
      const key = orsKey(env);
      if (!key) return new Response('Routing not configured', { status: 503 });
      const rest = pathname.slice(ORS_PREFIX.length); // e.g. cycling-road/geojson
      const target = `https://api.openrouteservice.org/v2/directions/${rest}`;
      const isBodyless = request.method === 'GET' || request.method === 'HEAD';
      return fetch(target, {
        method: request.method,
        headers: {
          Authorization: key,
          'Content-Type': request.headers.get('content-type') || 'application/json',
        },
        body: isBodyless ? undefined : await request.text(),
      });
    }

    // --- Thunderforest OpenCycleMap tiles ---------------------------------
    const tile = pathname.match(TILE_RE);
    if (tile) {
      const key = tfKey(env);
      if (!key) return new Response('Tiles not configured', { status: 503 });
      const target = `https://tile.thunderforest.com/${tile[1]}?apikey=${key}`;
      const upstream = await fetch(target);
      const headers = new Headers(upstream.headers);
      headers.set('Cache-Control', 'public, max-age=86400');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    // --- Static site ------------------------------------------------------
    return env.ASSETS.fetch(request);
  },
};

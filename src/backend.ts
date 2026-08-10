// Lazily loads the Supabase-backed modules (auth + community) so the heavy
// @supabase/supabase-js client stays out of the initial bundle; the planner
// works with no backend at all. isSupabaseConfigured (supabaseConfig.ts) is
// what lets callers check eagerly whether the backend exists without triggering
// this load. Shared by main.ts (the heatmap) and communityUi.ts.
type AuthModule = typeof import('./auth');
type CommunityModule = typeof import('./community');

export interface Backend {
  auth: AuthModule;
  community: CommunityModule;
}

// Resolved modules once loaded, for the few synchronous call sites.
let backend: Backend | null = null;
let backendPromise: Promise<Backend> | null = null;

export function loadBackend(): Promise<Backend> {
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

/** The resolved backend once loadBackend() has completed, else null. */
export function resolvedBackend(): Backend | null {
  return backend;
}

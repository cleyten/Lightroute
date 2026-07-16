// Reads the Supabase env vars without importing @supabase/supabase-js, so
// main.ts can know synchronously (and cheaply, at initial page load) whether
// the community backend is configured, without eagerly pulling in the heavy
// client library just to check two strings. supabase.ts imports these same
// values for the actual client.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when both env vars are present, so the community UI can be shown. */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

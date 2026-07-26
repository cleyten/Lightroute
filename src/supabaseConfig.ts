// Reads the Supabase config without importing @supabase/supabase-js, so
// main.ts can know synchronously (and cheaply, at initial page load) whether
// the community backend is available, without eagerly pulling in the heavy
// client library just to check two strings. supabase.ts imports these same
// values for the actual client.
//
// Both values are safe to ship publicly: the publishable ("anon") key is
// protected by Row Level Security (see supabase/schema.sql), not by secrecy.
// That is why they fall back to the project's own values when a build did not
// inject them, e.g. a Cloudflare build without the VITE_SUPABASE_* build
// variables set, which keeps the community tab working regardless of build
// configuration. A build variable still overrides. NEVER put the service_role
// key here.
const SUPABASE_URL_DEFAULT = 'https://ovqjrpyvceehnzqnluut.supabase.co';
const SUPABASE_ANON_KEY_DEFAULT = 'sb_publishable_iZQZuuhzPQuCqW00EqnkJg_4De09xR1';

export const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || SUPABASE_URL_DEFAULT;
export const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || SUPABASE_ANON_KEY_DEFAULT;

/** True when both values are present, so the community UI can be shown. */
export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

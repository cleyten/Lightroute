// Supabase client for the community backend (route library + star ratings +
// GPX uploads). The project URL and the publishable ("anon") key come from
// build-time env vars, never hardcoded, mirroring how the ORS and Thunderforest
// keys are wired. Both values are safe to ship in the browser bundle: Row Level
// Security in the database (see supabase/schema.sql) is what protects the data,
// not secrecy of this key. NEVER put the service_role key here.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True when both env vars are present, so the community UI can be shown. */
export const isSupabaseConfigured = Boolean(url && key);

// A single shared client, or null when the env vars are absent (e.g. a build
// without the community backend configured). Callers must handle null so the
// core planner keeps working without any backend.
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url as string, key as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Parse the magic-link token out of the URL on return, then clean it.
        detectSessionInUrl: true,
      },
    })
  : null;

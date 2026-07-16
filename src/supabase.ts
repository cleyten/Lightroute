// Supabase client for the community backend (route library + star ratings +
// GPX uploads). The project URL and the publishable ("anon") key come from
// build-time env vars, never hardcoded, mirroring how the ORS and Thunderforest
// keys are wired. Both values are safe to ship in the browser bundle: Row Level
// Security in the database (see supabase/schema.sql) is what protects the data,
// not secrecy of this key. NEVER put the service_role key here.
//
// This module (and everything importing it, transitively `./auth`/
// `./community`) is dynamically `import()`-ed from main.ts rather than
// statically imported, so `@supabase/supabase-js` is code-split into its own
// chunk instead of bloating the initial bundle. `isSupabaseConfigured` lives
// in the separate supabaseConfig.ts specifically so it can be checked
// eagerly, without triggering that load.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './supabaseConfig';

export { isSupabaseConfigured };

// A single shared client, or null when the env vars are absent (e.g. a build
// without the community backend configured). Callers must handle null so the
// core planner keeps working without any backend.
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Parse the magic-link token out of the URL on return, then clean it.
        detectSessionInUrl: true,
      },
    })
  : null;

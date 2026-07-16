// Email magic-link authentication. Publishing routes, uploading GPX files and
// rating routes require a signed-in user; browsing the shared library does not.
// Password-free: a single-use link is emailed and clicking it returns here with
// a session (see detectSessionInUrl in supabase.ts).
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Sends a magic sign-in link to the given email address. */
export async function sendMagicLink(email: string): Promise<void> {
  if (!supabase) throw new Error('Community features are not configured.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Return to this exact page. Works for both localhost dev and the
      // GitHub Pages path. This URL must be listed in the Supabase project's
      // Authentication > URL Configuration > Redirect URLs, or the link fails.
      emailRedirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

/** The signed-in user, or null. Reads the stored session (no network call). */
export async function getCurrentUser(): Promise<User | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

/** Calls `handler` with the current user now and on every later auth change. */
export function onAuthChange(handler: (user: User | null) => void): void {
  if (!supabase) {
    handler(null);
    return;
  }
  void supabase.auth.getSession().then(({ data }) => handler(data.session?.user ?? null));
  supabase.auth.onAuthStateChange((_event, session) => {
    handler(session?.user ?? null);
  });
}

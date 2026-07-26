// Email one-time-code (OTP) authentication. Publishing routes, uploading GPX
// files and rating routes require a signed-in user; browsing the shared library
// does not. Password-free: a numeric code (length set by the Supabase project's
// OTP settings, commonly 6 digits) is emailed and typed back into the app to
// establish the session.
//
// We deliberately use a typed code rather than a magic *link*: on iOS, tapping
// a link in Mail always opens Safari, never an installed home-screen PWA, and
// the standalone PWA has a separate storage context — so a link-based session
// lands in Safari and the PWA stays signed out. A code keeps the whole flow
// inside whatever context the user started in. (The Supabase "Magic Link" email
// template must include {{ .Token }} for the code to appear in the email.)
import type { User } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Emails a numeric one-time sign-in code to the given address. */
export async function sendEmailCode(email: string): Promise<void> {
  if (!supabase) throw new Error('Community features are not configured.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      // No emailRedirectTo: omitting it keeps this a code the user types in
      // rather than a link, so it works inside an installed PWA and needs no
      // redirect-URL allow-listing.
    },
  });
  if (error) throw error;
}

/** Verifies an emailed code and establishes the session in this context. */
export async function verifyEmailCode(email: string, token: string): Promise<void> {
  if (!supabase) throw new Error('Community features are not configured.');
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
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

// Community library UI (Supabase): publish a route to the shared library, browse
// it (public, no sign-in), rate routes, and load/delete your own. Extracted from
// main.ts. Publishing/rating needs sign-in; browsing is public. The whole section
// only wires up when the backend is configured, so the planner works without it.
//
// This module owns the Community tab end to end but still needs a few things
// from the planner core (the map, the route recalculation, the marker rebuild,
// the heatmap helpers). Those are passed in once via initCommunityUi rather than
// imported, so the dependency runs one way (main.ts -> here) and tsc stays useful.
import maplibregl from 'maplibre-gl';
import type { User } from '@supabase/supabase-js';
import type { LngLat } from './routing';
import { haversineMeters } from './geo';
import { setStatus, setBusy, setActiveInGroup } from './ui';
import { initDualRange } from './dualRange';
import { reverseCity } from './geocode';
import { buildRoutePreviewSvg } from './preview';
import { state } from './state';
import { persistSettings, settings, syncProfileUi, type BikeType } from './settings';
import { isSupabaseConfigured } from './supabaseConfig';
import { loadBackend, resolvedBackend } from './backend';
import type { CommunityRoute, CommunitySort } from './community';
import {
  DEFAULT_SIGNIN_HINT, accountCode, accountEmail, accountName, accountSignedIn, accountSignedOut,
  authorField, authorNameInput, bottomTabButtons, btnPublish, btnSignin, btnSigninBack, btnSignout,
  btnVerify, codeRow, communityBikeButtons, communityDistMax, communityDistMin, communityDistTrack,
  communityDistValue, communityHillsButtons, communityList, communityPanel, communitySortButtons,
  emailRow, mainTabButtons, mainTabs, plannerPanel, routeNameInput, signinHint,
} from './dom';

/** Planner-core hooks the community UI needs; supplied once by initCommunityUi. */
export interface CommunityDeps {
  map: maplibregl.Map;
  recalculateRoute: () => Promise<void>;
  rebuildMarkers: () => void;
  routeChangeNote: (savedMeters: number | null | undefined) => string;
  simplifyForHeatmap: (coords: [number, number, number][]) => LngLat[];
  /** Mark the heatmap dirty so it refetches next time it opens (after a publish). */
  markHeatmapStale: () => void;
}

let deps: CommunityDeps;

let currentUser: User | null = null;
// 'near' is a client-side proximity sort layered on a newest fetch.
type CommunitySortMode = CommunitySort | 'near';
let communitySort: CommunitySortMode = 'newest';
let communityBikeFilter: 'all' | 'race' | 'gravel' | 'mtb' = 'all';
let communityHillsFilter: 'all' | 'flat' | 'hilly' = 'all';
// Last fetched page, kept so changing a client-side filter re-renders without
// hitting the network again.
let communityRoutes: CommunityRoute[] = [];
let communityRatings = new Map<string, number>();
// Monotonic id so overlapping refreshes cannot clobber each other. refreshCommunity
// is triggered from several places (tab switch, sort change, publish, rate, sign-in),
// and a slow earlier fetch finishing after a newer one would otherwise leave the
// list showing stale data in the wrong order. Only the latest request may apply.
let communityRequestId = 0;

const AUTHOR_KEY = 'lightmile-author';
const CITY_CACHE_KEY = 'lightmile-city-cache';

// Metres of climbing per km above which a route counts as "hilly".
const HILLY_THRESHOLD = 10;
// Distance slider ceiling (km); the max thumb here means "no upper limit".
const DIST_MAX = 200;

// Reverse-geocoded town per route id, cached across sessions so the community
// list needs no extra DB column and no repeat lookups.
const cityCache = new Map<string, string>();
try {
  const raw = localStorage.getItem(CITY_CACHE_KEY);
  if (raw) {
    for (const [id, city] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
      cityCache.set(id, city);
    }
  }
} catch {
  /* corrupt cache: ignore, it rebuilds itself */
}

function rememberCity(id: string, city: string): void {
  cityCache.set(id, city);
  try {
    localStorage.setItem(CITY_CACHE_KEY, JSON.stringify(Object.fromEntries(cityCache)));
  } catch {
    /* storage full or unavailable: the in-memory cache still works this session */
  }
}

function routeIsHilly(route: CommunityRoute): boolean {
  const km = route.distanceMeters / 1000;
  if (km <= 0) return false;
  return route.ascendMeters / km >= HILLY_THRESHOLD;
}

function routeCentroid(route: CommunityRoute): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [lng, lat] of route.waypoints) {
    sx += lng;
    sy += lat;
  }
  const n = route.waypoints.length || 1;
  return [sx / n, sy / n];
}

/** Nearest approach (metres) of the route to the user, or null without a fix. */
function routeDistanceFromUser(route: CommunityRoute): number | null {
  if (!state.lastKnownLocation) return null;
  let min = Infinity;
  for (const wp of route.waypoints) {
    const d = haversineMeters(state.lastKnownLocation, wp);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

function filteredCommunityRoutes(): CommunityRoute[] {
  const distMin = Number(communityDistMin.value);
  const distMax = Number(communityDistMax.value);
  const list = communityRoutes.filter((route) => {
    if (communityBikeFilter !== 'all' && route.bike !== communityBikeFilter) return false;
    if (communityHillsFilter === 'flat' && routeIsHilly(route)) return false;
    if (communityHillsFilter === 'hilly' && !routeIsHilly(route)) return false;
    const km = route.distanceMeters / 1000;
    if (km < distMin) return false;
    if (distMax < DIST_MAX && km > distMax) return false;
    return true;
  });
  if (communitySort === 'near' && state.lastKnownLocation) {
    list.sort(
      (a, b) => (routeDistanceFromUser(a) ?? Infinity) - (routeDistanceFromUser(b) ?? Infinity),
    );
  }
  return list;
}

export function updatePublishButton(): void {
  if (!isSupabaseConfigured) return;
  btnPublish.disabled = !state.route || state.waypoints.length < 2 || !currentUser;
  btnPublish.title = currentUser ? '' : 'Sign in on the Community tab to publish';
}

/** Switches between the Route planner and Community tabs. */
export function setActiveTab(name: 'planner' | 'community'): void {
  [...mainTabButtons, ...bottomTabButtons].forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  plannerPanel.hidden = name !== 'planner';
  communityPanel.hidden = name !== 'community';
  if (name === 'community') void refreshCommunity();
}

/** Wires up the whole Community tab. Call once at startup, after the planner
 *  core (map, route controller) exists. A no-op UI-wise without a backend. */
export function initCommunityUi(d: CommunityDeps): void {
  deps = d;
  if (!isSupabaseConfigured) return;

  mainTabs.hidden = false;
  btnPublish.hidden = false;
  // Reveals the mobile bottom tab bar and docks the sheet above it (see CSS).
  document.body.classList.add('has-community');

  [...mainTabButtons, ...bottomTabButtons].forEach((btn) => {
    btn.addEventListener('click', () =>
      setActiveTab(btn.dataset.tab === 'community' ? 'community' : 'planner'),
    );
  });

  void loadBackend().then(({ auth, community }) => {
    auth.onAuthChange((user) => {
      currentUser = user;
      accountSignedOut.hidden = !!user;
      accountSignedIn.hidden = !user;
      authorField.hidden = !user;
      if (user) {
        accountName.textContent = user.email ?? 'you';
        // Prefill the display name from last time, else the email's local part.
        if (!authorNameInput.value) {
          authorNameInput.value =
            localStorage.getItem(AUTHOR_KEY) ?? user.email?.split('@')[0] ?? '';
        }
        // Clean up this owner's routes whose grace period has passed.
        void community.purgeExpiredRoutes();
      }
      updatePublishButton();
      void refreshCommunity();
    });
  });

  authorNameInput.addEventListener('input', () => {
    try {
      localStorage.setItem(AUTHOR_KEY, authorNameInput.value.trim());
    } catch {
      // Blocked storage just means the name is not remembered next visit.
    }
  });

  // Email code (OTP) sign-in. A typed code rather than a magic link so it works
  // inside an installed PWA, where a link would open Safari (see auth.ts).
  let pendingEmail = '';

  function showCodeEntry(email: string): void {
    pendingEmail = email;
    emailRow.hidden = true;
    codeRow.hidden = false;
    btnSigninBack.hidden = false;
    signinHint.textContent = `Enter the code we emailed to ${email}.`;
    accountCode.value = '';
    accountCode.focus();
  }

  function resetSignInForm(): void {
    pendingEmail = '';
    codeRow.hidden = true;
    emailRow.hidden = false;
    btnSigninBack.hidden = true;
    signinHint.textContent = DEFAULT_SIGNIN_HINT;
  }

  btnSignin.addEventListener('click', async () => {
    const email = accountEmail.value.trim();
    if (!email) {
      setStatus('Enter your email to get a sign-in code.', true);
      return;
    }
    btnSignin.disabled = true;
    try {
      await (await loadBackend()).auth.sendEmailCode(email);
      showCodeEntry(email);
      setStatus(`Code sent to ${email}. Enter it here to finish.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not send the sign-in code.', true);
    } finally {
      btnSignin.disabled = false;
    }
  });

  async function submitCode(): Promise<void> {
    // Supabase's OTP length is a per-project setting, not always 6, so accept
    // any plausible numeric code rather than assuming a fixed length.
    const token = accountCode.value.trim();
    if (!/^\d{4,12}$/.test(token)) {
      setStatus('Enter the code from the email.', true);
      return;
    }
    btnVerify.disabled = true;
    try {
      await (await loadBackend()).auth.verifyEmailCode(pendingEmail, token);
      // onAuthChange swaps to the signed-in UI; tidy the form for next time.
      resetSignInForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'That code was not valid. Try again.', true);
    } finally {
      btnVerify.disabled = false;
    }
  }

  btnVerify.addEventListener('click', () => void submitCode());
  accountCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void submitCode();
  });
  accountEmail.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') btnSignin.click();
  });
  btnSigninBack.addEventListener('click', resetSignInForm);

  btnSignout.addEventListener('click', async () => {
    await (await loadBackend()).auth.signOut();
    resetSignInForm();
    setStatus('Signed out.');
  });

  btnPublish.addEventListener('click', async () => {
    if (!state.route || state.waypoints.length < 2 || !currentUser) return;
    const name =
      routeNameInput.value.trim() || `Route ${new Date().toISOString().slice(0, 10)}`;
    btnPublish.disabled = true;
    setStatus('Publishing…');
    setBusy(true);
    try {
      await (await loadBackend()).community.publishRoute({
        name,
        authorName: authorNameInput.value.trim() || null,
        waypoints: state.waypoints.map((wp) => [...wp] as LngLat),
        bike: settings.bike,
        traffic: settings.traffic,
        closed: state.closed,
        distanceMeters: state.route.distanceMeters,
        ascendMeters: state.route.ascendMeters,
        source: state.importedFileText ? 'imported' : 'planned',
        geometry: deps.simplifyForHeatmap(state.route.coordinates),
        originalFileText: state.importedFileText,
        originalFileFormat: state.importedFileFormat,
      });
      deps.markHeatmapStale(); // a new route should appear next time the heatmap opens
      setStatus(`Published "${name}" to the community library.`);
      await refreshCommunity();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not publish this route.', true);
    } finally {
      setBusy(false);
      updatePublishButton();
    }
  });

  // Newest/Top are server-side (they change the query order), so they refetch.
  // "Near me" plus bike/hills/distance are client-side over the fetched page.
  communitySortButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sort = (btn.dataset.sort as CommunitySortMode) ?? 'newest';
      if (sort === 'near' && !(await ensureLocation())) return; // no fix: keep current sort
      communitySort = sort;
      setActiveInGroup(communitySortButtons, btn);
      void refreshCommunity();
    });
  });

  communityBikeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      communityBikeFilter = (btn.dataset.bike as typeof communityBikeFilter) ?? 'all';
      setActiveInGroup(communityBikeButtons, btn);
      renderCommunityList(filteredCommunityRoutes(), communityRatings);
    });
  });

  communityHillsButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      communityHillsFilter = (btn.dataset.hills as typeof communityHillsFilter) ?? 'all';
      setActiveInGroup(communityHillsButtons, btn);
      renderCommunityList(filteredCommunityRoutes(), communityRatings);
    });
  });

  initDualRange({
    min: communityDistMin,
    max: communityDistMax,
    label: communityDistValue,
    track: communityDistTrack,
    format: (min, max) =>
      min === 0 && max >= DIST_MAX
        ? 'Any length'
        : `${min} – ${max >= DIST_MAX ? `${DIST_MAX}+` : max} km`,
    onInput: () => renderCommunityList(filteredCommunityRoutes(), communityRatings),
  });
}

/** Resolves to the user's location, requesting a GPS fix once if needed. */
function ensureLocation(): Promise<[number, number] | null> {
  if (state.lastKnownLocation) return Promise.resolve(state.lastKnownLocation);
  if (!('geolocation' in navigator)) {
    setStatus('This browser does not support GPS location.', true);
    return Promise.resolve(null);
  }
  setStatus('Getting your location…');
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        state.lastKnownLocation = [position.coords.longitude, position.coords.latitude];
        setStatus('');
        resolve(state.lastKnownLocation);
      },
      () => {
        setStatus('Could not get your location. Check the location permission.', true);
        resolve(null);
      },
      { timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function refreshCommunity(): Promise<void> {
  if (!isSupabaseConfigured) return;
  const requestId = ++communityRequestId;
  // Show skeletons on the first load (empty list) so the panel doesn't flash blank.
  if (communityList.childElementCount === 0) renderCommunitySkeletons();
  try {
    // 'near' has no server ordering; fetch newest and sort by distance client-side.
    const serverSort: CommunitySort = communitySort === 'near' ? 'newest' : communitySort;
    const { community } = await loadBackend();
    const [routes, myRatings] = await Promise.all([
      community.fetchCommunityRoutes(serverSort),
      community.fetchMyRatings(),
    ]);
    // A newer refresh started while this one was in flight: drop this result so
    // the list keeps the latest sort/order rather than flickering back.
    if (requestId !== communityRequestId) return;
    communityRoutes = routes;
    communityRatings = myRatings;
    renderCommunityList(filteredCommunityRoutes(), communityRatings);
  } catch (error) {
    // Non-fatal: the planner keeps working even if the library can't load.
    console.warn('Could not load community routes:', error);
  }
}

/** Placeholder shimmer rows shown while the community library loads. */
function renderCommunitySkeletons(count = 3): void {
  communityList.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const li = document.createElement('li');
    li.className = 'community-item skeleton';
    li.innerHTML =
      '<div class="sk sk-thumb"></div>' +
      '<div class="community-body">' +
      '<div class="sk sk-line sk-line-lg"></div>' +
      '<div class="sk sk-line"></div>' +
      '<div class="sk sk-line sk-line-sm"></div>' +
      '</div>';
    communityList.append(li);
  }
}

/**
 * Runs async tasks at most `limit` at a time. Used so the community list does
 * not fire one Photon reverse-geocode per route all at once: a large library
 * would otherwise burst dozens of requests at a free endpoint, which then rate-
 * limits and (since fillCity swallows failures) simply leaves towns blank.
 */
async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  });
  await Promise.all(workers);
}

function renderCommunityList(routes: CommunityRoute[], myRatings: Map<string, number>): void {
  communityList.innerHTML = '';
  if (routes.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'community-empty';
    empty.textContent =
      communityRoutes.length === 0
        ? 'No routes published yet. Plan one and hit Publish.'
        : 'No routes match these filters.';
    communityList.append(empty);
    return;
  }
  // Reverse-geocodes are queued, not fired inline, so a long list does not open
  // dozens of Photon requests at once; runWithConcurrency drains them a few at a time.
  const pendingCityFills: Array<() => Promise<void>> = [];
  for (const route of routes) {
    const item = document.createElement('li');
    item.className = 'community-item';

    const head = document.createElement('div');
    head.className = 'community-head';
    const name = document.createElement('span');
    name.className = 'community-name';
    name.textContent = route.name;
    const meta = document.createElement('span');
    meta.className = 'community-meta';
    const bikeLabel =
      route.bike === 'mtb' ? 'MTB' : route.bike.charAt(0).toUpperCase() + route.bike.slice(1);
    meta.textContent =
      `${(route.distanceMeters / 1000).toFixed(1)} km · +${Math.round(route.ascendMeters)} m · ${bikeLabel}`;
    const author = document.createElement('span');
    author.className = 'community-author';
    const authorName = route.authorName?.trim() || 'Anonymous';
    author.innerHTML = 'by ';
    const authorStrong = document.createElement('strong');
    authorStrong.textContent = authorName;
    author.append(authorStrong);
    const loc = document.createElement('span');
    loc.className = 'community-loc';
    loc.textContent = communityLocLabel(route);
    loc.hidden = loc.textContent === '';
    head.append(name, meta, author, loc);
    pendingCityFills.push(() => fillCity(route, loc));

    const ratingRow = document.createElement('div');
    ratingRow.className = 'community-rating';
    ratingRow.append(buildStars(route, myRatings.get(route.id) ?? 0));
    const summary = document.createElement('span');
    summary.className = 'rating-summary';
    summary.textContent =
      route.ratingCount > 0
        ? `${route.avgRating.toFixed(1)} (${route.ratingCount})`
        : 'no ratings yet';
    ratingRow.append(summary);

    const actions = document.createElement('div');
    actions.className = 'community-actions';
    const load = document.createElement('button');
    load.className = 'community-load';
    load.type = 'button';
    load.textContent = 'Load';
    load.addEventListener('click', () => void loadCommunityRoute(route));
    actions.append(load);
    if (route.gpxPath) {
      // Safe to read synchronously: the list only renders after the routes
      // were fetched through this same module.
      const url = resolvedBackend()?.community.fileDownloadUrl(route.gpxPath) ?? null;
      if (url) {
        // Rows published before file_format existed are all GPX (the only
        // format the app produced back then).
        const format = route.fileFormat ?? 'gpx';
        const download = document.createElement('a');
        download.className = 'community-gpx';
        download.href = url;
        download.textContent = format.toUpperCase();
        download.setAttribute('download', `${route.name.replace(/[^\w-]+/g, '_')}.${format}`);
        actions.append(download);
      }
    }
    if (currentUser && route.ownerId === currentUser.id) {
      const del = document.createElement('button');
      del.className = 'community-delete';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', () => void deleteCommunityRoute(route));
      actions.append(del);
    }

    const body = document.createElement('div');
    body.className = 'community-body';
    body.append(head, ratingRow, actions);

    const preview = buildRoutePreviewSvg(route.waypoints as [number, number][], route.closed);
    item.append(preview, body);
    communityList.append(item);
  }
  void runWithConcurrency(pendingCityFills, 4);
}

/** City (once reverse-geocoded) plus distance-from-you, for a route's location line. */
function communityLocLabel(route: CommunityRoute): string {
  const parts: string[] = [];
  const city = cityCache.get(route.id);
  if (city) parts.push(city);
  const away = routeDistanceFromUser(route);
  if (away != null) {
    const km = away / 1000;
    parts.push(`${km < 10 ? km.toFixed(1) : Math.round(km)} km away`);
  }
  return parts.join(' · ');
}

/** Fills in a route's town name once, lazily, then updates its location line. */
async function fillCity(route: CommunityRoute, loc: HTMLElement): Promise<void> {
  if (cityCache.has(route.id)) return;
  try {
    const city = await reverseCity(routeCentroid(route));
    if (!city) return;
    rememberCity(route.id, city);
    loc.textContent = communityLocLabel(route);
    loc.hidden = loc.textContent === '';
  } catch {
    /* best-effort: a missing town label is not worth surfacing */
  }
}

/** A 5-star widget: interactive buttons when signed in, static stars otherwise. */
function buildStars(route: CommunityRoute, myStars: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'stars';
  const interactive = !!currentUser;
  wrap.classList.toggle('interactive', interactive);
  // Fill to the user's own rating if they rated, otherwise the rounded average.
  const fillTo = myStars || Math.round(route.avgRating);
  for (let n = 1; n <= 5; n++) {
    const star = document.createElement(interactive ? 'button' : 'span');
    star.className = 'star';
    star.classList.toggle('filled', n <= fillTo);
    if (myStars) star.classList.toggle('mine', n <= myStars);
    star.textContent = '★';
    if (interactive) {
      const button = star as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-label', `Rate ${n} star${n > 1 ? 's' : ''}`);
      button.addEventListener('click', async () => {
        try {
          await (await loadBackend()).community.rateRoute(route.id, n);
          setStatus(`Rated "${route.name}" ${n} star${n > 1 ? 's' : ''}.`);
          await refreshCommunity();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Could not save your rating.', true);
        }
      });
    }
    wrap.append(star);
  }
  return wrap;
}

/** Loads a community route: same as a saved route, recomputed via BRouter. */
async function loadCommunityRoute(route: CommunityRoute): Promise<void> {
  state.waypoints = route.waypoints.map((wp) => [...wp] as LngLat);
  state.closed = route.closed;
  settings.bike = (['race', 'gravel', 'mtb'].includes(route.bike) ? route.bike : 'race') as BikeType;
  settings.traffic = [0, 1, 2].includes(route.traffic) ? route.traffic : 0;
  persistSettings();
  syncProfileUi();
  deps.rebuildMarkers();
  const bounds = state.waypoints.reduce(
    (acc, wp) => acc.extend(wp),
    new maplibregl.LngLatBounds(state.waypoints[0], state.waypoints[0]),
  );
  deps.map.fitBounds(bounds, { padding: 60 });
  await deps.recalculateRoute();
  if (state.route) setStatus(`Loaded "${route.name}".${deps.routeChangeNote(route.distanceMeters)}`);
}

/** Soft-deletes the owner's own community route after a confirmation. */
async function deleteCommunityRoute(route: CommunityRoute): Promise<void> {
  const { community } = await loadBackend();
  const confirmed = window.confirm(
    `Delete "${route.name}" from the community? It disappears from the library right away, ` +
      `and is kept recoverable for ${community.GRACE_DAYS} days before it is removed for good.`,
  );
  if (!confirmed) return;
  try {
    await community.softDeleteRoute(route.id);
    setStatus(`Deleted "${route.name}". Recoverable for ${community.GRACE_DAYS} days.`);
    await refreshCommunity();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not delete this route.', true);
  }
}

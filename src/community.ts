// Community route library backed by Supabase: publish a route to the shared
// library, browse it (public, no sign-in), and rate routes 1-5 stars. Like
// saved and shared routes, a published route stores only its waypoints (not the
// full track); the app recomputes the geometry via BRouter when it is loaded.
import { supabase } from './supabase';
import type { LngLat } from './routing';

export interface CommunityRoute {
  id: string;
  ownerId: string;
  name: string;
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
  distanceMeters: number;
  ascendMeters: number;
  source: 'planned' | 'imported';
  gpxPath: string | null;
  createdAt: string;
  avgRating: number;
  ratingCount: number;
}

export interface PublishInput {
  name: string;
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
  distanceMeters: number;
  ascendMeters: number;
  source: 'planned' | 'imported';
  /** Original GPX text for imported routes; uploaded to storage when present. */
  gpxText?: string | null;
}

export type CommunitySort = 'newest' | 'top';

// Shape of a row from the `routes_with_rating` view (snake_case, as stored).
interface RouteRow {
  id: string;
  owner_id: string;
  name: string;
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
  distance_meters: number | string;
  ascend_meters: number | string;
  source: 'planned' | 'imported';
  gpx_path: string | null;
  created_at: string;
  avg_rating: number | string;
  rating_count: number | string;
}

function client() {
  if (!supabase) throw new Error('Community features are not configured.');
  return supabase;
}

async function currentUserId(): Promise<string | null> {
  const { data } = await client().auth.getSession();
  return data.session?.user.id ?? null;
}

export async function publishRoute(input: PublishInput): Promise<void> {
  const db = client();
  const userId = await currentUserId();
  if (!userId) throw new Error('Sign in first to publish a route.');

  // For imported routes, keep the original file so others can download the
  // exact ridden track. The storage RLS policy sets `owner` to this user, so
  // the path only needs to be unique.
  let gpxPath: string | null = null;
  if (input.gpxText) {
    gpxPath = `${userId}/${crypto.randomUUID()}.gpx`;
    const { error: uploadError } = await db.storage
      .from('gpx-uploads')
      .upload(gpxPath, new Blob([input.gpxText], { type: 'application/gpx+xml' }));
    if (uploadError) throw uploadError;
  }

  const { error } = await db.from('routes').insert({
    owner_id: userId,
    name: input.name,
    waypoints: input.waypoints,
    bike: input.bike,
    traffic: input.traffic,
    closed: input.closed,
    distance_meters: input.distanceMeters,
    ascend_meters: input.ascendMeters,
    source: input.source,
    gpx_path: gpxPath,
  });
  if (error) throw error;
}

export async function fetchCommunityRoutes(sort: CommunitySort): Promise<CommunityRoute[]> {
  const base = client().from('routes_with_rating').select('*');
  const { data, error } =
    sort === 'top'
      ? await base
          .order('avg_rating', { ascending: false })
          .order('rating_count', { ascending: false })
      : await base.order('created_at', { ascending: false });
  if (error) throw error;
  return ((data as RouteRow[] | null) ?? []).map(mapRow);
}

/** Adds or replaces the current user's star rating for a route (1-5). */
export async function rateRoute(routeId: string, stars: number): Promise<void> {
  const db = client();
  const userId = await currentUserId();
  if (!userId) throw new Error('Sign in first to rate a route.');
  const { error } = await db
    .from('route_ratings')
    .upsert(
      { route_id: routeId, user_id: userId, stars },
      { onConflict: 'route_id,user_id' },
    );
  if (error) throw error;
}

/** The current user's own ratings, keyed by route id (for showing which stars they picked). */
export async function fetchMyRatings(): Promise<Map<string, number>> {
  const userId = await currentUserId();
  if (!userId) return new Map();
  const { data, error } = await client()
    .from('route_ratings')
    .select('route_id, stars')
    .eq('user_id', userId);
  if (error) throw error;
  const map = new Map<string, number>();
  for (const row of (data as { route_id: string; stars: number }[] | null) ?? []) {
    map.set(row.route_id, row.stars);
  }
  return map;
}

/** Public download URL for an uploaded GPX file, or null if unavailable. */
export function gpxDownloadUrl(gpxPath: string): string | null {
  if (!supabase) return null;
  return supabase.storage.from('gpx-uploads').getPublicUrl(gpxPath).data.publicUrl;
}

function mapRow(row: RouteRow): CommunityRoute {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    waypoints: (row.waypoints ?? []) as LngLat[],
    bike: row.bike,
    traffic: row.traffic,
    closed: row.closed,
    distanceMeters: Number(row.distance_meters),
    ascendMeters: Number(row.ascend_meters),
    source: row.source,
    gpxPath: row.gpx_path,
    createdAt: row.created_at,
    avgRating: Number(row.avg_rating),
    ratingCount: Number(row.rating_count),
  };
}

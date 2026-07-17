// Community route library backed by Supabase: publish a route to the shared
// library, browse it (public, no sign-in), and rate routes 1-5 stars. Like
// saved and shared routes, a published route stores only its waypoints (not the
// full track); the app recomputes the geometry via BRouter when it is loaded.
import { supabase } from './supabase';
import type { LngLat } from './routing';

export type OriginalFileFormat = 'gpx' | 'tcx';

export interface CommunityRoute {
  id: string;
  ownerId: string;
  name: string;
  authorName: string | null;
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
  distanceMeters: number;
  ascendMeters: number;
  source: 'planned' | 'imported';
  gpxPath: string | null;
  fileFormat: OriginalFileFormat | null;
  createdAt: string;
  avgRating: number;
  ratingCount: number;
}

export interface PublishInput {
  name: string;
  /** Display name of the author; falls back to null (shown as "Anonymous"). */
  authorName?: string | null;
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
  distanceMeters: number;
  ascendMeters: number;
  source: 'planned' | 'imported';
  /** Simplified [lng, lat] track for the community heatmap (no elevation). */
  geometry?: LngLat[] | null;
  /** Original file text for imported routes; uploaded to storage when present. */
  originalFileText?: string | null;
  /** Format of `originalFileText`; required alongside it so the upload gets
   *  the right extension/content-type and the download link the right name. */
  originalFileFormat?: OriginalFileFormat | null;
}

export type CommunitySort = 'newest' | 'top';

/** Grace period a deleted route (row + GPX file) is kept before it is purged. */
export const GRACE_DAYS = 14;

// Shape of a row from the `routes_with_rating` view (snake_case, as stored).
interface RouteRow {
  id: string;
  owner_id: string;
  name: string;
  author_name: string | null;
  waypoints: LngLat[];
  bike: string;
  traffic: number;
  closed: boolean;
  distance_meters: number | string;
  ascend_meters: number | string;
  source: 'planned' | 'imported';
  gpx_path: string | null;
  file_format: OriginalFileFormat | null;
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
  // the path only needs to be unique. The bucket is named 'gpx-uploads' from
  // before TCX support existed; it holds either format now, kept as-is to
  // avoid an unnecessary rename.
  let filePath: string | null = null;
  let fileFormat: OriginalFileFormat | null = null;
  if (input.originalFileText && input.originalFileFormat) {
    fileFormat = input.originalFileFormat;
    filePath = `${userId}/${crypto.randomUUID()}.${fileFormat}`;
    const mimeType =
      fileFormat === 'tcx' ? 'application/vnd.garmin.tcx+xml' : 'application/gpx+xml';
    const { error: uploadError } = await db.storage
      .from('gpx-uploads')
      .upload(filePath, new Blob([input.originalFileText], { type: mimeType }));
    if (uploadError) throw uploadError;
  }

  const row = {
    owner_id: userId,
    name: input.name,
    author_name: input.authorName?.trim() || null,
    waypoints: input.waypoints,
    geometry: input.geometry ?? null,
    bike: input.bike,
    traffic: input.traffic,
    closed: input.closed,
    distance_meters: input.distanceMeters,
    ascend_meters: input.ascendMeters,
    source: input.source,
    gpx_path: filePath,
    file_format: fileFormat,
  };
  let { error } = await db.from('routes').insert(row);
  // Forward-compatible: if the DB has not had the `geometry` column added yet,
  // publish the route without it rather than failing outright.
  if (error && isMissingGeometryColumn(error)) {
    const { geometry: _drop, ...withoutGeometry } = row;
    ({ error } = await db.from('routes').insert(withoutGeometry));
  }
  if (error) throw error;
}

function isMissingGeometryColumn(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST204' || /geometry/i.test(error.message ?? '');
}

/**
 * Simplified [lng, lat] geometries of every visible community route, for the
 * heatmap. Returns [] if the `geometry` column has not been added yet (so the
 * feature degrades quietly until the migration is applied).
 */
export async function fetchRouteGeometries(): Promise<LngLat[][]> {
  const { data, error } = await client()
    .from('routes')
    .select('geometry')
    .is('deleted_at', null)
    .not('geometry', 'is', null);
  if (error) return [];
  return ((data as { geometry: LngLat[] | null }[] | null) ?? [])
    .map((row) => row.geometry ?? [])
    .filter((geometry) => geometry.length > 1);
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

/**
 * Soft-deletes one of the current user's routes: it is hidden from the library
 * at once (the `routes_with_rating` view filters `deleted_at is null`), but the
 * row and any GPX file survive the grace period so the owner can change their
 * mind. `purgeExpiredRoutes` removes them for good afterwards.
 */
export async function softDeleteRoute(routeId: string): Promise<void> {
  const db = client();
  const userId = await currentUserId();
  if (!userId) throw new Error('Sign in first to delete a route.');
  const { error } = await db
    .from('routes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', routeId)
    .eq('owner_id', userId);
  if (error) throw error;
}

/**
 * Permanently removes the current user's routes whose grace period has passed,
 * along with their uploaded GPX files. Best-effort and non-fatal: called
 * opportunistically when the owner is signed in, so cleanup happens on their
 * next visit at or after the grace period.
 */
export async function purgeExpiredRoutes(): Promise<void> {
  const db = client();
  const userId = await currentUserId();
  if (!userId) return;
  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('routes')
    .select('id, gpx_path')
    .eq('owner_id', userId)
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);
  if (error) return; // e.g. the column does not exist yet; nothing to purge.
  for (const row of (data as { id: string; gpx_path: string | null }[] | null) ?? []) {
    if (row.gpx_path) {
      await db.storage.from('gpx-uploads').remove([row.gpx_path]);
    }
    await db.from('routes').delete().eq('id', row.id).eq('owner_id', userId);
  }
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

/** Public download URL for an uploaded GPX/TCX file, or null if unavailable. */
export function fileDownloadUrl(gpxPath: string): string | null {
  if (!supabase) return null;
  return supabase.storage.from('gpx-uploads').getPublicUrl(gpxPath).data.publicUrl;
}

function mapRow(row: RouteRow): CommunityRoute {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    authorName: row.author_name ?? null,
    waypoints: (row.waypoints ?? []) as LngLat[],
    bike: row.bike,
    traffic: row.traffic,
    closed: row.closed,
    distanceMeters: Number(row.distance_meters),
    ascendMeters: Number(row.ascend_meters),
    source: row.source,
    gpxPath: row.gpx_path,
    fileFormat: row.file_format ?? null,
    createdAt: row.created_at,
    avgRating: Number(row.avg_rating),
    ratingCount: Number(row.rating_count),
  };
}

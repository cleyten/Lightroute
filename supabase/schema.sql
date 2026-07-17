-- Lightmile community backend: routes library + star ratings + GPX/TCX uploads.
--
-- Run this once in the Supabase project's SQL editor (Dashboard > SQL Editor
-- > New query > paste > Run) after creating the project. It has not been run
-- against a live project yet — read it over before running, and re-run is
-- safe (uses `if not exists` / `on conflict do nothing` where it matters).
--
-- Design notes:
-- - Browsing the library is public (no sign-in) — the SELECT policies use
--   `using (true)`. Publishing, uploading and rating require a signed-in user
--   (auth.uid() checks), via Supabase's email magic-link auth.
-- - `waypoints` reuses the same compact [lng, lat] pair format already used
--   for share links (see src/share.ts) — the app recalculates the actual
--   route from these via BRouter, so this table never needs to store full
--   track geometry for planned/round-trip routes.
-- - Imported GPX or TCX routes additionally get their original file kept in
--   the `gpx-uploads` storage bucket (`gpx_path`; the bucket name predates TCX
--   support and is kept as-is to avoid churn, it just holds either format
--   now), so the exact ridden track can still be re-downloaded even though
--   `waypoints` only holds the simplified, editable version shown on the map.
--   `file_format` records which of the two it is, so the download link and
--   the upload's extension/content-type can be chosen correctly.
-- - One rating per person per route: route_ratings' primary key is
--   (route_id, user_id), so a second rating updates rather than stacks.

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  author_name text,
  waypoints jsonb not null,
  -- Simplified, elevation-stripped [lng, lat] track (~one point per 40 m),
  -- captured at publish time so the community heatmap can aggregate routes
  -- without re-routing every waypoint set. Nullable: older rows and any route
  -- published before this column existed simply do not contribute.
  geometry jsonb,
  bike text not null check (bike in ('race', 'gravel', 'mtb')),
  traffic smallint not null default 0 check (traffic in (0, 1, 2)),
  closed boolean not null default false,
  distance_meters numeric not null,
  ascend_meters numeric not null default 0,
  source text not null default 'planned' check (source in ('planned', 'imported')),
  gpx_path text,
  file_format text check (file_format in ('gpx', 'tcx')),
  created_at timestamptz not null default now(),
  -- Soft delete: set when the owner removes a route. The route is hidden from
  -- the library immediately, but the row and its GPX file are kept for a grace
  -- period (see purgeExpiredRoutes in src/community.ts) so a change of mind is
  -- recoverable, then permanently purged.
  deleted_at timestamptz
);

-- Additive migrations for projects created before these columns existed. Safe
-- to re-run: `add column if not exists` is a no-op once the column is present.
alter table routes add column if not exists author_name text;
alter table routes add column if not exists deleted_at timestamptz;
alter table routes add column if not exists file_format text check (file_format in ('gpx', 'tcx'));
alter table routes add column if not exists geometry jsonb;

create table if not exists route_ratings (
  route_id uuid not null references routes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (route_id, user_id)
);

-- Convenience view: each non-deleted route with its average rating and count.
-- Dropped first (not just `create or replace`): adding columns to `routes`
-- shifts the `r.*` column order, and `create or replace view` refuses to
-- rename/reorder existing view columns. The `where` hides soft-deleted routes
-- from every consumer that browses the library.
drop view if exists routes_with_rating;
create view routes_with_rating as
select
  r.*,
  coalesce(avg(rr.stars), 0)::numeric(3, 2) as avg_rating,
  count(rr.*) as rating_count
from routes r
left join route_ratings rr on rr.route_id = r.id
where r.deleted_at is null
group by r.id;

alter table routes enable row level security;
alter table route_ratings enable row level security;

drop policy if exists "routes are publicly readable" on routes;
create policy "routes are publicly readable"
  on routes for select
  using (true);

drop policy if exists "users can insert their own routes" on routes;
create policy "users can insert their own routes"
  on routes for insert
  with check (auth.uid() = owner_id);

drop policy if exists "owners can update their routes" on routes;
create policy "owners can update their routes"
  on routes for update
  using (auth.uid() = owner_id);

drop policy if exists "owners can delete their routes" on routes;
create policy "owners can delete their routes"
  on routes for delete
  using (auth.uid() = owner_id);

drop policy if exists "ratings are publicly readable" on route_ratings;
create policy "ratings are publicly readable"
  on route_ratings for select
  using (true);

drop policy if exists "users can rate as themselves" on route_ratings;
create policy "users can rate as themselves"
  on route_ratings for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can change their own rating" on route_ratings;
create policy "users can change their own rating"
  on route_ratings for update
  using (auth.uid() = user_id);

drop policy if exists "users can remove their own rating" on route_ratings;
create policy "users can remove their own rating"
  on route_ratings for delete
  using (auth.uid() = user_id);

-- Storage bucket for the original uploaded GPX files (public read, so anyone
-- browsing the library can download the exact ridden track).
insert into storage.buckets (id, name, public)
values ('gpx-uploads', 'gpx-uploads', true)
on conflict (id) do nothing;

drop policy if exists "gpx uploads are publicly readable" on storage.objects;
create policy "gpx uploads are publicly readable"
  on storage.objects for select
  using (bucket_id = 'gpx-uploads');

drop policy if exists "signed-in users can upload their own gpx" on storage.objects;
create policy "signed-in users can upload their own gpx"
  on storage.objects for insert
  with check (bucket_id = 'gpx-uploads' and auth.uid() = owner);

-- Owners can delete their own GPX files, so purging a route after the grace
-- period can also remove its stored track (not just the routes row).
drop policy if exists "owners can delete their own gpx" on storage.objects;
create policy "owners can delete their own gpx"
  on storage.objects for delete
  using (bucket_id = 'gpx-uploads' and auth.uid() = owner);

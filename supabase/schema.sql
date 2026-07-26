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

-- `using` only decides which rows may be targeted; `with check` decides what
-- they may become. Without it an owner could rewrite owner_id and hand their
-- route to (or pin it on) another account.
drop policy if exists "owners can update their routes" on routes;
create policy "owners can update their routes"
  on routes for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

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

-- Same reasoning as the routes update policy, but the consequence here is
-- rating inflation: without `with check` a user could reassign their own
-- rating row to someone else's user_id, freeing up the (route_id, user_id)
-- primary key to rate the same route again, over and over.
drop policy if exists "users can change their own rating" on route_ratings;
create policy "users can change their own rating"
  on route_ratings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users can remove their own rating" on route_ratings;
create policy "users can remove their own rating"
  on route_ratings for delete
  using (auth.uid() = user_id);

-- Storage bucket for the original uploaded GPX files (public read, so anyone
-- browsing the library can download the exact ridden track).
insert into storage.buckets (id, name, public)
values ('gpx-uploads', 'gpx-uploads', true)
on conflict (id) do nothing;

-- The bucket is public, so anything uploaded here is served from the project's
-- own domain with whatever content-type it was given. Without an allowlist that
-- makes it free hosting for arbitrary files, and without a size cap the 1 GB
-- free tier is a handful of uploads away from full. The client sets a
-- content-type in publishRoute(), but a hostile client simply would not.
update storage.buckets
  set file_size_limit = 5242880, -- 5 MB; a very long GPX track is well under this
      allowed_mime_types = array[
        'application/gpx+xml',
        'application/vnd.garmin.tcx+xml',
        'application/xml',
        'text/xml'
      ]
  where id = 'gpx-uploads';

drop policy if exists "gpx uploads are publicly readable" on storage.objects;
create policy "gpx uploads are publicly readable"
  on storage.objects for select
  using (bucket_id = 'gpx-uploads');

-- The folder check matters: publishRoute() writes to `<userId>/<uuid>.<ext>` by
-- convention, but only this policy makes that a rule. Without it a signed-in
-- user can litter someone else's prefix with files that the owner's own purge
-- pass will never clean up.
drop policy if exists "signed-in users can upload their own gpx" on storage.objects;
create policy "signed-in users can upload their own gpx"
  on storage.objects for insert
  with check (
    bucket_id = 'gpx-uploads'
    and auth.uid() = owner
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Owners can delete their own GPX files, so purging a route after the grace
-- period can also remove its stored track (not just the routes row).
drop policy if exists "owners can delete their own gpx" on storage.objects;
create policy "owners can delete their own gpx"
  on storage.objects for delete
  using (bucket_id = 'gpx-uploads' and auth.uid() = owner);

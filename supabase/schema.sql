-- Lightroute community backend: routes library + star ratings + GPX uploads.
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
-- - Imported GPX routes additionally get their original file kept in the
--   `gpx-uploads` storage bucket (`gpx_path`), so the exact ridden track can
--   still be re-downloaded even though `waypoints` only holds the
--   simplified, editable version shown on the map.
-- - One rating per person per route: route_ratings' primary key is
--   (route_id, user_id), so a second rating updates rather than stacks.

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  waypoints jsonb not null,
  bike text not null check (bike in ('race', 'gravel', 'mtb')),
  traffic smallint not null default 0 check (traffic in (0, 1, 2)),
  closed boolean not null default false,
  distance_meters numeric not null,
  ascend_meters numeric not null default 0,
  source text not null default 'planned' check (source in ('planned', 'imported')),
  gpx_path text,
  created_at timestamptz not null default now()
);

create table if not exists route_ratings (
  route_id uuid not null references routes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (route_id, user_id)
);

-- Convenience view: each route with its average rating and rating count.
create or replace view routes_with_rating as
select
  r.*,
  coalesce(avg(rr.stars), 0)::numeric(3, 2) as avg_rating,
  count(rr.*) as rating_count
from routes r
left join route_ratings rr on rr.route_id = r.id
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

# Handoff

Working notes for picking this up in a fresh session. Written 26 July 2026.

## Where things stand

All work is on branch **`worker-and-hardening`**, tip `1304426`, pushed.
**`origin/main` is deliberately untouched at `4743ba0`.** `origin/main` is an
ancestor of the branch, so `git push origin main` would be a clean fast-forward
whenever the branch is accepted. There is no PR open yet.

```
1304426  Add .claudeignore
24ae5a1  Split settings and state out of main.ts
2aa855c  Split dom, ui, dualRange and bottomSheet out of main.ts
7671e93  Remove the on-map paved/unpaved surface pill
adc8b7c  Merge origin/main: keep the redesign, restore two unpushed features
934043b  Move round-trip generation to a worker; split modules out of main.ts
b5f299f  Validate untrusted waypoints, harden storage paths, add a test suite
41a498d  Make progress visible, cancel stale routes, and close two RLS holes
```

Gates: `npx tsc --noEmit`, `npm test` (92 tests, vitest), `npx vite build`. All
clean at the tip. CI runs `npm test` before the build, so a red test blocks the
Pages deploy.

## The one thing that will confuse you: the divergence

`main` had diverged badly and this is the single most important piece of
context.

`origin/main` carried **34 commits** from base `977ae3d` that were never in the
local clone: the stylesheet rewritten into a design system, migration to
Cloudflare Pages/Workers, emailed-OTP sign-in replacing magic links, the
community heatmap, a mobile bottom tab bar, a theme toggle, and Save/Import/
Publish moved into the Community tab.

Meanwhile **three local commits had never been pushed** and the remote never
had them: the Chart.js/Supabase code-split, avoid-zone routing, and the heatmap
backfill script.

The merge (`adc8b7c`) resolved this by taking **their `main.ts` and `style.css`
wholesale** rather than reconciling twelve conflict hunks, because their bottom
sheet, slider and layout had since been fixed in ways the older local
extractions would have silently reverted. The avoid-zone feature and both
code-splits were then re-applied by hand on top.

Two consequences worth knowing:

- Anything you remember about `main.ts` from before `adc8b7c` is probably stale.
  Read the file.
- `scripts/backfill-geometry.mjs`, the `backfill:geometry` npm script and
  `VITE_USE_PROXY` are all **real and in use**, not dead code. An earlier review
  wrongly called them orphaned; they belong to the heatmap and the Cloudflare
  key proxy respectively.

## Architecture as it stands

`main.ts` is **2462 lines**, down from 2830. Six modules were extracted against
the merged file:

| Module | Owns |
| --- | --- |
| `dom.ts` | ~80 element handles, one place to see which ids the app depends on |
| `ui.ts` | status bar (`setStatus`/`setBusy`), `escapeHtml`, `initDisclosure`, `setActiveInGroup` |
| `state.ts` | the single shared mutable state object |
| `settings.ts` | persisted rider preferences, `currentProfile`, `syncProfileUi` |
| `dualRange.ts` | one min-max slider implementation, used by two callers |
| `bottomSheet.ts` | the mobile sheet, including the iOS foreground-restore |

Round-trip generation runs **off the main thread**: `roundtripClient.ts` spawns
`roundtrip.worker.ts`, which runs the whole `ors.ts` pipeline. This works
because `ors.ts` and everything it imports touch only `fetch` and plain data.
`surface.ts` does build DOM elements, but only in its renderer, which that path
never calls. There is an inline fallback for environments without module
workers, and it is verified to behave identically.

Code-splitting: `chart` (Chart.js), `supabase`, `ors` and the worker are all
separate chunks. `supabaseConfig.ts` exists specifically so
`isSupabaseConfigured` can be checked eagerly without pulling in the client;
it also carries the publicly-safe fallback URL and key so Cloudflare builds
without `VITE_SUPABASE_*` still work.

## Next task, and the decision it needs first

The **second half of the `main.ts` split** is the main open work:
`mapSetup`, `routeController`, `communityUi` (~400 lines), `poiPanels`,
`savedUi`, `searchUi`, `roundtripUi`, `waypointEditing`.

**Do not start this without agreeing an approach.** Unlike the first six, these
are mutually dependent: the map click handlers call `recalculateRoute`, which
calls render functions that touch the map. Three options were put to Clint:

1. **Pass dependencies into `init*()` functions**, the way
   `initCommunityFeature(auth, community)` already does. Explicit, keeps `tsc`
   useful, but signatures grow. *This was the recommendation.*
2. **Register callbacks** at startup (`onRouteChanged(fn)`). Looser, but harder
   to follow.
3. **Accept the ES-module cycle.** Works for hoisted function declarations but
   is fragile.

Clint had not chosen when the session ended.

## Other open work

- **Linter and formatter**: still none. `eslint` flat config with
  `typescript-eslint` plus `no-floating-promises` would be productive here
  (the codebase uses `void fn()` deliberately in ~15 places), and `prettier`
  matching the existing style (2-space, single quotes, 100 cols, trailing
  commas).
- `fetchCommunityRoutes` has **no `limit`**, and `renderCommunityList` fires one
  Photon reverse-geocode per route with no concurrency cap. With enough
  published routes that is a burst of requests at a free endpoint, and the
  failures are swallowed so cities just never appear.
- `refreshCommunity` has **no request-id guard** and is called from five places;
  two overlapping calls can leave the list ordered by the previous sort.
- The `gpx-uploads` bucket's `file_size_limit` and mime allowlist were written
  into `schema.sql` but **never confirmed applied**. `GET /storage/v1/bucket/
  gpx-uploads` returns 400 with the publishable key, so check via SQL
  (`select file_size_limit, allowed_mime_types from storage.buckets where
  id='gpx-uploads'`) or the dashboard. Expect `5242880` and four mime types.

## Done and confirmed, so do not redo

- **RLS holes closed.** Both `for update` policies were missing `with check`,
  which let a signed-in user reassign a rating row's `user_id` and rate the same
  route repeatedly, or hand a route to another account. Clint ran the migration
  and confirmed `with_check` is not null on both. `route_ratings` is empty, so
  the hole was never exploited.
- **Test-user feedback, all three points addressed.** Slow/invisible loading:
  the status line was the last element of a scrolling panel, so no mobile snap
  point could show it beside the button that started the work; it now floats
  over the map with a progress strip, BRouter requests cancel and time out, and
  round trips report per-candidate progress. Route re-validation: loading a
  saved or published route now reports when today's map data gives a different
  distance.
- **Komoot and Strava, researched and verified** (see the project memory entry
  `komoot-strava-hazards-and-route-updates`). Short version: neither warns about
  potholes; Komoot's warning list is terrain/passability only and Highlights are
  points of interest, not hazards. Komoot **does** re-validate saved routes at
  open/navigate time and rewrites them ("Route was updated"); Strava does not.
  Do not re-research this.

## Environment gotchas that cost real time

- **PowerShell 5.1 corrupts UTF-8 source files.** `Get-Content` reads as ANSI,
  so `Get-Content | Set-Content -Encoding utf8` turns en dashes and accents into
  mojibake and adds a BOM. It happened once and had to be repaired by
  re-encoding to Windows-1252 bytes and decoding as UTF-8. Use the Edit tool, or
  `[System.IO.File]::ReadAllLines/WriteAllLines` with `UTF8Encoding($false)`.
- **`git commit -F -` with a heredoc is not PowerShell** and fails to parse.
  Write the message to a file and use `git commit -F <file>`. Note also that
  `-m @'...'@` here-strings break when the message contains double quotes.
- **`requestAnimationFrame` does not fire when the Browser pane is hidden**, and
  `setInterval` clamps to ~1000ms. An idle control run with zero app work gave
  21/21 samples over 200ms. Always run an idle control before blaming code for
  timing spikes.
- **`getComputedStyle` can report stale transitioned values** in that pane.
  Verify via DOM state, `.matches()`, and geometry instead.
- **Screenshots time out** on the WebGL map. Verify with `read_page` /
  `javascript_tool`.
- Map clicks via the automation tools are unreliable; use
  `window.__lr.map.fire('click', {lngLat, point: map.project(lngLat), originalEvent:{}})`.
  `window.__lr` is dev-only.
- Dev server: `node node_modules/vite/bin/vite.js --port 5199 --strictPort`.
  Clint's own dev server is on 5173.

## Verification pattern that worked

For each extraction: `tsc` (with `noUnusedLocals` on, which proves the import
list is exactly right), then the 92 tests, then the build, then **one targeted
live check of the extracted behaviour**. Not just a build at the end.

To test the mobile sheet, force mobile by copying the `700px` media block into a
plain `<style>` tag **and** monkeypatching `matchMedia`, then dispatch synthetic
`pointerdown`/`pointerup` on `#sheet-handle`. Expect `half = round(h * 0.48)`,
`peek = h - 112`, `full = 0`.

## House style

Conversation with Clint is in Dutch; the app UI, code and comments are English.
No em-dashes anywhere in output. Clint has near-zero app-dev experience, so
explain the reasoning, not just the change. Commit only when asked. Nothing gets
pushed to `main` without saying so first.

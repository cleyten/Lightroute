# Deploying Lightmile to Cloudflare Pages

The app is a static Vite build, so Cloudflare Pages hosts it directly — no
server. GitHub Pages keeps working unchanged; this is an additional target.

## 1. Create the project

Cloudflare now defaults new git projects to the **Workers** flow (Workers
Static Assets). This repo supports it directly via `wrangler.jsonc`.

**Workers flow (what the dashboard gives you by default):**

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |

`wrangler.jsonc` tells `wrangler deploy` to serve `./dist` as static assets
with an SPA fallback. The base path resolves to `/` automatically because
Cloudflare Workers Builds sets `WORKERS_CI=1` (and Cloudflare Pages sets
`CF_PAGES=1`). GitHub Pages keeps `/Lightroute/`. If assets ever 404 with a
`/Lightroute/…` path, force it by setting the build command to
`BASE_PATH=/ npm run build`.

**Pages flow (alternative):** Create → Pages → Connect to Git, build command
`npm run build`, output directory `dist`, no deploy command. `wrangler.jsonc`
is ignored on this path; `_redirects`/`_headers` are used instead.

Node version is pinned to 22 via `.node-version`.

## 2. Environment variables

Add these under **Settings → Environment variables → Production** (and Preview
if you use preview deploys). They're read at build time by Vite.

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://ovqjrpyvceehnzqnluut.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_iZQZuuhzPQuCqW00EqnkJg_4De09xR1` |
| `VITE_ORS_KEY` | *(copy from GitHub repo → Settings → Secrets → `ORS_KEY`)* |
| `VITE_THUNDERFOREST_KEY` | *(copy from GitHub → Secrets → `THUNDERFOREST_KEY`)* |

The Supabase URL + anon key are safe to be public (they already ship in the
client bundle; row-level security protects the data). The ORS/Thunderforest
keys are the same ones the GitHub Actions build uses.

## 3. Custom domain

**Settings → Custom domains → Set up a domain.** If the domain is registered
with Cloudflare it's one click; otherwise add the CNAME/A records Cloudflare
shows you at your registrar. HTTPS is automatic.

## 4. ⚠️ Update Supabase auth redirect URLs (required for sign-in)

Magic-link sign-in redirects back to `window.location.origin`, which Supabase
only honours if the URL is allow-listed. **Sign-in will fail on the new domain
until you add it.**

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL**: your primary domain, e.g. `https://lightmile.com`
- **Redirect URLs**: add every origin you serve from, e.g.
  - `https://lightmile.com/**`
  - `https://<project>.pages.dev/**`
  - `https://cleyten.github.io/Lightroute/**` (keep if you still use GH Pages)
  - `http://localhost:5173/**` (local dev)

## Notes

- `public/_redirects` gives the SPA an index.html fallback.
- `public/_headers` sets long immutable caching for hashed assets and
  `no-cache` on the service worker so new deploys are picked up.
- Both files are ignored by GitHub Pages, so nothing changes there.

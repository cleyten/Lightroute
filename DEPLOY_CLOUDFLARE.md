# Deploying Lightmile to Cloudflare Pages

The app is a static Vite build, so Cloudflare Pages hosts it directly — no
server. GitHub Pages keeps working unchanged; this is an additional target.

## 1. Create the project

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → pick the `cleyten/Lightroute` repo.

Build settings:

| Setting | Value |
|---|---|
| Framework preset | None (or Vite) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Production branch | `main` |

`vite.config.ts` detects Cloudflare's `CF_PAGES=1` and sets the base path to
`/` automatically — no extra config needed. (GitHub Pages still gets
`/Lightroute/`.)

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

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
`npm run build`, output directory `dist`, no deploy command. On this path
`wrangler.jsonc` and the Worker are ignored, so the API-key proxy does NOT run
— use the Workers flow above if you want the keys kept server-side.

Node version is pinned to 22 via `.node-version`.

## 2. Environment variables

**The only thing you must set for Cloudflare are the two Worker secrets below.**
The client auto-detects the Cloudflare build: because no `VITE_ORS_KEY` /
`VITE_THUNDERFOREST_KEY` is baked in, it routes ORS + tile requests through the
same-origin `/api/*` Worker proxy, and the (public) Supabase URL + anon key are
compiled in as defaults. So **no build variables are required** — a plain
`npm run build` on Cloudflare produces a working, key-free bundle.

### Worker secrets — Settings → Variables and Secrets (type: Secret) — REQUIRED

| Secret | Value |
|---|---|
| `ORS_KEY` | *(from GitHub repo → Settings → Secrets → `ORS_KEY`)* |
| `THUNDERFOREST_KEY` | *(from GitHub → Secrets → `THUNDERFOREST_KEY`)* |

The Worker (`worker/index.ts`) injects these into the upstream requests, so the
keys stay server-side. You can also set them from the CLI:
`npx wrangler secret put ORS_KEY` and `npx wrangler secret put THUNDERFOREST_KEY`.

### Local preview of the proxy

`npm run preview:cf` builds with the proxy on and runs `wrangler dev`, which
serves the site + Worker locally. Put the two keys in a git-ignored
`.dev.vars` file first:

```
ORS_KEY=your-ors-key
THUNDERFOREST_KEY=your-thunderforest-key
```

(Plain `npm run dev` still works without the proxy, using build-time
`VITE_ORS_KEY` / `VITE_THUNDERFOREST_KEY` from a local `.env` as before.)

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

- SPA fallback (serve index.html for unknown paths) is handled by
  `not_found_handling: "single-page-application"` in `wrangler.jsonc` on the
  Workers flow. (A `_redirects` catch-all is rejected there as an infinite
  loop, so it is intentionally absent.)
- `public/_headers` sets long immutable caching for hashed assets and
  `no-cache` on the service worker so new deploys are picked up.
- Both files are ignored by GitHub Pages, so nothing changes there.

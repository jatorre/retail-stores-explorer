# Retail Stores Explorer — CARTO Hosted App demo

A small internal app deployed with **CARTO Hosted Apps**: a static Vite + TypeScript + deck.gl bundle that CARTO serves behind your organization's login and powers with a per-viewer token.

## How Hosted Apps work

1. `carto app deploy <dir>` uploads a static bundle (`index.html` at the root, ≤ 50 MB, ≤ 1000 files).
2. CARTO serves it at `https://workspace-<region>.app.carto.com/app/<slug>/`. Opening that URL from Workspace runs the org login and sets an app session.
3. The bundle reads `./carto-info.json` (served by CARTO next to it) to get `accessToken`, `apiBaseUrl`, `expiresAt` and the viewer's `user`. That token is the viewer's own CARTO credential, so the app sees exactly the data the viewer can see.
4. An optional `carto.json` manifest next to `index.html` declares the APIs the app uses and, optionally, backend connections with named sources / migrations that CARTO provisions on deploy.

`src/carto-session.ts` implements step 3 (with token refresh). In `vite dev`, the plugin in `vite.config.ts` serves the same file from your CARTO CLI profile token, so local development needs no `.env`.

## Commands

```bash
npm install
npm run dev              # http://localhost:5173 — uses your `carto auth login` token
npm run build            # tsc + vite build → dist/
npm run deploy           # build + carto app deploy dist --name "Retail Stores Explorer" --slug retail-stores-explorer

carto app list                                   # hosted apps you can see
carto app versions retail-stores-explorer        # deployed versions, which one is active
carto app rollback retail-stores-explorer --version <label>
carto app share retail-stores-explorer --org     # or --group <ids> / --user <ids> / --private
carto app delete retail-stores-explorer
```

The `carto app` group is hidden from `carto --help` while the feature is in private preview (CLI ≥ 0.11.0).

## Public build, deployed from GitHub Actions

The same bundle is also published **outside** the CARTO login at https://jatorre.github.io/retail-stores-explorer/. `.github/workflows/publish.yml` runs on every push to `main`:

1. build, and check that nothing credential-like ships in `dist/`;
2. log in to CARTO with an M2M OAuth client (the only secret, stored as `CARTO_CLI_M2M_CLIENT_ID` / `CARTO_CLI_M2M_CLIENT_SECRET`);
3. revoke the previous `app:retail-stores-explorer` token and mint a fresh one: one table grant, `sql,maps` only, referer-locked to the site URL (`index.html` carries `<meta name="referrer" content="no-referrer-when-downgrade">` so browsers send the full URL);
4. verify it (table → 200, raw SQL → 403), write `carto-info.json` next to the bundle, deploy to GitHub Pages.

The app code is identical in both deployments; only the `carto-info.json` next to it differs (per-viewer token inside CARTO, scoped public token outside). Pull requests run the build and hygiene check only. See `docs/publish-design.md` for the design and the measurements behind it.

## Data

`carto-demo-data.demo_tables.retail_stores` on the `carto_dw` connection: 11,966 US stores with `storetype`, `revenue`, `size_m2`, address fields and a point `geom`.

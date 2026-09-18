# Design note: publishing CARTO apps outside the org login

Context: `carto app deploy` (CLI ≥ 0.11.0, hidden group) hosts a static bundle behind the org login and
injects a per-viewer token via `./carto-info.json`. This note covers making the same bundle public.

## Facts established (2026-09-18, team org)

- API Access Tokens are public by design. Safety = scoping, enforced server-side. Docs: "This token will be
  public so you need to guarantee it has limited access to the resources of your public application."
- For the **Maps API and widget model endpoints**, a grant is a **table** (`connection_name` + table FQN).
- For the **SQL API**, a grant is a **statement**: `source` is matched against the query text, whitespace
  normalized. Table names and wildcard patterns return 403 for raw SQL.
- An exact **parameterized INSERT** grant executes only that INSERT with bound params (200) and nothing else
  (SELECT/UPDATE/DELETE/CREATE/DROP/other tables all 403). Controlled public writes need no secret.
- What a public token cannot provide is identity. Per-user attribution or row-level rules need a login
  (CARTO hosting, SPA OAuth client) or a backend with M2M.
- `carto app deploy` already never handles a storage credential: `POST /app/deploy` returns signed upload
  URLs, the CLI PUTs files, then `POST /app/_apps/<slug>/finalize`. CARTO's backend owns the bucket secret.

## Verbs

- `carto app deploy <dir>`   internal. Org login, per-viewer token. (exists)
- `carto app check <dir>`    read-only safety report + exit code. CI friendly.
- `carto app publish <dir> [--to carto|folder|vercel|firebase|gcs|cloudflare|github]`
                             public. Prepare (mint least-privilege token, verify by replay, write
                             carto-info.json) then hand off to the target's own CLI.
  `--to carto` (default)     public CARTO hosting via the existing signed-URL flow, separate public origin.
  `--to folder --out <dir>`  just produce the host-agnostic folder.
  `--dry-run`                run check + show grants, mint nothing.

`deploy` = internal, `publish` = public, mirroring `carto maps publish`.

## What "prepare" does (the clean-up)

1. Inputs: `carto.json` (apis, connections, named sources, statements) or a recording from `carto app dev`
   (proxy that logs every Maps/SQL call during local development and writes the manifest).
2. Classify: table sources → green; exact read statements → green; exact parameterized writes → amber
   (requires `--allow-writes`, forces expiry); dynamic SQL → red (not enumerable; needs login instead).
3. Enforce: `apis ⊆ {sql, maps}`; no `imports|lds|ai`; scan bundle for JWT-like strings / .env / secrets in
   source maps; refuse if found.
4. Mint: one token, grants = exactly the classified set, referer = target origin, expiry if writes.
5. Verify: replay allowed calls against the new token (expect 200) and probe forbidden ones (expect 403).
6. Emit: `<out>/carto-info.json` `{schemaVersion, accessToken, apiBaseUrl}` + per-host header rule so the
   file is served `no-store` (vercel.json / firebase.json / _headers / gsutil setmeta; GH Pages: none, the
   app fetches with cache:'no-store' anyway).
7. Register the publication in CARTO (target, url, token id, version) so `app list`/`versions`/`rollback`
   work and `app delete` revokes the token.

## Target adapters

| target     | tool     | final URL known before deploy?               | no-store header      |
|------------|----------|----------------------------------------------|----------------------|
| carto      | none     | yes (CARTO-controlled)                       | server               |
| vercel     | vercel   | project alias yes; preview URL no            | vercel.json          |
| firebase   | firebase | `<site>.web.app` yes                         | firebase.json        |
| gcs        | gcloud   | `storage.googleapis.com/<bucket>/...` yes    | gsutil setmeta       |
| cloudflare | wrangler | `<project>.pages.dev` yes                    | _headers             |
| github     | gh       | `<user>.github.io/<repo>/` yes               | n/a                  |

If the URL is not known up front: publish once without referer, then `publish --update-referer <url>` rotates
the token. Adapters detect the installed CLI and print the exact command they run.

## Public CARTO hosting (`--to carto`)

Same upload flow as today; the differences are serving-side: no `_session` gate, `carto-info.json` generated
at finalize by the backend from the manifest grants (CLI mints nothing), a **separate public origin** per app
(never under `workspace-*.app.carto.com`, which shares origin with Workspace), CDN cache headers, quota and
abuse controls, custom domain later.

## Referer lock: measured behaviour (2026-09-18)

- Enforcement triggers only when the request carries an `Origin` header (browser CORS). Non-browser clients
  are never blocked; the token is public anyway, so this is by design.
- When triggered, the **Referer** URL is matched against the patterns (full URL, prefix + `*`), with `Origin`
  as fallback when no Referer is sent. Path-level patterns work: on a fresh token,
  `https://jatorre.github.io/other-site/` and `https://jatorre.github.io/` → 403,
  `https://jatorre.github.io/retail-stores-explorer/` → 200.
- Browsers send only the origin as Referer by default (`strict-origin-when-cross-origin`), so a path-locked
  pattern needs the page to opt in: `<meta name="referrer" content="no-referrer-when-downgrade">`.
  `publish` should add that tag (or warn) whenever the pattern has a path, e.g. GitHub Pages project sites.
- There is a short positive authorization cache keyed by (token, Origin): after one 200, other Referers from
  the same Origin pass for a while. The `check`/verify replay must run the deny probes **before** the allow
  probes, or use a fresh token, or it will report false positives.

## CI (GitHub Actions) — measured 2026-09-18 with a throwaway M2M client

- `carto auth login --m2m` from a clean HOME works with `CARTO_CLI_M2M_CLIENT_ID/SECRET`; `auth whoami` returns 404
  "User not found" for an M2M identity (expected, cosmetic).
- `app check` (offline) and `app package --out … --url …` work as M2M: token minted, replay 200 / probe 403,
  `carto-info.json` written, `<meta name="referrer">` injected for the path-locked pattern.
- **Ownership**: a token minted by an M2M client is attributed to the client's creating user (`user_id` = the
  human who created the client). It is listed under that user and **survives deletion of the M2M client**
  (still 200 after the client was removed). Revoke tokens explicitly; deleting the client is not enough.
- **Not idempotent yet**: a second `app package` with the same slug fails with
  `400 This token name already exists (app:<slug>)`. Token names are unique per account and `upsert_key` is
  ignored by the API, so `package` must list → revoke the same-named token → mint (or use the server-side
  registry) before CI re-runs can work.
- **`app deploy` as M2M fails**: workspace-api 500 `null value in column "user_id" of relation "hosted_apps"`.
  Internal deploys from CI need the server to accept a service identity as owner (or a `--owner` user).
- Pipeline shape that works today: PR → `app check`; push → build → `app package` → native Pages actions
  (`configure-pages` / `upload-pages-artifact` / `deploy-pages`). Only secret: the M2M client.

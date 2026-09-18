import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Dev-only: emulate the `carto-info.json` that CARTO Hosted Apps serves next to
 * the deployed bundle. Reads the token of the current CARTO CLI profile
 * (~/.carto_credentials.json) at request time, so no secret is written to disk
 * inside the project. Never bundled — `apply: 'serve'` limits it to `vite dev`.
 *
 * Override the profile with CARTO_PROFILE=<name> and the API base with
 * CARTO_API_BASE_URL=<url> if the tenant is not <tenant_id>.api.carto.com.
 */
function cartoDevSession(): Plugin {
  return {
    name: 'carto-dev-session',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split('?')[0] !== '/carto-info.json') return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        try {
          const creds = JSON.parse(readFileSync(join(homedir(), '.carto_credentials.json'), 'utf-8'));
          const profileName: string = process.env.CARTO_PROFILE || creds.current_profile;
          const profile = creds.profiles?.[profileName];
          if (!profile?.token) {
            throw new Error(`No token for CARTO CLI profile "${profileName}". Run: carto auth login`);
          }
          const apiBaseUrl = process.env.CARTO_API_BASE_URL || `https://${profile.tenant_id}.api.carto.com`;
          res.end(
            JSON.stringify({
              schemaVersion: 1,
              accessToken: profile.token,
              apiBaseUrl,
              user: { id: 'dev', email: profile.user_email, accountId: profile.organization_id },
              devProfile: profileName,
            }),
          );
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
    },
  };
}

export default defineConfig({
  // Hosted Apps serve the bundle under /app/<slug>/ — relative asset URLs keep it portable.
  base: './',
  plugins: [cartoDevSession()],
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});

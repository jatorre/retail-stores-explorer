/**
 * CARTO Hosted Apps session.
 *
 * When a bundle is deployed with `carto app deploy`, CARTO serves it at
 * https://workspace-<region>.app.carto.com/app/<slug>/ behind the organization's
 * login and exposes a per-viewer credential file next to it: `./carto-info.json`.
 *
 *   {
 *     "schemaVersion": 1,
 *     "accessToken": "<per-viewer token>",
 *     "apiBaseUrl":  "https://<region>.api.carto.com",
 *     "aiBaseUrl":   "https://...",
 *     "expiresAt":   1789818124,            // unix seconds
 *     "user": { "id": "...", "email": "...", "accountId": "ac_..." }
 *   }
 *
 * In `vite dev`, the same path is served by the plugin in vite.config.ts using the
 * CARTO CLI profile token, so the app runs locally with zero configuration.
 */

export interface CartoUser {
  id: string;
  email: string;
  accountId: string;
}

export interface CartoSession {
  schemaVersion?: number;
  accessToken: string;
  apiBaseUrl: string;
  aiBaseUrl?: string;
  /** Unix seconds. Absent in local dev and in public builds. */
  expiresAt?: number;
  /** The viewer inside CARTO hosting; `null` in a public build (carto app publish), absent in local dev. */
  user?: CartoUser | null;
  devProfile?: string;
}

export class HostedAppSessionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'HostedAppSessionError';
  }
}

export async function loadCartoSession(): Promise<CartoSession> {
  let res: Response;
  try {
    res = await fetch('./carto-info.json', { credentials: 'include', cache: 'no-store' });
  } catch (err) {
    throw new HostedAppSessionError(`Could not reach carto-info.json: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new HostedAppSessionError(`carto-info.json returned HTTP ${res.status}`, res.status);
  }
  const info = (await res.json()) as Partial<CartoSession> & { error?: string };
  if (info.error) throw new HostedAppSessionError(info.error);
  if (!info.accessToken || !info.apiBaseUrl) {
    throw new HostedAppSessionError('carto-info.json is missing accessToken or apiBaseUrl');
  }
  return info as CartoSession;
}

/**
 * Re-fetch the credential file shortly before the token expires and hand the
 * fresh session to `onRefresh`. Returns a disposer.
 */
export function scheduleSessionRefresh(
  session: CartoSession,
  onRefresh: (next: CartoSession) => void,
  skewMs = 60_000,
): () => void {
  if (!session.expiresAt) return () => {};
  const delay = Math.max(5_000, session.expiresAt * 1000 - Date.now() - skewMs);
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(async () => {
    try {
      const next = await loadCartoSession();
      onRefresh(next);
      timer = undefined;
      dispose = scheduleSessionRefresh(next, onRefresh, skewMs);
    } catch (err) {
      console.warn('[carto-session] refresh failed', err);
    }
  }, delay);
  let dispose = () => {
    if (timer) clearTimeout(timer);
  };
  return () => dispose();
}

import { sendRendererIpc } from '../shared/ipc-contract';
import type { BrowserWindow } from 'electron';
import { isCommunityBuild } from './distribution';
import { getDb } from './ipc/database';
import { getWebBaseUrl } from './auth/auth-config';
import { trackAllowedEvent } from './analytics';
import {
  betaAttributionAnalyticsProperties,
  BETA_ATTRIBUTION_SETTING_KEY,
  normalizeBetaAttribution,
} from '../shared/beta-attribution';

const ATTRIBUTION_HOST = 'beta-attribution';
const ALLOWED_SCHEMES = ['dnaforge', 'dnaforge-beta', 'dnaforge-dev'];
const CODE_RE = /^[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{43}$/;

export function isBetaAttributionUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    return ALLOWED_SCHEMES.includes(scheme) && parsed.hostname.toLowerCase() === ATTRIBUTION_HOST;
  } catch {
    return false;
  }
}

function parseBetaAttributionCode(url: string): string | null {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (!ALLOWED_SCHEMES.includes(scheme)) return null;
    if (parsed.hostname.toLowerCase() !== ATTRIBUTION_HOST) return null;
    const code = parsed.searchParams.get('code')?.trim();
    return code && CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

export async function handleBetaAttributionUrl(
  url: string,
  mainWindow?: BrowserWindow | null
): Promise<void> {
  const code = parseBetaAttributionCode(url);
  if (!code || isCommunityBuild()) return;

  let response: Response;
  try {
    response = await fetch(`${getWebBaseUrl()}/api/beta-attribution/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    console.warn('[BetaAttribution] Failed to exchange attribution code:', err);
    return;
  }

  if (!response.ok) {
    console.warn('[BetaAttribution] Attribution exchange rejected:', response.status);
    return;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.warn('[BetaAttribution] Attribution exchange returned invalid JSON');
    return;
  }

  if (!body || typeof body !== 'object') {
    console.warn('[BetaAttribution] Attribution exchange returned invalid shape');
    return;
  }

  const attribution = normalizeBetaAttribution({ ...body, connected_at: Date.now() });
  if (!attribution) {
    console.warn('[BetaAttribution] Attribution exchange returned invalid shape');
    return;
  }

  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    BETA_ATTRIBUTION_SETTING_KEY,
    JSON.stringify(attribution),
    Date.now()
  );

  trackAllowedEvent('beta_install_attributed', {
    feature_area: 'lifecycle',
    ...betaAttributionAnalyticsProperties(attribution),
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    sendRendererIpc(mainWindow.webContents, 'analytics:beta-attribution-updated');
  }
}

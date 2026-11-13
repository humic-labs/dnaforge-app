import { app } from 'electron';
import { getDb } from '../ipc/database';
import { readBetaUpdatesSetting } from '../update-preferences';
import { isMacTeamIdCutoverBuild } from '../update-authority';
import { canonicalizeWebApiOrigin } from './web-api-origin';

export type AuthChannel = 'stable' | 'beta' | 'dev';
export type RedirectScheme = 'dnaforge' | 'dnaforge-beta' | 'dnaforge-dev';

const PACKAGED_AUTH_MARKER_PREFIX = 'DNAFORGE_PACKAGED_AUTH=';
const PACKAGED_AUTH_MARKER_SUFFIX = '::DESKTOP_AUTH_AUTHORITY_V1::END';
const RELEASE_A_AUTH_ORIGIN = 'https://dnaforge.com';
const CANARY_PROXY_TOKEN_RE = /^[a-f0-9]{64}$/;
const CANARY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PACKAGED_CANARY_AUTH_MARKER =
  'DNAFORGE_PACKAGED_CANARY_AUTH=loopback::TELEMETRY_CANARY_AUTH_V1::END';

export interface PackagedAuthAuthority {
  readonly origin: string;
  readonly marker: string;
}

function canonicalHttpsOrigin(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== raw
  ) {
    return null;
  }
  return parsed.origin;
}

export function resolvePackagedAuthOrigin(authority: PackagedAuthAuthority): string {
  const origin = canonicalHttpsOrigin(authority.origin);
  if (!origin) throw new Error('Packaged auth authority has a non-canonical HTTPS origin.');

  const releaseAMarker =
    `${PACKAGED_AUTH_MARKER_PREFIX}release-a::ORIGIN=${RELEASE_A_AUTH_ORIGIN}` +
    PACKAGED_AUTH_MARKER_SUFFIX;
  if (authority.marker === releaseAMarker && origin === RELEASE_A_AUTH_ORIGIN) return origin;

  const releaseBMarker =
    `${PACKAGED_AUTH_MARKER_PREFIX}release-b::ORIGIN=${origin}` + PACKAGED_AUTH_MARKER_SUFFIX;
  if (authority.marker === releaseBMarker && origin !== RELEASE_A_AUTH_ORIGIN) return origin;

  throw new Error('Packaged auth authority marker and origin do not agree.');
}

function bakedPackagedAuthAuthority(): PackagedAuthAuthority {
  return {
    origin:
      typeof __DNAFORGE_PACKAGED_AUTH_ORIGIN__ === 'string'
        ? __DNAFORGE_PACKAGED_AUTH_ORIGIN__
        : '',
    marker:
      typeof __DNAFORGE_PACKAGED_AUTH_MARKER__ === 'string'
        ? __DNAFORGE_PACKAGED_AUTH_MARKER__
        : '',
  };
}

const SCHEME_BY_CHANNEL: Record<AuthChannel, RedirectScheme> = {
  stable: 'dnaforge',
  beta: 'dnaforge-beta',
  dev: 'dnaforge-dev',
};

export function getAuthChannel(): AuthChannel {
  if (!app.isPackaged) return 'dev';
  if (isMacTeamIdCutoverBuild()) return 'stable';
  try {
    if (readBetaUpdatesSetting(getDb())) return 'beta';
  } catch {}
  return 'stable';
}

export function getRedirectScheme(channel: AuthChannel = getAuthChannel()): RedirectScheme {
  return SCHEME_BY_CHANNEL[channel];
}

function loopbackAuthOrigin(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  if (
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '::1'
  ) {
    return null;
  }
  return parsed.origin;
}

function packagedCanaryLoopbackAuthOrigin(): string | null {
  const token = process.env.DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN ?? '';
  const canaryId = process.env.DNAFORGE_TELEMETRY_CANARY_ID ?? '';
  if (!CANARY_PROXY_TOKEN_RE.test(token) || !CANARY_ID_RE.test(canaryId)) return null;
  const override = process.env.WAYPOINT_WEB_BASE_URL?.trim();
  if (!override) return null;
  const origin = loopbackAuthOrigin(`${override.replace(/\/+$/, '')}/`);
  if (!origin) return null;
  return origin + PACKAGED_CANARY_AUTH_MARKER.slice(origin.length, origin.length);
}

export function getDesktopApiBaseUrl(channel: AuthChannel = getAuthChannel()): string {
  return canonicalizeWebApiOrigin(getWebBaseUrl(channel));
}

export function getWebBaseUrl(channel: AuthChannel = getAuthChannel()): string {
  if (channel === 'dev') {
    const override = process.env.WAYPOINT_WEB_BASE_URL?.trim();
    if (override) return override.replace(/\/+$/, '');
    return resolvePackagedAuthOrigin(bakedPackagedAuthAuthority());
  }
  const canaryLoopback = packagedCanaryLoopbackAuthOrigin();
  if (canaryLoopback) return canaryLoopback;
  return resolvePackagedAuthOrigin(bakedPackagedAuthAuthority());
}

export interface ResolvedAuthConfig {
  channel: AuthChannel;
  redirectScheme: RedirectScheme;
  webBaseUrl: string;
}

export function resolveAuthConfig(): ResolvedAuthConfig {
  const channel = getAuthChannel();
  return {
    channel,
    redirectScheme: getRedirectScheme(channel),
    webBaseUrl: getWebBaseUrl(channel),
  };
}

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ packaged: false, beta: false, bridge: false, dbReads: 0 }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.packaged;
    },
  },
}));
vi.mock('../../ipc/database', () => ({
  getDb: () => {
    h.dbReads += 1;
    return {};
  },
}));
vi.mock('../../update-preferences', () => ({ readBetaUpdatesSetting: () => h.beta }));
vi.mock('../../update-authority', () => ({ isMacTeamIdCutoverBuild: () => h.bridge }));

import {
  getAuthChannel,
  getDesktopApiBaseUrl,
  getRedirectScheme,
  getWebBaseUrl,
  resolvePackagedAuthOrigin,
  resolveAuthConfig,
  PACKAGED_CANARY_AUTH_MARKER,
} from '../auth-config';

const RELEASE_A_ORIGIN = 'https://dnaforge.com';
const RELEASE_A_MARKER =
  'DNAFORGE_PACKAGED_AUTH=release-a::ORIGIN=https://dnaforge.com::DESKTOP_AUTH_AUTHORITY_V1::END';
const RELEASE_B_ORIGIN = 'https://hosted-ai-gateway-staging.up.railway.app';
const RELEASE_B_MARKER =
  'DNAFORGE_PACKAGED_AUTH=release-b::ORIGIN=https://hosted-ai-gateway-staging.up.railway.app::DESKTOP_AUTH_AUTHORITY_V1::END';

beforeEach(() => {
  h.packaged = false;
  h.beta = false;
  h.bridge = false;
  h.dbReads = 0;
  delete process.env.WAYPOINT_WEB_BASE_URL;
  delete process.env.DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN;
  delete process.env.DNAFORGE_TELEMETRY_CANARY_ID;
  vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_ORIGIN__', RELEASE_A_ORIGIN);
  vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_MARKER__', RELEASE_A_MARKER);
});

describe('auth-config channel/scheme/web-url resolution', () => {
  it('unpackaged uses the real-account service without requiring a local web server', () => {
    const c = resolveAuthConfig();
    expect(c.channel).toBe('dev');
    expect(c.redirectScheme).toBe('dnaforge-dev');
    expect(c.webBaseUrl).toBe(RELEASE_A_ORIGIN);
    expect(getDesktopApiBaseUrl()).toBe('https://www.dnaforge.com');
  });

  it('unpackaged Release B pairs sign-in with the build-selected Hosted gateway proxy', () => {
    vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_ORIGIN__', RELEASE_B_ORIGIN);
    vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_MARKER__', RELEASE_B_MARKER);
    expect(resolveAuthConfig()).toEqual({
      channel: 'dev',
      redirectScheme: 'dnaforge-dev',
      webBaseUrl: RELEASE_B_ORIGIN,
    });
    expect(getDesktopApiBaseUrl()).toBe(RELEASE_B_ORIGIN);
  });

  it('uses an explicitly configured local test-account service without changing the dev channel', () => {
    process.env.WAYPOINT_WEB_BASE_URL = 'http://127.0.0.1:4321/';
    expect(resolveAuthConfig()).toEqual({
      channel: 'dev',
      redirectScheme: 'dnaforge-dev',
      webBaseUrl: 'http://127.0.0.1:4321',
    });
    expect(getDesktopApiBaseUrl()).toBe('http://127.0.0.1:4321');
  });

  it('packaged + beta flag → beta / dnaforge-beta / PROD web (shared Supabase project)', () => {
    h.packaged = true;
    h.beta = true;
    expect(getAuthChannel()).toBe('beta');
    expect(getRedirectScheme()).toBe('dnaforge-beta');
    expect(getWebBaseUrl()).toBe('https://dnaforge.com');
    expect(getDesktopApiBaseUrl()).toBe('https://www.dnaforge.com');
  });

  it('packaged + no beta → stable / dnaforge / prod web', () => {
    h.packaged = true;
    h.beta = false;
    expect(getAuthChannel()).toBe('stable');
    expect(getRedirectScheme()).toBe('dnaforge');
    expect(getWebBaseUrl()).toBe('https://dnaforge.com');
    expect(getDesktopApiBaseUrl()).toBe('https://www.dnaforge.com');
  });

  it('packaged Team ID bridge uses stable without opening the database', () => {
    h.packaged = true;
    h.bridge = true;
    h.beta = true;
    expect(getAuthChannel()).toBe('stable');
    expect(getWebBaseUrl()).toBe('https://dnaforge.com');
    expect(h.dbReads).toBe(0);
  });

  it('WAYPOINT_WEB_BASE_URL overrides dev only (trailing slash stripped)', () => {
    process.env.WAYPOINT_WEB_BASE_URL = 'https://staging.dnaforge.com/';
    expect(getWebBaseUrl('dev')).toBe('https://staging.dnaforge.com');
  });

  it.each(['stable', 'beta'] as const)(
    'packaged %s ignores a hostile runtime web-origin override',
    (channel) => {
      process.env.WAYPOINT_WEB_BASE_URL = 'https://hostile.invalid/';
      expect(getWebBaseUrl(channel)).toBe('https://dnaforge.com');
    }
  );

  it('routes packaged Release B auth through its exact sealed gateway proxy', () => {
    expect(resolvePackagedAuthOrigin({ origin: RELEASE_B_ORIGIN, marker: RELEASE_B_MARKER })).toBe(
      RELEASE_B_ORIGIN
    );
    h.packaged = true;
    vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_ORIGIN__', RELEASE_B_ORIGIN);
    vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_MARKER__', RELEASE_B_MARKER);
    expect(resolveAuthConfig().webBaseUrl).toBe(RELEASE_B_ORIGIN);
  });

  it.each([
    { origin: RELEASE_B_ORIGIN, marker: RELEASE_A_MARKER },
    { origin: RELEASE_A_ORIGIN, marker: RELEASE_B_MARKER },
    { origin: 'http://hosted.invalid', marker: RELEASE_B_MARKER },
    { origin: RELEASE_B_ORIGIN, marker: `${RELEASE_B_MARKER} ` },
    { origin: '', marker: '' },
  ])('fails closed on contradictory packaged auth authority %#', (authority) => {
    expect(() => resolvePackagedAuthOrigin(authority)).toThrow(/packaged auth authority/i);
  });

  it('ignores a hostile runtime override for Release B too', () => {
    process.env.WAYPOINT_WEB_BASE_URL = 'https://hostile.invalid/';
    h.packaged = true;
    vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_ORIGIN__', RELEASE_B_ORIGIN);
    vi.stubGlobal('__DNAFORGE_PACKAGED_AUTH_MARKER__', RELEASE_B_MARKER);
    expect(getWebBaseUrl('stable')).toBe(RELEASE_B_ORIGIN);
  });

  it('lets the signed-artifact canary use a loopback auth origin', () => {
    h.packaged = true;
    process.env.DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN = 'a'.repeat(64);
    process.env.DNAFORGE_TELEMETRY_CANARY_ID = '11111111-1111-4111-8111-111111111111';
    process.env.WAYPOINT_WEB_BASE_URL = 'http://127.0.0.1:4321/';
    expect(getWebBaseUrl('stable')).toBe('http://127.0.0.1:4321');
    expect(getWebBaseUrl('beta')).toBe('http://127.0.0.1:4321');
    expect(getDesktopApiBaseUrl('stable')).toBe('http://127.0.0.1:4321');
    expect(PACKAGED_CANARY_AUTH_MARKER).toBe(
      'DNAFORGE_PACKAGED_CANARY_AUTH=loopback::TELEMETRY_CANARY_AUTH_V1::END'
    );
  });

  it.each([
    {
      name: 'missing canary token',
      token: undefined,
      canaryId: '11111111-1111-4111-8111-111111111111',
      url: 'http://127.0.0.1:4321',
    },
    {
      name: 'missing canary id',
      token: 'a'.repeat(64),
      canaryId: undefined,
      url: 'http://127.0.0.1:4321',
    },
    {
      name: 'remote origin even with canary credentials',
      token: 'a'.repeat(64),
      canaryId: '11111111-1111-4111-8111-111111111111',
      url: 'https://hostile.invalid',
    },
    {
      name: 'loopback origin with a path',
      token: 'a'.repeat(64),
      canaryId: '11111111-1111-4111-8111-111111111111',
      url: 'http://127.0.0.1:4321/steal',
    },
  ])('keeps packaged auth sealed for $name', ({ token, canaryId, url }) => {
    h.packaged = true;
    if (token) process.env.DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN = token;
    if (canaryId) process.env.DNAFORGE_TELEMETRY_CANARY_ID = canaryId;
    process.env.WAYPOINT_WEB_BASE_URL = url;
    expect(getWebBaseUrl('stable')).toBe(RELEASE_A_ORIGIN);
  });
});

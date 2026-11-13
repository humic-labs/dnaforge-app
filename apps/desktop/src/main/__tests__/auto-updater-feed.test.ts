import { describe, it, expect, vi } from 'vitest';

vi.mock('electron-updater', () => ({
  default: { autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } },
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() },
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: true, on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import {
  isUpdateOriginFailoverEligible,
  isAutoUpdateSupportedIdentity,
  shouldDisableAutoUpdaterForMacTeamIdCutover,
  resolveUpdateFeedUrl,
  resolveUpdateFeedUrls,
  isValidationAppIdentity,
} from '../update-authority';

describe('resolveUpdateFeedUrl  auto-update feed)', () => {
  it('recognizes only the separately packaged validation application identity', () => {
    expect(isValidationAppIdentity({ isPackaged: true, appName: 'DNAForge' })).toBe(false);
    expect(isValidationAppIdentity({ isPackaged: false, appName: 'DNAForge Validation' })).toBe(
      false
    );
    expect(isValidationAppIdentity({ isPackaged: true, appName: 'DNAForge Validation' })).toBe(
      true
    );
  });

  it('keeps both normal and recovery updater entry points inert for unsupported identities', () => {
    expect(
      isAutoUpdateSupportedIdentity({
        isPackaged: true,
        appName: 'DNAForge Validation',
        platform: 'win32',
      })
    ).toBe(false);
    expect(
      shouldDisableAutoUpdaterForMacTeamIdCutover({
        macTeamIdCutoverEnabled: true,
        platform: 'darwin',
      })
    ).toBe(true);
    expect(
      isAutoUpdateSupportedIdentity({
        isPackaged: true,
        appName: 'DNAForge',
        platform: 'win32',
      })
    ).toBe(true);
  });

  it('builds the per-arch R2 generic channel URL from the baked base', () => {
    expect(resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com', arch: 'arm64' })).toBe(
      'https://cdn.example.com/humic/updates/stable/arm64'
    );
    expect(resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com', arch: 'x64' })).toBe(
      'https://cdn.example.com/humic/updates/stable/x64'
    );
  });

  it('preserves the ordered redundant authorities for each supported architecture', () => {
    expect(
      resolveUpdateFeedUrls({
        feedBases: ['https://primary.example.com', 'https://mirror.example.net'],
        arch: 'arm64',
      })
    ).toEqual([
      'https://primary.example.com/humic/updates/stable/arm64',
      'https://mirror.example.net/humic/updates/stable/arm64',
    ]);
  });

  it('preserves a canonical path prefix on the independent mirror base', () => {
    expect(
      resolveUpdateFeedUrl({
        feedBase: 'https://humic-labs.github.io/dnaforge-update-mirror',
        arch: 'arm64',
      })
    ).toBe('https://humic-labs.github.io/dnaforge-update-mirror/humic/updates/stable/arm64');
  });

  it('rejects duplicate and unsupported update authorities instead of degrading redundancy', () => {
    expect(() =>
      resolveUpdateFeedUrls({
        feedBases: ['https://primary.example.com', 'https://primary.example.com/'],
        arch: 'arm64',
      })
    ).toThrow(/unique/i);
    expect(() =>
      resolveUpdateFeedUrls({
        feedBases: ['https://primary.example.com', 'https://mirror.example.net'],
        arch: 'ia32',
      })
    ).toThrow(/unsupported architecture/i);
  });

  it.each([
    'getaddrinfo ENOTFOUND primary.example.com',
    'connect ETIMEDOUT primary.example.com',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_SOCKET_NOT_CONNECTED',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_CONNECTION_ABORTED',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_CONNECTION_FAILED',
    'net::ERR_TIMED_OUT',
    'HTTP Error 503: Service Unavailable',
    'Cannot find channel latest-mac.yml in the latest release artifacts',
    'YAMLException: bad indentation of a mapping entry',
    'sha512 checksum mismatch while downloading payload',
  ])('allows infrastructure failover for %s', (message) => {
    expect(isUpdateOriginFailoverEligible(new Error(message))).toBe(true);
  });

  it.each([
    'new version 0.8.3 is not signed by the application owner',
    'code signature at URL did not pass validation',
    'update is not supported on this system',
    'downgrade is disallowed',
    'publisherName verification failed',
    'signature verification failed after net::ERR_CONNECTION_RESET',
  ])('never hides a security or compatibility refusal behind failover: %s', (message) => {
    expect(isUpdateOriginFailoverEligible(new Error(message))).toBe(false);
  });

  it.each(['net::ERR_FAILED', 'net::ERR_BLOCKED_BY_ADMINISTRATOR', 'unexpected failure'])(
    'does not classify an unknown error as availability: %s',
    (message) => expect(isUpdateOriginFailoverEligible(new Error(message))).toBe(false)
  );

  it('arm64 and x64 resolve to DIFFERENT channels (per-arch latest-mac.yml clobber guard)', () => {
    const arm = resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com', arch: 'arm64' });
    const x64 = resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com', arch: 'x64' });
    expect(arm).not.toBe(x64);
  });

  it('trims a trailing slash on the base so the channel path is well-formed', () => {
    expect(resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com/', arch: 'arm64' })).toBe(
      'https://cdn.example.com/humic/updates/stable/arm64'
    );
  });

  it('an EXPLICIT testFeedUrl overrides the baked base (in-process injection, always honored)', () => {
    expect(
      resolveUpdateFeedUrl({
        testFeedUrl: 'http://127.0.0.1:9999',
        feedBase: 'https://cdn.example.com',
        arch: 'arm64',
        isPackaged: true,
      })
    ).toBe('http://127.0.0.1:9999');
  });

  it('SECURITY: a PACKAGED build ignores the WAYPOINT_UPDATE_FEED_URL env override', () => {
    expect(
      resolveUpdateFeedUrl({
        envFeedUrl: 'http://evil.example/updates',
        isPackaged: true,
        feedBase: 'https://cdn.example.com',
        arch: 'arm64',
      })
    ).toBe('https://cdn.example.com/humic/updates/stable/arm64');
  });

  it('an UNPACKAGED build honors the WAYPOINT_UPDATE_FEED_URL env override (dev E2E hook)', () => {
    expect(
      resolveUpdateFeedUrl({
        envFeedUrl: 'http://127.0.0.1:8099',
        isPackaged: false,
        feedBase: 'https://cdn.example.com',
        arch: 'arm64',
      })
    ).toBe('http://127.0.0.1:8099');
  });

  it('fails closed when no feed authority is configured', () => {
    expect(() => resolveUpdateFeedUrl({ feedBase: '', arch: 'arm64' })).toThrow(
      /update authority is empty/i
    );
  });

  it('reads the Humic feed root, never the legacy root that serves legacy-signed installs ', () => {
    const url = resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com', arch: 'arm64' });
    expect(url).toBe('https://cdn.example.com/humic/updates/stable/arm64');
    expect(url).not.toMatch(/\.com\/updates\//);
  });

  it('NEVER resolves to a github feed when a base is baked — the  regression guard', () => {
    const url = resolveUpdateFeedUrl({ feedBase: 'https://cdn.example.com', arch: 'arm64' });
    expect(url).toContain('/humic/updates/stable/');
    expect(url).not.toContain('github.com');
    expect(url).not.toContain('releases.atom');
  });

  it('the packaged updater fetches <feed>/<arch>/latest-mac.yml — the L3 anchor', () => {
    const feedBase = 'http://127.0.0.1:8788';
    for (const arch of ['arm64', 'x64'] as const) {
      const feed = resolveUpdateFeedUrl({ feedBase, arch });
      expect(`${feed}/latest-mac.yml`).toBe(
        `http://127.0.0.1:8788/humic/updates/stable/${arch}/latest-mac.yml`
      );
    }
  });
});

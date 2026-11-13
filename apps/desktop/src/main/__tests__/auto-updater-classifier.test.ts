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

import { classifyCheckErrorReason, type CheckErrorReason } from '../auto-updater';

interface Sample {
  message: string;
  expected: CheckErrorReason;
  origin: 'electron-updater' | 'node' | 'macOS' | 'windows' | 'wild' | 'synthetic';
  note?: string;
}

const NO_MANIFEST_CORPUS: Sample[] = [
  {
    message:
      "ENOENT: no such file or directory, open '/Applications/DNAForge.app/Contents/Resources/app-update.yml'",
    expected: 'no-manifest',
    origin: 'electron-updater',
    note: 'canonical path lookup failure on macOS — the manifest never made it into the package',
  },
  {
    message:
      'Error: ENOENT: no such file or directory, open ' +
      "'C:\\Program Files\\DNAForge\\resources\\app-update.yml'",
    expected: 'no-manifest',
    origin: 'windows',
    note: 'Windows variant of the same failure (path delimiter differs, signature is the same)',
  },
  {
    message: "ENOENT: open 'app-update.yaml'",
    expected: 'no-manifest',
    origin: 'synthetic',
    note: '.yaml extension also valid in YAML spec — regex must accept both',
  },
  {
    message: "ENOENT: open 'dev-app-update.yml'",
    expected: 'no-manifest',
    origin: 'electron-updater',
    note: 'unpackaged dev path with forceDevUpdateConfig — used by FORCE_UPDATER E2E suite',
  },
  {
    message: 'no such file or directory, dev-app-update.yml',
    expected: 'no-manifest',
    origin: 'wild',
    note: 'phrasing without the ENOENT prefix (some Node versions wrap it differently)',
  },
];

const NETWORK_CORPUS: Sample[] = [
  {
    message: 'getaddrinfo ENOTFOUND github.com',
    expected: 'network',
    origin: 'node',
    note: 'DNS lookup failure — most common offline signature',
  },
  {
    message: 'getaddrinfo EAI_AGAIN api.github.com',
    expected: 'network',
    origin: 'node',
    note: 'DNS temporary failure (captive portal, flaky resolver)',
  },
  {
    message: 'connect ETIMEDOUT 140.82.121.3:443',
    expected: 'network',
    origin: 'node',
    note: 'TCP connect timeout — corporate firewall / route-blackhole',
  },
  {
    message: 'connect ECONNREFUSED 127.0.0.1:9999',
    expected: 'network',
    origin: 'node',
    note: 'connection refused — feed URL host alive but port closed',
  },
  {
    message: 'read ECONNRESET',
    expected: 'network',
    origin: 'node',
    note: 'mid-stream reset — flaky network or proxy interference',
  },
  {
    message: 'socket hang up',
    expected: 'network',
    origin: 'node',
    note: 'undici/Node socket terminated without HTTP response',
  },
  {
    message: 'request to https://api.github.com timed out',
    expected: 'network',
    origin: 'electron-updater',
    note: 'fetch-layer timeout text from electron-updater’s wrapped error',
  },
  {
    message: 'fetch failed',
    expected: 'network',
    origin: 'node',
    note: 'undici-style generic fetch failure (Node 20+)',
  },
  {
    message: 'net::ERR_INTERNET_DISCONNECTED',
    expected: 'network',
    origin: 'electron-updater',
    note: 'Chromium net stack signature on full network loss',
  },
  {
    message: 'net::ERR_NETWORK_CHANGED',
    expected: 'network',
    origin: 'electron-updater',
    note: 'transient signature when Wi-Fi switches networks mid-request',
  },
  {
    message: 'net::ERR_NAME_NOT_RESOLVED',
    expected: 'network',
    origin: 'electron-updater',
    note: 'Chromium DNS failure variant',
  },
];

const UNKNOWN_CORPUS: Sample[] = [
  {
    message: 'unexpected end of file',
    expected: 'unknown',
    origin: 'wild',
    note: 'corrupt download / truncated YAML — neither structural-missing nor network',
  },
  {
    message: 'YAMLException: bad indentation of a mapping entry',
    expected: 'unknown',
    origin: 'wild',
    note: 'malformed manifest payload — the file IS reachable, but unusable',
  },
  {
    message: 'Error: Cannot find latest-mac.yml',
    expected: 'unknown',
    origin: 'electron-updater',
    note: 'platform-specific manifest missing on the FEED, not in the package — distinct from local app-update.yml ENOENT',
  },
  {
    message: 'Error: SHA512 mismatch on update package',
    expected: 'unknown',
    origin: 'electron-updater',
    note: 'integrity check failure — security signal, not network or structural',
  },
  {
    message: 'HTTP 503 Service Unavailable',
    expected: 'unknown',
    origin: 'wild',
    note: 'feed reachable but unhealthy — Retry might help, but not a "network down" signal',
  },
  {
    message: '',
    expected: 'unknown',
    origin: 'synthetic',
    note: 'empty message — must not crash the regex; falls through to unknown',
  },
];

describe('classifyCheckErrorReason — corpus', () => {
  describe('no-manifest signatures', () => {
    it.each(NO_MANIFEST_CORPUS)("[$origin] '$message' → no-manifest", ({ message, expected }) => {
      expect(classifyCheckErrorReason(message)).toBe(expected);
    });
  });

  describe('network signatures', () => {
    it.each(NETWORK_CORPUS)("[$origin] '$message' → network", ({ message, expected }) => {
      expect(classifyCheckErrorReason(message)).toBe(expected);
    });
  });

  describe('unknown signatures (safe fallback)', () => {
    it.each(UNKNOWN_CORPUS)("[$origin] '$message' → unknown", ({ message, expected }) => {
      expect(classifyCheckErrorReason(message)).toBe(expected);
    });
  });
});

describe('classifyCheckErrorReason — precedence and edge cases', () => {
  it('no-manifest wins over network when both signatures appear', () => {
    const message = "ENOENT: no such file or directory, open 'app-update.yml' (during fetch)";
    expect(classifyCheckErrorReason(message)).toBe('no-manifest');
  });

  it('regex matching is case-insensitive (electron-updater capitalization varies)', () => {
    expect(classifyCheckErrorReason('enotfound github.com')).toBe('network');
    expect(classifyCheckErrorReason('ENOTFOUND github.com')).toBe('network');
    expect(classifyCheckErrorReason('EnOtFoUnD github.com')).toBe('network');
  });

  it('partial-word matches do not produce false positives', () => {
    expect(classifyCheckErrorReason('networking subsystem error')).toBe('network');
  });

  it('messages with no recognizable signature fall back to unknown, not network', () => {
    expect(classifyCheckErrorReason('something completely unrelated')).toBe('unknown');
  });

  it('whitespace-only messages classify as unknown (no signature to match)', () => {
    expect(classifyCheckErrorReason('   ')).toBe('unknown');
    expect(classifyCheckErrorReason('\n\t')).toBe('unknown');
  });
});

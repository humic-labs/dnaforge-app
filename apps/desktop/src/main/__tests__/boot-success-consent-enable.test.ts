import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_CONSENT_VERSION } from '@waypoint/analytics-policy';

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => state.dir,
    getVersion: () => '0.9.20-nightly.202611011212',
    getLocaleCountryCode: () => 'GB',
    getSystemLocale: () => 'en-GB',
  },
}));

vi.mock('../auth/auth-config', () => ({ getWebBaseUrl: () => 'https://dnaforge.com' }));

import { notifyBootSucceeded } from '../diagnostics-upload';
import { __resetBootLogForTest, initBootLog } from '../boot-log';
import {
  getTelemetryConsent,
  recordTelemetryConsentState,
  resetTelemetryConsentForTests,
} from '../telemetry-consent';

describe('boot success after explicit analytics enablement', () => {
  let server: Server;
  let received: Array<Record<string, unknown>>;

  beforeEach(async () => {
    state.dir = mkdtempSync(join(tmpdir(), 'boot-consent-enable-'));
    received = [];
    resetTelemetryConsentForTests();
    __resetBootLogForTest();
    initBootLog(state.dir);
    for (const key of [
      'CI',
      'GITHUB_ACTIONS',
      'GITHUB_RUN_ID',
      'DNAFORGE_TELEMETRY_ACTOR',
      'DNAFORGE_TELEMETRY_ACTOR_ASSERTION',
      'DNAFORGE_RELEASE_CHANNEL',
    ])
      vi.stubEnv(key, '');
    vi.stubGlobal('__DNAFORGE_BUILD_TAG__', '');
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', '');
    vi.stubGlobal('__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__', '');
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback port');
    vi.stubEnv('DIAGNOSTICS_URL', `http://127.0.0.1:${address.port}`);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    resetTelemetryConsentForTests();
    __resetBootLogForTest();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(state.dir, { recursive: true, force: true });
  });

  it.each([null, 'false'])(
    'reports the current healthy boot only after enabling %s consent',
    async (consent) => {
      recordTelemetryConsentState({
        consent,
        version: ANALYTICS_CONSENT_VERSION,
        basis: consent ? 'explicit' : null,
      });
      expect(getTelemetryConsent()).toBe('denied');
      notifyBootSucceeded();
      expect(received).toEqual([]);
      expect(existsSync(join(state.dir, 'pending-diagnostics.json'))).toBe(false);

      const enabledAt = Date.now();
      recordTelemetryConsentState({
        consent: 'true',
        version: ANALYTICS_CONSENT_VERSION,
        basis: 'explicit',
      });
      expect(getTelemetryConsent()).toBe('allowed');
      await vi.waitFor(() => expect(received.some((body) => body.kind === 'boot_ok')).toBe(true), {
        timeout: 1_000,
      });
      await vi.waitFor(() =>
        expect(readFileSync(join(state.dir, 'logs', 'main-boot.log'), 'utf8')).toContain(
          'boot_ok_sent'
        )
      );
      const successes = received.filter((body) => body.kind === 'boot_ok');
      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({ summary: 'packaged_shell_usable', files: [] });
      expect(Date.parse(String(successes[0].timestamp))).toBeGreaterThanOrEqual(enabledAt);

      recordTelemetryConsentState({
        consent: 'true',
        version: ANALYTICS_CONSENT_VERSION,
        basis: 'explicit',
      });
      expect(received.filter((body) => body.kind === 'boot_ok')).toHaveLength(1);
    }
  );
});

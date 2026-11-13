import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  dir: '',
  consent: 'allowed' as 'allowed' | 'denied' | 'unknown',
  fetch: vi.fn(),
  listeners: new Set<(consent: 'allowed' | 'denied' | 'unknown') => void>(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => state.dir,
    getVersion: () => '0.3.0-test',
  },
}));
vi.mock('../auth/auth-config', () => ({ getWebBaseUrl: () => 'https://dnaforge.com' }));
vi.mock('../telemetry-consent', () => ({
  getTelemetryConsent: () => state.consent,
  onTelemetryConsentChange: (listener: (consent: 'allowed' | 'denied' | 'unknown') => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));

import { notifyBootSucceeded } from '../diagnostics-upload';
import { __resetBootLogForTest, initBootLog } from '../boot-log';

const attemptId = '550e8400-e29b-41d4-a716-446655440001';
const downloadId = '550e8400-e29b-41d4-a716-446655440002';

function durableRecords(): Record<string, unknown>[] {
  return ['pending-diagnostics.json', 'pending-diagnostics.inflight.json'].flatMap((name) => {
    const path = join(state.dir, name);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  });
}

function bootLog(): string {
  return readFileSync(join(state.dir, 'logs', 'main-boot.log'), 'utf8');
}

describe('boot-success durability while startup reports wait', () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'boot-success-durability-'));
    state.consent = 'allowed';
    state.fetch.mockReset();
    state.listeners.clear();
    vi.stubGlobal('fetch', state.fetch);
    vi.stubGlobal('__DNAFORGE_BUILD_TAG__', '');
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', '');
    vi.stubGlobal('__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__', '');
    vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'official');
    for (const key of [
      'CI',
      'GITHUB_ACTIONS',
      'GITHUB_RUN_ID',
      'DNAFORGE_TELEMETRY_ACTOR',
      'DNAFORGE_TELEMETRY_ACTOR_ASSERTION',
      'DNAFORGE_RELEASE_CHANNEL',
      'DIAGNOSTICS_URL',
    ])
      vi.stubEnv(key, '');
    __resetBootLogForTest();
    initBootLog(state.dir);
    writeFileSync(
      join(state.dir, 'logs', 'install-attempt.id'),
      `${attemptId}\r\n${downloadId}\r\n`
    );
    writeFileSync(
      join(state.dir, 'logs', 'install.log'),
      `schema=1 event=init attempt=${attemptId}\r\n`
    );
  });

  afterEach(() => {
    __resetBootLogForTest();
    rmSync(state.dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['install-beacon', 'upload'])('retains boot success while %s waits', async (held) => {
    let release!: (value: { ok: boolean; status: number }) => void;
    const response = new Promise<{ ok: boolean; status: number }>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const accepted: Record<string, unknown>[] = [];
    state.fetch.mockImplementation((url: string, init: RequestInit) => {
      if (String(url).endsWith(`/${held}`)) {
        waiting = true;
        return response;
      }
      const body = JSON.parse(String(init.body));
      if (body.kind === 'boot_ok') accepted.push(body);
      return Promise.resolve({ ok: true, status: 201 });
    });
    const startedAt = Date.now();
    notifyBootSucceeded();
    try {
      await vi.waitFor(() => expect(waiting).toBe(true));
      const records = [...accepted, ...durableRecords()].filter((row) => row.kind === 'boot_ok');
      expect(new Set(records.map((row) => row.event_id)).size).toBe(1);
      const original = records[0];
      expect(original).toMatchObject({
        kind: 'boot_ok',
        summary: 'packaged_shell_usable',
        attempt_id: attemptId,
        download_id: downloadId,
        files: [],
      });
      expect(original.event_id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      expect(Date.parse(String(original.timestamp))).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(String(original.timestamp))).toBeLessThanOrEqual(Date.now());
      for (const record of records) expect(record).toEqual(original);
    } finally {
      release({ ok: true, status: 201 });
      await vi.waitFor(() => expect(bootLog()).toContain('boot_ok_sent'));
    }
  });

  it.each([false, true])(
    'withdraws a staged success when consent is denied, restored=%s',
    async (restored) => {
      let release!: (value: { ok: boolean; status: number }) => void;
      const response = new Promise<{ ok: boolean; status: number }>((resolve) => {
        release = resolve;
      });
      let waiting = false;
      state.fetch.mockImplementation((url: string) => {
        if (String(url).endsWith('/install-beacon')) {
          waiting = true;
          return response;
        }
        return Promise.resolve({ ok: true, status: 201 });
      });
      notifyBootSucceeded();
      try {
        await vi.waitFor(() => expect(waiting).toBe(true));
        state.consent = 'denied';
        for (const listener of state.listeners) listener('denied');
        if (restored) {
          state.consent = 'allowed';
          for (const listener of state.listeners) listener('allowed');
        }
      } finally {
        release({ ok: true, status: 201 });
        await vi.waitFor(() =>
          expect(bootLog()).toMatch(
            /boot_ok_sent|boot_ok_delivery_failed|boot_phone_home_skipped_consent/
          )
        );
      }
      expect(
        state.fetch.mock.calls.filter(([url]) => String(url).endsWith('/upload'))
      ).toHaveLength(0);
      expect(durableRecords()).toEqual([]);
    }
  );
});

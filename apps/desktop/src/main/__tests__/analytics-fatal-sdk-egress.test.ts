import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PostHog } from 'posthog-node';

const appState = vi.hoisted(() => ({ ownedProfile: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => appState.ownedProfile,
    getVersion: () => '0.0.0-test',
    getLocaleCountryCode: () => 'US',
    getSystemLocale: () => 'en-US',
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../ipc/database', () => ({
  getDb: () => {
    throw new Error('No database at the real-SDK unit boundary');
  },
  getAnalyticsConsentStateFromDb: () => ({ consent: 'true', version: '3', basis: 'explicit' }),
}));

type Analytics = typeof import('../analytics');
type Message = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
  library: string;
  library_version: string;
};
type CapturedRequest = { at: number; body: { batch: Message[]; sent_at: string } };

const epoch = 1_700_000_000_000;
const identity = {
  distinctId: '550e8400-e29b-41d4-a716-446655440001',
  sessionId: '550e8400-e29b-41d4-a716-446655440002',
  kind: 'anonymous' as const,
  generation: 1,
};

let analytics: Analytics;
let immediate: ReturnType<typeof vi.spyOn<PostHog, 'captureImmediate'>>;
let flush: ReturnType<typeof vi.spyOn<PostHog, 'flush'>>;
let requests: CapturedRequest[];
let transportFailure: Error | null;
let nextFetch: (() => void) | undefined;

function events() {
  return requests.flatMap((request) => request.body.batch);
}

async function settleSdkCalls() {
  const returned = [...immediate.mock.results, ...flush.mock.results]
    .filter((result) => result.type === 'return')
    .map((result) => result.value);
  await Promise.allSettled(returned);
}

async function begin(consent = true) {
  analytics.initAnalyticsMain(
    { POSTHOG_API_KEY: 'phc_owned_unit_key', POSTHOG_HOST: 'http://127.0.0.1:9' },
    { consent: String(consent), version: '3', basis: 'explicit' }
  );
  if (consent) expect(analytics.syncAnalyticsIdentityContext(identity)).toBe(true);
}

beforeEach(async () => {
  vi.resetModules();
  appState.ownedProfile = await mkdtemp(join(tmpdir(), 'dnaforge-fatal-sdk-unit-'));
  requests = [];
  transportFailure = null;
  nextFetch = undefined;
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('http://127.0.0.1:9');
      expect(url.pathname).toBe('/batch/');
      expect(options?.method).toBe('POST');
      const encoded = options?.body;
      let bytes: Buffer;
      if (typeof encoded === 'string') bytes = Buffer.from(encoded);
      else if (encoded instanceof Blob) bytes = Buffer.from(await encoded.arrayBuffer());
      else if (encoded instanceof Uint8Array) bytes = Buffer.from(encoded);
      else throw new Error('The actual SDK body is not a finite string, Blob or byte array');
      if (new Headers(options?.headers).get('content-encoding') === 'gzip')
        bytes = gunzipSync(bytes);
      requests.push({ at: Date.now(), body: JSON.parse(bytes.toString('utf8')) });
      const observed = nextFetch;
      nextFetch = undefined;
      observed?.();
      if (transportFailure) throw transportFailure;
      return new Response('{"status":1}', { status: 200 });
    })
  );
  const sdk = await import('posthog-node');
  expect(vi.isMockFunction(sdk.PostHog)).toBe(false);
  immediate = vi.spyOn(sdk.PostHog.prototype, 'captureImmediate');
  flush = vi.spyOn(sdk.PostHog.prototype, 'flush');
  analytics = await import('../analytics');
});

afterEach(async () => {
  try {
    await settleSdkCalls();
    await analytics.setMainAnalyticsConsent(false);
    await analytics.shutdownAnalytics();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(appState.ownedProfile, { recursive: true, force: true });
    appState.ownedProfile = '';
  }
});

describe('fatal main event with the real Node SDK', () => {
  it('delivers the fatal event before the ordinary batch timer without draining ordinary events', async () => {
    await begin();
    analytics.trackAppHang({ phase: 'detected', source: 'heartbeat' });
    await vi.advanceTimersByTimeAsync(0);
    analytics.trackRenderProcessCrashed('crashed', { exit_code: 11 });
    await vi.advanceTimersByTimeAsync(0);
    await settleSdkCalls();

    expect(
      events().map((event) => event.event),
      'FATAL_EVENT_WAITED_FOR_ORDINARY_BATCH_TIMER'
    ).toEqual(['desktop_main_error_captured']);
    const fatal = events()[0]!;
    expect(fatal).toMatchObject({
      distinct_id: identity.distinctId,
      timestamp: new Date(epoch).toISOString(),
      library: 'posthog-node',
      properties: {
        feature_area: 'reliability',
        error_class: 'crashed',
        fatal: true,
        handled: false,
        exit_code: 11,
        $session_id: identity.sessionId,
      },
    });
    expect(requests[0]!.at).toBe(epoch);
    expect(requests[0]!.body.sent_at).toBe(new Date(epoch).toISOString());
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settleSdkCalls();
    expect(events().map((event) => event.event)).toEqual([
      'desktop_main_error_captured',
      'app_hang_observed',
    ]);
    expect(events()[1]!.timestamp).toBe(new Date(epoch).toISOString());
    expect(requests[1]!.at).toBe(epoch + 10_000);
  });

  it('keeps nonfatal reliability events on the unchanged ordinary batch timer', async () => {
    await begin();
    analytics.trackEvent('desktop_main_error_captured', {
      feature_area: 'reliability',
      error_class: 'crashed',
      fatal: false,
      handled: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    await settleSdkCalls();
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await settleSdkCalls();
    expect(events()).toHaveLength(1);
    expect(events()[0]!.properties).toMatchObject({ fatal: false, handled: true });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('sends nothing for a consent-disabled fatal event', async () => {
    await begin(false);
    analytics.trackRenderProcessCrashed('crashed', { exit_code: 11 });
    await vi.advanceTimersByTimeAsync(10_000);
    await settleSdkCalls();
    expect(requests).toEqual([]);
    expect(immediate).not.toHaveBeenCalled();
  });

  it('drops a fatal event when consent closes before SDK preparation settles', async () => {
    await begin();
    analytics.trackRenderProcessCrashed('crashed', { exit_code: 11 });
    await analytics.setMainAnalyticsConsent(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await settleSdkCalls();
    expect(requests).toEqual([]);
  });

  it('does not publish a prior identity fatal event after reidentification', async () => {
    await begin();
    analytics.trackRenderProcessCrashed('crashed', { exit_code: 11 });
    const next = {
      distinctId: '550e8400-e29b-41d4-a716-446655440003',
      sessionId: '550e8400-e29b-41d4-a716-446655440004',
      kind: 'identified' as const,
      generation: 2,
    };
    expect(analytics.syncAnalyticsIdentityContext(next)).toBe(true);
    analytics.trackAppHang({ phase: 'detected', source: 'heartbeat' });
    await vi.advanceTimersByTimeAsync(10_000);
    await settleSdkCalls();
    expect(events().map((event) => event.event)).toEqual(['app_hang_observed']);
    expect(events()[0]!).toMatchObject({
      distinct_id: next.distinctId,
      properties: { $session_id: next.sessionId },
    });
  });

  it('does not replay a revoked fatal event into a later consent generation', async () => {
    await begin();
    analytics.trackRenderProcessCrashed('crashed', { exit_code: 11 });
    await analytics.setMainAnalyticsConsent(false);
    await analytics.setMainAnalyticsConsent(true);
    const next = {
      distinctId: '550e8400-e29b-41d4-a716-446655440005',
      sessionId: '550e8400-e29b-41d4-a716-446655440006',
      kind: 'anonymous' as const,
      generation: 2,
    };
    expect(analytics.syncAnalyticsIdentityContext(next)).toBe(true);
    analytics.trackAppHang({ phase: 'detected', source: 'heartbeat' });
    await vi.advanceTimersByTimeAsync(10_000);
    await settleSdkCalls();
    expect(events().map((event) => event.event)).toEqual(['app_hang_observed']);
    expect(events()[0]!).toMatchObject({
      distinct_id: next.distinctId,
      properties: { $session_id: next.sessionId },
    });
  });

  it('retains sanitized payload rejection diagnostics without making them immediate', async () => {
    await begin();
    analytics.trackEvent('desktop_main_error_captured', {
      feature_area: 'reliability',
      error_class: 'crashed',
      fatal: 'invalid-boolean',
      unsafe: 'SYNTHETIC_REJECTED_VALUE',
    });
    await vi.advanceTimersByTimeAsync(0);
    await settleSdkCalls();
    expect(requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await settleSdkCalls();
    expect(events().some((event) => event.event === 'telemetry_payload_rejected')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('SYNTHETIC_REJECTED_VALUE');
    expect(JSON.stringify(requests)).not.toContain('invalid-boolean');
    expect(immediate).not.toHaveBeenCalled();
  });

  it('settles real SDK transport rejection through its error event without leaking the transport cause', async () => {
    await begin();
    const canary = 'SYNTHETIC_FATAL_TRANSPORT_CAUSE';
    transportFailure = new Error(canary);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdkErrors: Error[] = [];
    analytics.trackRenderProcessCrashed('crashed', { exit_code: 11 });
    expect(immediate).toHaveBeenCalledTimes(1);
    const sdk = immediate.mock.contexts[0]!;
    const unsubscribe = sdk.on('error', (error) => sdkErrors.push(error as Error));
    const result = Promise.allSettled([immediate.mock.results[0]!.value]);
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (requests.length <= attempt) await new Promise<void>((resolve) => (nextFetch = resolve));
        await vi.advanceTimersByTimeAsync(0);
        if (attempt < 3) await vi.advanceTimersByTimeAsync(3_000);
      }
      expect((await result).map((value) => value.status)).toEqual(['fulfilled']);
      expect(sdkErrors).toHaveLength(1);
      expect(sdkErrors[0]!.name).toBe('PostHogFetchNetworkError');
      expect(requests).toHaveLength(4);
      expect(events().every((event) => event.event === 'desktop_main_error_captured')).toBe(true);
      const diagnosticText = [...errorLog.mock.calls, ...warningLog.mock.calls]
        .flat()
        .map((value) =>
          value instanceof Error ? `${value.message}\n${value.stack}` : String(value)
        )
        .join('\n');
      expect(diagnosticText).not.toContain(canary);
    } finally {
      unsubscribe();
      transportFailure = null;
      nextFetch = undefined;
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });
});

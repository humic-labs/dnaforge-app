import type Database from 'better-sqlite3';
import type { WorkspaceSyncQueueJob } from '../workspace-sync-queue';
import type { WorkspaceSyncUploadTelemetryEvent } from '../workspace-sync-upload-telemetry';
import type { WorkspaceSyncRecoveryTelemetryEvent } from '../workspace-sync-recovery-telemetry';
import type { WorkspaceSyncEnablementTelemetryEvent } from '../workspace-sync-enablement-telemetry';
import type { WorkspaceSyncRecoveryCandidateIntent } from '../workspace-sync-recovery-candidate';
import type { PostHogOptions } from 'posthog-node';
import { createFileTestDb, createTestDb, openFileTestDb, openReadonlyFileTestDb } from './test-db';
import type { CommittedOptionalAnalyticsReceipt } from '../analytics-outbox';
import type { FeedbackReceipt } from '../../shared/feedback';
import { CLOSED_BETA_EVENT_VERSIONS } from '../../shared/analytics-registry.generated';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mintTelemetryActorAssertion,
  sealTelemetryActorAssertionPublicKey,
} from '@waypoint/analytics-policy/telemetry-actor-assertion';
import type {
  MeaningfulActivityAuthority,
  RendererWorkflowTelemetryRequest,
} from '../../shared/analytics-types';

const actorAssertionKeys = generateKeyPairSync('ed25519');
const actorAssertionPrivateKey = actorAssertionKeys.privateKey
  .export({ format: 'der', type: 'pkcs8' })
  .toString('base64');
const actorAssertionPublicKey = actorAssertionKeys.publicKey
  .export({ format: 'der', type: 'spki' })
  .toString('base64');
const actorBuildTag = 'v1.0.0-beta.1';
const actorBuildTagStamp = `DNAFORGE_BUILD_TAG=${actorBuildTag}::TELEMETRY_PROVENANCE_V1::END`;

function actorAssertion(actor: 'maintainer' | 'ci', ciRunId?: string): string {
  return mintTelemetryActorAssertion({
    privateKey: actorAssertionPrivateKey,
    actor,
    appVersion: '1.0.0',
    buildTag: actorBuildTag,
    releaseChannel: 'closed_beta',
    ...(ciRunId ? { ciRunId } : {}),
  });
}

interface MockSdkState {
  messages: Record<string, unknown>[];
  listeners: Map<string, Set<(value: unknown) => void>>;
}
const sdkStates = new WeakMap<object, MockSdkState>();
function stateFor(owner: object): MockSdkState {
  let value = sdkStates.get(owner);
  if (!value) {
    value = { messages: [], listeners: new Map() };
    sdkStates.set(owner, value);
  }
  return value;
}
function captureQueued(
  this: object,
  input: {
    uuid?: string;
    distinctId: string;
    event: string;
    properties: Record<string, unknown>;
    timestamp?: Date;
  }
) {
  const state = stateFor(this);
  queueMicrotask(() => {
    const message = { ...input, distinct_id: input.distinctId };
    state.messages.push(message);
    state.listeners.get('capture')?.forEach((callback) => callback(message));
  });
}
async function flushQueued(this: object) {
  const state = stateFor(this);
  const batch = state.messages.splice(0);
  state.listeners.get('flush')?.forEach((callback) => callback(batch));
}

const mockPostHog = {
  captureExceptionImmediate: vi.fn().mockResolvedValue(undefined),
  capture: vi.fn(captureQueued),
  groupIdentify: vi.fn(),
  on: vi.fn(function (this: object, name: string, callback: (value: unknown) => void) {
    const state = stateFor(this);
    const callbacks = state.listeners.get(name) ?? new Set();
    callbacks.add(callback);
    state.listeners.set(name, callbacks);
    return () => {
      callbacks.delete(callback);
    };
  }),
  flush: vi.fn().mockResolvedValue(undefined),
  optOut: vi.fn().mockResolvedValue(undefined),
  setPersistedProperty: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
};
interface PostHogTestOptions extends Pick<
  PostHogOptions,
  'before_send' | 'enableExceptionAutocapture'
> {
  fetch?: (
    url: string,
    options: { method: 'POST'; headers: Record<string, string>; body?: string }
  ) => Promise<unknown>;
}

const mockPostHogConstructor = vi.fn(function (_apiKey: string, _options?: PostHogTestOptions) {
  const instance = { ...mockPostHog };
  stateFor(instance);
  return instance;
});
const mockGetDb = vi.fn((): Database.Database => {
  throw new Error('no database in analytics unit test');
});
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const electronAppState = vi.hoisted(() => ({
  isPackaged: false,
  countryCode: 'US',
  userDataPath: '/tmp/waypoint-test',
}));
const mockGetAnalyticsConsentState = vi.hoisted(() =>
  vi.fn(() => ({
    consent: null as string | null,
    version: null as string | null,
    basis: null as string | null,
  }))
);

vi.mock('posthog-node', () => ({
  PostHog: mockPostHogConstructor,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: () => electronAppState.userDataPath,
    getLocaleCountryCode: () => electronAppState.countryCode,
    getSystemLocale: () => 'en-US',
    get isPackaged() {
      return electronAppState.isPackaged;
    },
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../ipc/database', () => ({
  getDb: mockGetDb,
  getAnalyticsConsentStateFromDb: mockGetAnalyticsConsentState,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = vi.fn(() => true);
  const writeFileSync = vi.fn();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) =>
    args[0] === '/tmp/waypoint-test/install-id'
      ? '55700000-0000-4000-8000-000000000001'
      : actual.readFileSync(...args)) as typeof actual.readFileSync;
  const mkdirSync = vi.fn();
  const renameSync = vi.fn();
  return {
    ...actual,
    default: { ...actual, existsSync, writeFileSync, readFileSync, mkdirSync, renameSync },
    existsSync,
    writeFileSync,
    readFileSync,
    mkdirSync,
    renameSync,
  };
});

const CONTEXT = {
  distinctId: '550e8400-e29b-41d4-a716-446655440001',
  sessionId: '550e8400-e29b-41d4-a716-446655440002',
  kind: 'anonymous' as const,
  generation: 1,
};

interface TelemetryActorCase {
  name: string;
  releaseBuild?: boolean;
  packaged: boolean;
  config: Record<string, string>;
  expectedActor: 'user' | 'maintainer' | 'ci' | 'dev';
  expectedCiRunId?: string;
}

const TELEMETRY_ACTOR_CASES: TelemetryActorCase[] = [
  {
    name: 'ordinary packaged customer on a published release',
    packaged: true,
    releaseBuild: true,
    config: {},
    expectedActor: 'user',
  },
  {
    name: 'packaged build without a published release tag',
    packaged: true,
    config: {},
    expectedActor: 'dev',
  },
  {
    name: 'explicit packaged maintainer even inside a CI-like shell',
    packaged: true,
    config: {
      DNAFORGE_TELEMETRY_ACTOR: 'maintainer',
      DNAFORGE_TELEMETRY_ACTOR_ASSERTION: actorAssertion('maintainer'),
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_ID: '32902696778',
    },
    expectedActor: 'maintainer',
  },
  {
    name: 'generic GitHub Actions packaged launch without DNAForge authority',
    packaged: true,
    config: { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '32902696778' },
    expectedActor: 'dev',
  },
  {
    name: 'signed explicit packaged CI launch',
    packaged: true,
    config: {
      DNAFORGE_TELEMETRY_ACTOR: 'ci',
      DNAFORGE_TELEMETRY_ACTOR_ASSERTION: actorAssertion('ci', '32902696778'),
      GITHUB_RUN_ID: '32902696778',
    },
    expectedActor: 'ci',
    expectedCiRunId: '32902696778',
  },
  {
    name: 'unpackaged local development',
    packaged: false,
    config: {},
    expectedActor: 'dev',
  },
  {
    name: 'unknown explicit actor fails closed to runtime facts',
    packaged: true,
    config: { DNAFORGE_TELEMETRY_ACTOR: 'internal_admin' },
    expectedActor: 'user',
  },
  {
    name: 'unauthorized explicit canary cannot self-classify',
    packaged: true,
    config: { DNAFORGE_TELEMETRY_ACTOR: 'canary' },
    expectedActor: 'user',
  },
];

async function initialize() {
  const analytics = await import('../analytics');
  analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
  analytics.syncAnalyticsIdentityContext(CONTEXT);
  return analytics;
}

describe('analytics main process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    ipcHandlers.clear();
    electronAppState.isPackaged = false;
    electronAppState.countryCode = 'US';
    mockGetAnalyticsConsentState.mockReturnValue({ consent: null, version: null, basis: null });
    process.env.POSTHOG_API_KEY = 'phc_test123';
    delete process.env.POSTHOG_HOST;
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('GITHUB_RUN_ID', '');
    vi.stubEnv('DNAFORGE_TELEMETRY_ACTOR', '');
    vi.stubEnv('DNAFORGE_TELEMETRY_ACTOR_ASSERTION', '');
    vi.stubEnv('DNAFORGE_TELEMETRY_CI_RUN_ID', '');
    vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', '');
    vi.stubGlobal('__DNAFORGE_BUILD_TAG__', '');
    vi.stubGlobal('__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__', '');
    mockPostHog.optOut.mockResolvedValue(undefined);
    mockPostHog.capture.mockImplementation(captureQueued);
    mockPostHog.flush.mockImplementation(flushQueued);
    mockPostHog.setPersistedProperty.mockImplementation(function (this: object, key: string) {
      if (key === 'queue') stateFor(this).messages.splice(0);
    });
    mockPostHog.shutdown.mockResolvedValue(undefined);
    mockGetDb.mockImplementation(() => {
      throw new Error('no database in analytics unit test');
    });
    rmSync(join(electronAppState.userDataPath, '.analytics-session-marker'), { force: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    mockPostHog.shutdown.mockResolvedValue(undefined);
    const { shutdownAnalytics } = await import('../analytics');
    await shutdownAnalytics();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends one main exception with authoritative identity and scrubs its SDK payload before egress', async () => {
    const analytics = await initialize();
    const error = new TypeError('PRIVATE_SEQUENCE ACGTACGTACGTACGTACGT');
    await analytics.captureMainException(error);
    await analytics.captureMainException(error);
    expect(mockPostHog.captureExceptionImmediate).toHaveBeenCalledTimes(1);
    expect(mockPostHog.captureExceptionImmediate).toHaveBeenCalledWith(
      error,
      CONTEXT.distinctId,
      expect.objectContaining({ $session_id: CONTEXT.sessionId })
    );
    const options = mockPostHogConstructor.mock.calls.at(-1)?.[1];
    expect(options?.enableExceptionAutocapture).toBe(false);
    const beforeSend = options?.before_send;
    if (typeof beforeSend !== 'function')
      throw new Error('The actual SDK exception filter is absent');
    const outgoing = beforeSend({
      event: '$exception',
      distinctId: CONTEXT.distinctId,
      properties: {
        telemetry_actor: 'user',
        app_version: '9.9.9',
        $exception_list: [
          {
            type: 'TypeError',
            value: error.message,
            stacktrace: {
              frames: [
                {
                  filename:
                    '/Users/alice/DNAForge.app/Contents/Resources/app.asar/out/main/index.js',
                  lineno: 12,
                  colno: 34,
                  function: 'PRIVATE_SEQUENCE',
                },
              ],
            },
          },
        ],
      },
    });
    expect(outgoing?.properties?.$exception_list).toEqual([
      expect.objectContaining({ type: 'TypeError', value: 'Application exception' }),
    ]);
    expect(JSON.stringify(outgoing)).not.toMatch(/PRIVATE_SEQUENCE|ACGT|alice/);
    expect(outgoing?.properties).toMatchObject({
      telemetry_actor: 'dev',
      app_version: '1.0.0',
      $geoip_disable: true,
    });
    await analytics.shutdownAnalytics();
    await analytics.captureMainException(new Error('after consent closes'));
    expect(mockPostHog.captureExceptionImmediate).toHaveBeenCalledTimes(1);
  });

  it('resolves one validated runtime key/host for both native and renderer clients', async () => {
    const { resolvePostHogRuntimeConfig } = await import('../analytics');
    expect(
      resolvePostHogRuntimeConfig({
        POSTHOG_API_KEY: 'phc_collector_key',
        POSTHOG_HOST: 'http://127.0.0.1:43123/path-is-discarded',
        DNAFORGE_RELEASE_CHANNEL: 'prod',
        NODE_ENV: 'development',
      })
    ).toEqual(
      expect.objectContaining({
        apiKey: 'phc_collector_key',
        host: 'http://127.0.0.1:43123',
        appVersion: '1.0.0',
        platformFamily: expect.any(String),
        environment: 'development',
        releaseChannel: 'prod',
        pseudonymousInstallId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        isSynthetic: false,
      })
    );
    expect(
      resolvePostHogRuntimeConfig({ POSTHOG_API_KEY: 'secret', POSTHOG_HOST: 'file:///tmp' })
    ).toBeNull();
  });

  it('logs a safe origin when a developer PostHog override is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolvePostHogRuntimeConfig } = await import('../analytics');

    resolvePostHogRuntimeConfig({
      POSTHOG_API_KEY: 'phc_runtime_proxy',
      POSTHOG_HOST: 'https://posthog.internal.example/private-path?token=secret',
    });

    expect(warn).toHaveBeenCalledWith(
      '[analytics] Ignoring unapproved runtime PostHog origin: https://posthog.internal.example'
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-path');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token=secret');
  });

  it('fails closed instead of falling back to a baked key for an incomplete host override', async () => {
    delete process.env.POSTHOG_API_KEY;
    process.env.POSTHOG_HOST = 'http://127.0.0.1:43123';
    const { resolvePostHogRuntimeConfig } = await import('../analytics');

    expect(resolvePostHogRuntimeConfig()).toBeNull();
  });

  it('allows packaged canary authority only through a loopback forwarder', async () => {
    electronAppState.isPackaged = true;
    const { resolvePostHogRuntimeConfig } = await import('../analytics');

    expect(
      resolvePostHogRuntimeConfig({
        POSTHOG_API_KEY: 'phc_runtime_production',
        POSTHOG_HOST: 'https://us.i.posthog.com',
      })
    ).toBeNull();
    expect(
      resolvePostHogRuntimeConfig({
        POSTHOG_API_KEY: 'phc_runtime_staging',
        POSTHOG_HOST: 'https://us.i.posthog.com',
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        DNAFORGE_TELEMETRY_ENVIRONMENT: 'staging',
      })
    ).toBeNull();
    expect(
      resolvePostHogRuntimeConfig({
        POSTHOG_API_KEY: 'phc_runtime_staging',
        POSTHOG_HOST: 'https://ingest.attacker.example',
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        DNAFORGE_TELEMETRY_ENVIRONMENT: 'staging',
      })
    ).toBeNull();
    expect(
      resolvePostHogRuntimeConfig({
        POSTHOG_API_KEY: 'phc_loopback_without_proxy_authority',
        POSTHOG_HOST: 'http://127.0.0.1:43123',
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        DNAFORGE_TELEMETRY_ENVIRONMENT: 'staging',
      })
    ).toBeNull();
    expect(
      resolvePostHogRuntimeConfig({
        POSTHOG_API_KEY: 'phc_loopback_test',
        POSTHOG_HOST: 'http://127.0.0.1:43123/path-is-discarded',
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        DNAFORGE_TELEMETRY_ENVIRONMENT: 'staging',
        DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN: 'a'.repeat(64),
      })
    ).toEqual(
      expect.objectContaining({
        apiKey: 'phc_loopback_test',
        host: 'http://127.0.0.1:43123',
        environment: 'staging',
        isSynthetic: true,
        canaryProxyToken: 'a'.repeat(64),
      })
    );
  });

  it('authenticates the packaged main-process canary transport', async () => {
    electronAppState.isPackaged = true;
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '{}',
      json: async () => ({}),
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);
    const { initAnalyticsMain } = await import('../analytics');

    initAnalyticsMain(
      {
        POSTHOG_API_KEY: 'phc_loopback_test',
        POSTHOG_HOST: 'http://127.0.0.1:43123',
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        DNAFORGE_TELEMETRY_ENVIRONMENT: 'staging',
        DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN: 'b'.repeat(64),
      },
      { consent: 'true', version: '3' }
    );

    const options = mockPostHogConstructor.mock.calls.at(-1)?.[1];
    expect(options?.fetch).toEqual(expect.any(Function));
    await options?.fetch?.('http://127.0.0.1:43123/batch/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/batch/',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-DNAForge-Canary-Token': 'b'.repeat(64),
        }),
      })
    );
  });

  it('ignores packaged synthetic dimensions without loopback authority', async () => {
    electronAppState.isPackaged = true;
    const { resolveTelemetryRuntimeDimensions } = await import('../telemetry-runtime');

    const dimensions = resolveTelemetryRuntimeDimensions(
      {
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        DNAFORGE_TELEMETRY_ENVIRONMENT: 'staging',
      },
      '/tmp/waypoint-test'
    );

    expect(dimensions).toEqual(
      expect.objectContaining({ environment: 'production', isSynthetic: false })
    );
    expect(dimensions.telemetryCanaryId).toBeUndefined();
  });

  it.each(TELEMETRY_ACTOR_CASES)(
    'classifies $name',
    async ({ packaged, releaseBuild, config, expectedActor, expectedCiRunId }) => {
      electronAppState.isPackaged = packaged;
      if (releaseBuild) vi.stubGlobal('__DNAFORGE_BUILD_TAG__', actorBuildTagStamp);
      if ('DNAFORGE_TELEMETRY_ACTOR_ASSERTION' in config) {
        vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', 'closed_beta');
        vi.stubGlobal('__DNAFORGE_BUILD_TAG__', actorBuildTagStamp);
        vi.stubGlobal(
          '__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__',
          sealTelemetryActorAssertionPublicKey(actorAssertionPublicKey)
        );
      }
      const { resolveTelemetryRuntimeDimensions, telemetryRuntimeProperties } =
        await import('../telemetry-runtime');

      const dimensions = resolveTelemetryRuntimeDimensions(config, '/tmp/waypoint-test');
      const properties = telemetryRuntimeProperties(dimensions);

      expect(dimensions.telemetryActor).toBe(expectedActor);
      expect(dimensions.ciRunId).toBe(expectedCiRunId);
      expect(properties.telemetry_actor).toBe(expectedActor);
      if (expectedCiRunId) {
        expect(properties.ci_run_id).toBe(expectedCiRunId);
      } else {
        expect(properties).not.toHaveProperty('ci_run_id');
      }
    }
  );

  it('suppresses packaged egress when an internal assertion is invalid', async () => {
    electronAppState.isPackaged = true;
    const { resolvePostHogRuntimeConfig } = await import('../analytics');
    const { resolveTelemetryActorContext } = await import('../telemetry-runtime');
    const config = {
      DNAFORGE_TELEMETRY_ACTOR: 'maintainer',
      DNAFORGE_TELEMETRY_ACTOR_ASSERTION: 'dfactor2.invalid.signature',
    };

    expect(resolveTelemetryActorContext(config)).toEqual({
      telemetryActor: 'user',
      telemetrySuppressed: true,
    });
    expect(resolvePostHogRuntimeConfig(config)).toBeNull();
  });

  it('gives an authorized canary precedence over CI and omits the CI run id', async () => {
    electronAppState.isPackaged = true;
    const { resolveTelemetryRuntimeDimensions } = await import('../telemetry-runtime');

    const dimensions = resolveTelemetryRuntimeDimensions(
      {
        DNAFORGE_TELEMETRY_CANARY_ID: '20010000-0000-4000-8000-000000000001',
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '32902696778',
      },
      '/tmp/waypoint-test',
      { allowRuntimeCanary: true }
    );

    expect(dimensions.telemetryActor).toBe('canary');
    expect(dimensions.ciRunId).toBeUndefined();
  });

  it('does not resolve or create an install id while durable consent is off', async () => {
    const { writeFileSync } = await import('node:fs');
    const { initAnalyticsMain } = await import('../analytics');

    initAnalyticsMain(undefined, { consent: 'false', version: '3', basis: 'explicit' });

    const writes = vi.mocked(writeFileSync).mock.calls.map(([path]) => String(path));
    expect(writes.filter((path) => !path.includes('telemetry-consent.json'))).toEqual([]);
  });

  it('keeps capture closed in an opt-in region until the user explicitly grants it', async () => {
    electronAppState.countryCode = 'DE';
    const settingsRun = vi.fn();
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({ run: settingsRun, get: vi.fn() })),
      transaction: vi.fn((callback: () => void) => callback),
    } as never);
    const { PostHog } = await import('posthog-node');
    const analytics = await import('../analytics');
    try {
      analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3', basis: 'default' });
      expect(PostHog).not.toHaveBeenCalled();

      await expect(analytics.grantMainAnalyticsConsent()).resolves.toBe(false);
      expect(settingsRun).not.toHaveBeenCalled();
      expect(PostHog).not.toHaveBeenCalled();

      await expect(analytics.grantMainAnalyticsConsent('explicit')).resolves.toBe(true);
      expect(settingsRun).toHaveBeenCalledWith('analytics_consent', 'true', expect.any(Number));
      expect(settingsRun).toHaveBeenCalledWith(
        'analytics_consent_basis',
        'explicit',
        expect.any(Number)
      );
      expect(PostHog).toHaveBeenCalledTimes(1);
    } finally {
      await analytics.shutdownAnalytics();
    }
  });

  it('keeps an earlier explicit basis when startup re-affirms consent', async () => {
    electronAppState.countryCode = 'FR';
    mockGetAnalyticsConsentState.mockReturnValue({
      consent: 'true',
      version: '3',
      basis: 'explicit',
    });
    const settingsRun = vi.fn();
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({ run: settingsRun, get: vi.fn() })),
      transaction: vi.fn((callback: () => void) => callback),
    } as never);
    const analytics = await import('../analytics');
    try {
      await expect(analytics.grantMainAnalyticsConsent()).resolves.toBe(true);
      expect(settingsRun).toHaveBeenCalledWith(
        'analytics_consent_basis',
        'explicit',
        expect.any(Number)
      );
    } finally {
      await analytics.shutdownAnalytics();
    }
  });

  it('reports the regional decision to the renderer and refuses an out-of-policy open', async () => {
    electronAppState.countryCode = 'CH';
    mockGetAnalyticsConsentState.mockReturnValue({ consent: null, version: null, basis: null });
    const { PostHog } = await import('posthog-node');
    const analytics = await import('../analytics');
    analytics.registerAnalyticsHandlers();

    expect(await ipcHandlers.get('analytics:getConsentPolicy')?.({})).toEqual({
      enabled: false,
      needsDisclosure: true,
      consent: null,
      version: null,
    });
    await ipcHandlers.get('analytics:setConsent')?.({}, true);
    expect(PostHog).not.toHaveBeenCalled();
    expect(await ipcHandlers.get('analytics:getOptIn')?.({})).toBe(false);

    electronAppState.countryCode = 'US';
    expect(await ipcHandlers.get('analytics:getConsentPolicy')?.({})).toEqual({
      enabled: true,
      needsDisclosure: true,
      consent: 'true',
      version: '3',
    });
  });

  it('retains only analytics config needed for a later local opt-in', async () => {
    delete process.env.POSTHOG_API_KEY;
    const { PostHog } = await import('posthog-node');
    const { initAnalyticsMain, setMainAnalyticsConsent } = await import('../analytics');

    initAnalyticsMain(
      {
        POSTHOG_API_KEY: 'phc_local_reenable',
        POSTHOG_HOST: 'http://127.0.0.1:43123',
        UNRELATED_PRIVATE_CONFIG: 'must-not-be-retained',
      },
      { consent: 'false', version: '3' }
    );
    expect(PostHog).not.toHaveBeenCalled();

    await setMainAnalyticsConsent(true);

    expect(PostHog).toHaveBeenCalledWith('phc_local_reenable', {
      disableGeoip: true,
      host: 'http://127.0.0.1:43123',
      fetch: expect.any(Function),
      before_send: expect.any(Function),
      enableExceptionAutocapture: false,
    });
  });

  it('starts posthog-node for stale desktop consent under the opt-out policy', async () => {
    const { PostHog } = await import('posthog-node');
    const { initAnalyticsMain } = await import('../analytics');

    initAnalyticsMain(undefined, { consent: 'true', version: '2' });
    expect(PostHog).toHaveBeenCalledWith('phc_test123', {
      disableGeoip: true,
      host: 'https://us.i.posthog.com',
      fetch: expect.any(Function),
      before_send: expect.any(Function),
      enableExceptionAutocapture: false,
    });
  });

  it('captures allowlisted events with renderer distinct/session IDs and safe defaults', async () => {
    const analytics = await initialize();
    analytics.trackEvent('desktop_main_error_captured', {
      event_version: 999,
      feature_area: 'reliability',
      error_class: 'startup',
      fatal: true,
      handled: false,
      unsafe: 'DNA1598_SECRET',
    });

    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: CONTEXT.distinctId,
        event: 'desktop_main_error_captured',
        properties: expect.objectContaining({
          feature_area: 'reliability',
          error_class: 'startup',
          fatal: true,
          handled: false,
          event_version: 1,
          app_version: '1.0.0',
          platform_family: expect.any(String),
          identity_kind: 'anonymous',
          $session_id: CONTEXT.sessionId,
        }),
        timestamp: expect.any(Date),
      })
    );
    expect(mockPostHog.capture.mock.calls[0][0].properties).not.toHaveProperty('unsafe');
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'telemetry_payload_rejected',
        properties: expect.objectContaining({
          rejected_event: 'desktop_main_error_captured',
          rejected_property_keys: 'event_version,unsafe',
          rejection_reason: 'unknown_property',
        }),
      })
    );
  });

  it('stamps identity_kind from the accepted renderer identity context', async () => {
    const analytics = await initialize();
    analytics.syncAnalyticsIdentityContext({
      ...CONTEXT,
      kind: 'identified',
      generation: 2,
    });
    mockPostHog.capture.mockClear();
    analytics.trackEvent('app_session_started', { feature_area: 'lifecycle' });
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app_session_started',
        properties: expect.objectContaining({ identity_kind: 'identified' }),
      })
    );
  });

  it('groups identified main-process events by the single organization', async () => {
    const organization = '018f3fd0-0000-7000-8000-000000000031';
    const analytics = await initialize();
    analytics.syncAnalyticsIdentityContext({ ...CONTEXT, kind: 'identified', generation: 2 });
    analytics.setAnalyticsOrganization(organization);
    analytics.setAnalyticsOrganization(organization);
    mockPostHog.capture.mockClear();
    analytics.trackEvent('app_session_started', { feature_area: 'lifecycle' });
    expect(mockPostHog.groupIdentify).toHaveBeenCalledTimes(1);
    expect(mockPostHog.groupIdentify).toHaveBeenCalledWith({
      groupType: 'organization',
      groupKey: organization,
    });
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app_session_started',
        groups: { organization },
      })
    );

    analytics.setAnalyticsOrganization(null);
    mockPostHog.capture.mockClear();
    analytics.trackEvent('app_session_started', { feature_area: 'lifecycle' });
    expect(mockPostHog.capture.mock.calls[0]?.[0]).not.toHaveProperty('groups');
  });

  it('refuses operational auth events from the consent-gated desktop main SDK', async () => {
    const analytics = await initialize();

    analytics.trackEvent('auth_started', {
      feature_area: 'auth',
      auth_flow_category: 'desktop_oauth',
      auth_provider_category: 'github',
    });

    expect(mockPostHog.capture).not.toHaveBeenCalled();
  });

  it('drops a globally safe property when the generated event schema does not allow it', async () => {
    const analytics = await initialize();
    analytics.trackEvent('app_session_started', {
      feature_area: 'lifecycle',
      route_category: 'login',
    });

    const sessionEvent = mockPostHog.capture.mock.calls.find(
      ([input]) => input.event === 'app_session_started'
    )?.[0];
    if (!sessionEvent) throw new Error('Expected the app_session_started capture');
    expect(sessionEvent.properties).not.toHaveProperty('route_category');
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'telemetry_payload_rejected',
        properties: expect.objectContaining({
          rejected_event: 'app_session_started',
          rejected_property_keys: 'route_category',
          rejection_reason: 'unknown_property',
        }),
      })
    );
  });

  it('emits one aggregate diagnostic when one main-process payload has mixed defects', async () => {
    const analytics = await initialize();

    analytics.trackEvent('desktop_main_error_captured', {
      feature_area: 'reliability',
      fatal: 'not-a-boolean',
      unsafe: 'DNA1598_SECRET',
    });

    const diagnostics = mockPostHog.capture.mock.calls.filter(
      ([input]) => input.event === 'telemetry_payload_rejected'
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.[0].properties).toEqual(
      expect.objectContaining({
        rejected_event: 'desktop_main_error_captured',
        rejected_property_keys: 'fatal,unsafe',
        rejected_property_count: 2,
        rejection_reason: 'mixed_property',
      })
    );
  });

  it('buffers native capture until renderer context and rejects an unknown event', async () => {
    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
    analytics.trackEvent('app_session_started', { feature_area: 'lifecycle' });
    analytics.trackEvent('unregistered_event', { feature_area: 'auth' });
    expect(mockPostHog.capture).not.toHaveBeenCalled();

    analytics.syncAnalyticsIdentityContext(CONTEXT);
    expect(mockPostHog.capture).toHaveBeenCalledTimes(2);
    expect(mockPostHog.capture.mock.calls.map(([input]) => input.event)).toEqual([
      'app_session_started',
      'telemetry_payload_rejected',
    ]);
    expect(mockPostHog.capture.mock.calls[1][0].properties).toEqual(
      expect.objectContaining({
        rejected_event: 'unregistered_event',
        rejection_reason: 'unknown_event',
      })
    );
  });

  it('flushes a consented schema refusal when fatal startup prevents renderer identity', async () => {
    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
    analytics.trackEvent('app_schema_refused', {
      db_version: 20,
      build_version: '0.6.2',
      is_release: true,
    });
    expect(mockPostHog.capture).not.toHaveBeenCalled();

    await analytics.flushAnalyticsForFatalStartup();

    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app_schema_refused',
        properties: expect.objectContaining({
          db_version: 20,
          build_version: '0.6.2',
          is_release: true,
        }),
      })
    );
    expect(mockPostHog.shutdown).toHaveBeenCalledTimes(1);
  });

  it('keeps a rejected PostHog shutdown from escaping the fatal-startup boundary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockPostHog.shutdown.mockRejectedValueOnce(new Error('collector unavailable'));
    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
    analytics.trackEvent('app_schema_refused', {
      db_version: 20,
      build_version: '0.6.2',
      is_release: false,
    });

    await expect(analytics.flushAnalyticsForFatalStartup()).resolves.toBeUndefined();

    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'app_schema_refused' })
    );
    expect(warn).toHaveBeenCalledWith(
      '[analytics] Fatal-startup flush failed:',
      expect.objectContaining({ message: 'collector unavailable' })
    );
    warn.mockRestore();
  });

  it('captures scrubbed main and renderer crash classes without raw error content', async () => {
    const analytics = await initialize();
    analytics.trackMainProcessError('uncaught_exception');
    analytics.trackRenderProcessCrashed('crashed DNA1598_RAW_STACK');

    expect(mockPostHog.capture).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: 'desktop_main_error_captured',
        properties: expect.objectContaining({ error_class: 'uncaught_exception' }),
      })
    );
    expect(mockPostHog.capture).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: 'desktop_main_error_captured',
        properties: expect.objectContaining({ error_class: 'unknown' }),
      })
    );
    expect(JSON.stringify(mockPostHog.capture.mock.calls)).not.toContain('RAW_STACK');
  });

  it('first observation requires successful atomic profile marker creation, not an install claim', async () => {
    const analytics = await initialize();
    vi.mocked(existsSync).mockReturnValueOnce(false);
    analytics.trackAppSessionStarted();
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.analytics-first-opened'),
      expect.any(String),
      { flag: 'wx' }
    );
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app_first_opened',
        properties: expect.objectContaining({ lifecycle_scope: 'local_profile' }),
      })
    );
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app_session_started',
        properties: expect.objectContaining({ lifecycle_scope: 'process_session' }),
      })
    );
    analytics.trackAppSessionStarted();
    expect(
      mockPostHog.capture.mock.calls.filter(([e]) => e.event === 'app_first_opened')
    ).toHaveLength(1);
  });

  it('a failed profile marker cannot report a unique first observation or block the session', async () => {
    const analytics = await initialize();
    vi.mocked(existsSync).mockReturnValueOnce(false);
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('unwritable marker');
    });
    expect(() => analytics.trackAppSessionStarted()).not.toThrow();
    expect(
      mockPostHog.capture.mock.calls.filter(([e]) => e.event === 'app_first_opened')
    ).toHaveLength(0);
    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'app_session_started' })
    );
  });

  it('captures the exact clean session duration before shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T20:00:00.000Z'));
    const analytics = await initialize();

    analytics.trackAppSessionStarted();
    vi.setSystemTime(new Date('2026-07-25T20:12:34.567Z'));
    analytics.trackAppClosed();

    expect(mockPostHog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app_session_ended',
        properties: expect.objectContaining({
          feature_area: 'lifecycle',
          session_duration_ms: 754_567,
          close_reason: 'app_quit',
          clean_exit: true,
        }),
        timestamp: new Date('2026-07-25T20:12:34.567Z'),
      })
    );
    vi.useRealTimers();
  });

  it('keeps compute job lifecycle properties through the real sanitizer', async () => {
    const analytics = await initialize();
    mockPostHog.capture.mockClear();
    analytics.trackComputeJobObserved({
      provider: 'tamarind',
      toolId: 'boltz-2',
      state: 'completed',
      pollCount: 12,
      createdAt: '2026-10-27T20:00:00.000Z',
      updatedAt: '2026-10-27T20:42:30.000Z',
    });
    const event = mockPostHog.capture.mock.calls.find(
      ([input]) => input.event === 'compute_job_observed'
    );
    expect(event?.[0].properties).toEqual(
      expect.objectContaining({
        job_phase: 'completed',
        compute_provider: 'tamarind',
        compute_tool: 'boltz_2',
        poll_count: 12,
        compute_duration_ms: 2_550_000,
      })
    );
    expect(
      mockPostHog.capture.mock.calls.filter(
        ([input]) => input.event === 'telemetry_payload_rejected'
      )
    ).toEqual([]);
  });

  it('reports a session that ended without a clean quit at the next launch', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const markerPath = join(electronAppState.userDataPath, '.analytics-session-marker');
    const persistLastMarker = () => {
      const write = vi
        .mocked(writeFileSync)
        .mock.calls.filter(([path]) => path === markerPath)
        .at(-1);
      expect(write).toBeDefined();
      realFs.mkdirSync(electronAppState.userDataPath, { recursive: true });
      realFs.writeFileSync(markerPath, String(write?.[1]));
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T20:00:00.000Z'));
    let analytics = await initialize();
    analytics.trackAppSessionStarted();
    vi.setSystemTime(new Date('2026-07-25T20:30:00.000Z'));
    analytics.touchAppSessionMarker();
    persistLastMarker();

    vi.resetModules();
    mockPostHog.capture.mockClear();
    vi.setSystemTime(new Date('2026-07-26T09:00:00.000Z'));
    analytics = await initialize();
    analytics.trackAppSessionStarted();

    const ended = mockPostHog.capture.mock.calls.filter(
      ([input]) => input.event === 'app_session_ended'
    );
    expect(ended).toHaveLength(1);
    expect(ended[0][0].properties).toEqual(
      expect.objectContaining({
        close_reason: 'unclean_exit',
        clean_exit: false,
        session_duration_ms: 1_800_000,
        previous_app_version: '1.0.0',
      })
    );

    analytics.trackAppClosed();
    vi.resetModules();
    mockPostHog.capture.mockClear();
    analytics = await initialize();
    analytics.trackAppSessionStarted();
    expect(
      mockPostHog.capture.mock.calls.filter(([input]) => input.event === 'app_session_ended')
    ).toHaveLength(0);
  });

  it('keeps every app-health property through the real sanitizer', async () => {
    const analytics = await initialize();
    mockPostHog.capture.mockClear();
    analytics.trackAppHang({ phase: 'detected', source: 'heartbeat' });
    analytics.trackAppHang({
      phase: 'resolved',
      source: 'chromium',
      resolution: 'reloaded',
      durationMs: 12_345.6,
    });
    analytics.trackChildProcessGone({
      processType: 'GPU',
      reason: 'crashed',
      exitCode: -1073741819,
    });
    analytics.trackChildProcessGone({ processType: 'Pepper Plugin', reason: 'oom', exitCode: 3 });
    analytics.trackActivityHeartbeat({
      intervalMinutes: 15,
      activeMinutes: 9,
      focusedMinutes: 12,
      mainHeapMb: 180,
      appMemoryMb: 1400,
      rendererMemoryMb: 900,
      gpuMemoryMb: 250,
    });
    analytics.trackStartupTimed({ readyMs: 410.2, windowMs: 1020, shellReadyMs: 3150 });
    analytics.trackSidecarLifecycleEvent('exit', {
      fatal: true,
      success: false,
      exitCode: 137,
      signal: 'SIGKILL',
      elapsedMs: 65_000,
    });

    const byEvent = (event: string) =>
      mockPostHog.capture.mock.calls
        .filter(([input]) => input.event === event)
        .map(([input]) => input.properties);
    expect(byEvent('app_hang_observed')).toEqual([
      expect.objectContaining({ hang_phase: 'detected', hang_source: 'heartbeat' }),
      expect.objectContaining({
        hang_phase: 'resolved',
        hang_source: 'chromium',
        hang_resolution: 'reloaded',
        duration_ms: 12_346,
      }),
    ]);
    expect(byEvent('child_process_gone')).toEqual([
      expect.objectContaining({
        process_type: 'gpu',
        gone_reason: 'crashed',
        exit_code: -1073741819,
      }),
      expect.objectContaining({ process_type: 'pepper_plugin', gone_reason: 'oom', exit_code: 3 }),
    ]);
    expect(byEvent('app_activity_heartbeat')[0]).toEqual(
      expect.objectContaining({
        interval_minutes: 15,
        active_minutes: 9,
        focused_minutes: 12,
        main_heap_mb: 180,
        app_memory_mb: 1400,
        renderer_memory_mb: 900,
        gpu_memory_mb: 250,
      })
    );
    expect(byEvent('app_startup_timed')[0]).toEqual(
      expect.objectContaining({ ready_ms: 410, window_ms: 1020, shell_ready_ms: 3150 })
    );
    expect(byEvent('sidecar_lifecycle')[0]).toEqual(
      expect.objectContaining({ exit_code: 137, exit_signal: 'sigkill', elapsed_ms: 65_000 })
    );
    expect(
      mockPostHog.capture.mock.calls.filter(
        ([input]) => input.event === 'telemetry_payload_rejected'
      )
    ).toEqual([]);
  });

  it('starts lifecycle capture when a fresh-profile user opts in after startup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T20:00:00.000Z'));
    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(undefined, { consent: null, version: null });

    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({ get: vi.fn(), run: vi.fn() })),
      transaction: vi.fn((callback: () => void) => callback),
    } as never);
    await analytics.grantMainAnalyticsConsent();
    analytics.syncAnalyticsIdentityContext(CONTEXT);
    vi.setSystemTime(new Date('2026-07-25T20:00:03.210Z'));
    analytics.trackAppClosed();

    const lifecycleEvents = mockPostHog.capture.mock.calls.map(([input]) => input.event);
    expect(lifecycleEvents).toEqual(
      expect.arrayContaining(['app_session_started', 'app_session_ended'])
    );
    expect(lifecycleEvents.indexOf('app_session_started')).toBeLessThan(
      lifecycleEvents.indexOf('app_session_ended')
    );
    expect(mockPostHog.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: 'app_session_ended',
        properties: expect.objectContaining({ session_duration_ms: 3_210 }),
      })
    );
  });

  it('registers typed runtime, context, persistence, and consent handlers', async () => {
    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
    analytics.registerAnalyticsHandlers();

    expect(ipcHandlers.has('analytics:getRuntimeConfig')).toBe(true);
    expect(ipcHandlers.has('analytics:syncContext')).toBe(true);
    expect(ipcHandlers.has('analytics:persistConsent')).toBe(true);
    expect(ipcHandlers.has('analytics:grantConsent')).toBe(true);
    expect(ipcHandlers.has('analytics:revokeConsent')).toBe(true);
    expect(ipcHandlers.has('analytics:setConsent')).toBe(true);
    const sync = ipcHandlers.get('analytics:syncContext')!;
    expect(await sync({}, CONTEXT)).toEqual({
      accepted: true,
      optionalOrigin: null,
      authority: {
        actorKind: 'unknown',
        executionMode: 'interactive',
        impersonated: false,
      },
    });
    expect(await sync({}, CONTEXT)).toEqual({
      accepted: false,
      optionalOrigin: null,
      authority: {
        actorKind: 'unknown',
        executionMode: 'interactive',
        impersonated: false,
      },
    });
  });

  it('classifies authenticated development users in main and excludes team accounts', async () => {
    const analytics = await import('../analytics');
    analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
    let authority: MeaningfulActivityAuthority = {
      actorKind: 'external',
      executionMode: 'interactive',
      impersonated: false,
    };
    analytics.registerAnalyticsHandlers(() => ({
      status: 'signed-in',
      session: {
        accountId: CONTEXT.distinctId,
        desktopSessionId: 'desktop-session-1',
        email: 'server-owned@example.com',
        displayName: null,
        avatarUrl: null,
        channel: 'dev',
        accessTokenExpiresAt: '2026-09-03T00:00:00.000Z',
        meaningfulActivityAuthority: authority,
      },
    }));
    const sync = ipcHandlers.get('analytics:syncContext')!;
    const identified = { ...CONTEXT, kind: 'identified' as const };

    expect(await sync({}, identified)).toEqual({
      accepted: true,
      optionalOrigin: null,
      authority: {
        actorKind: 'external',
        executionMode: 'interactive',
        impersonated: false,
      },
    });
    authority = {
      actorKind: 'internal',
      executionMode: 'interactive',
      impersonated: false,
    };
    expect(await sync({}, { ...identified, generation: 2 })).toEqual({
      accepted: true,
      optionalOrigin: null,
      authority: {
        actorKind: 'internal',
        executionMode: 'interactive',
        impersonated: false,
      },
    });
  });

  it('persists the consent value and disclosure version in one transaction', async () => {
    const settingsRun = vi.fn();
    const pendingPurgeRun = vi.fn();
    const outboxPurgeRun = vi.fn();
    const updaterReceiptPurgeRun = vi.fn();
    const cloudReceiptPurgeRun = vi.fn();
    const cloudUploadReceiptPurgeRun = vi.fn();
    const cloudRecoveryReceiptPurgeRun = vi.fn();
    const cloudEnablementReceiptPurgeRun = vi.fn();
    const receiptPurgeRuns = new Map([
      ['_cloud_backup_telemetry_receipt_v1:', cloudReceiptPurgeRun],
      ['_cloud_backup_telemetry_receipt_v2:', cloudUploadReceiptPurgeRun],
      ['_cloud_backup_recovery_telemetry_receipt_v1:', cloudRecoveryReceiptPurgeRun],
      ['_cloud_backup_enable_telemetry_receipt_v1:', cloudEnablementReceiptPurgeRun],
      ['_update_install_telemetry_receipt_v1:', updaterReceiptPurgeRun],
    ]);
    const runReceiptPurge = (length: number, prefix: string): void => {
      const run = receiptPurgeRuns.get(prefix);
      if (!run) throw new Error(`Unexpected receipt purge namespace: ${prefix}`);
      run(length, prefix);
    };
    const transaction = vi.fn((callback: () => void) => callback);
    mockGetDb.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        run: sql.startsWith('DELETE FROM meaningful_activity_pending')
          ? pendingPurgeRun
          : sql.startsWith('DELETE FROM analytics_event_outbox')
            ? outboxPurgeRun
            : sql.startsWith('DELETE FROM settings WHERE substr(key,1,?) = ?')
              ? runReceiptPurge
              : settingsRun,
      })),
      transaction,
    } as never);
    const { persistAnalyticsConsent } = await import('../analytics');

    persistAnalyticsConsent(false);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(settingsRun).toHaveBeenNthCalledWith(
      1,
      'analytics_consent',
      'false',
      expect.any(Number)
    );
    expect(settingsRun).toHaveBeenNthCalledWith(
      2,
      'analytics_consent_version',
      '3',
      expect.any(Number)
    );
    expect(settingsRun).toHaveBeenNthCalledWith(
      3,
      'analytics_consent_basis',
      'default',
      expect.any(Number)
    );
    expect(settingsRun.mock.calls[0][2]).toBe(settingsRun.mock.calls[1][2]);
    expect(pendingPurgeRun).toHaveBeenCalledTimes(1);
    expect(outboxPurgeRun).toHaveBeenCalledTimes(1);
    expect(cloudReceiptPurgeRun).toHaveBeenCalledTimes(1);
    expect(cloudReceiptPurgeRun).toHaveBeenCalledWith(
      '_cloud_backup_telemetry_receipt_v1:'.length,
      '_cloud_backup_telemetry_receipt_v1:'
    );
    expect(cloudUploadReceiptPurgeRun).toHaveBeenCalledTimes(1);
    expect(cloudUploadReceiptPurgeRun).toHaveBeenCalledWith(
      '_cloud_backup_telemetry_receipt_v2:'.length,
      '_cloud_backup_telemetry_receipt_v2:'
    );
    expect(cloudRecoveryReceiptPurgeRun).toHaveBeenCalledTimes(1);
    expect(cloudRecoveryReceiptPurgeRun).toHaveBeenCalledWith(
      '_cloud_backup_recovery_telemetry_receipt_v1:'.length,
      '_cloud_backup_recovery_telemetry_receipt_v1:'
    );
    expect(cloudEnablementReceiptPurgeRun).toHaveBeenCalledTimes(1);
    expect(cloudEnablementReceiptPurgeRun).toHaveBeenCalledWith(
      '_cloud_backup_enable_telemetry_receipt_v1:'.length,
      '_cloud_backup_enable_telemetry_receipt_v1:'
    );
    expect(updaterReceiptPurgeRun).toHaveBeenCalledTimes(1);
    expect(updaterReceiptPurgeRun).toHaveBeenCalledWith(
      '_update_install_telemetry_receipt_v1:'.length,
      '_update_install_telemetry_receipt_v1:'
    );
  });

  it('keeps pending meaningful-activity receipts when consent remains enabled', async () => {
    const settingsRun = vi.fn();
    const purgeRun = vi.fn();
    const transaction = vi.fn((callback: () => void) => callback);
    mockGetDb.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(),
        run: sql.startsWith('DELETE FROM meaningful_activity_pending') ? purgeRun : settingsRun,
      })),
      transaction,
    } as never);
    const { persistAnalyticsConsent } = await import('../analytics');

    persistAnalyticsConsent(true);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(purgeRun).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'current enabled grant', consent: 'true', version: '3', epoch: 100, preserve: true },
    { name: 'zero epoch', consent: 'true', version: '3', epoch: 0, preserve: true },
    { name: 'revoked grant', consent: 'false', version: '3', epoch: 100, preserve: false },
    { name: 'unknown decision', consent: 'unknown', version: '3', epoch: 100, preserve: false },
    { name: 'missing decision', consent: null, version: '3', epoch: 100, preserve: false },
    { name: 'missing version', consent: 'true', version: null, epoch: 100, preserve: false },
    { name: 'old policy version', consent: 'true', version: '2', epoch: 100, preserve: false },
    { name: 'missing epoch', consent: 'true', version: '3', epoch: null, preserve: false },
    { name: 'negative epoch', consent: 'true', version: '3', epoch: -1, preserve: false },
    { name: 'fractional epoch', consent: 'true', version: '3', epoch: 100.5, preserve: false },
    { name: 'nonnumeric epoch', consent: 'true', version: '3', epoch: 'invalid', preserve: false },
  ])('preserves only an existing current consent epoch: $name', async (input) => {
    const db = feedbackDatabase();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(5000);
    try {
      db.prepare('UPDATE settings SET updated_at = ?').run(input.epoch);
      for (const [key, value] of [
        ['analytics_consent', input.consent],
        ['analytics_consent_version', input.version],
      ]) {
        if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        else db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
      }
      const analytics = await import('../analytics');
      analytics.persistAnalyticsConsent(true);
      const epoch = input.preserve ? input.epoch : 5000;
      const expected = [
        { key: 'analytics_consent', value: 'true', updated_at: epoch },
        { key: 'analytics_consent_version', value: '3', updated_at: epoch },
      ];
      const read = () =>
        db
          .prepare('SELECT key, value, updated_at FROM settings WHERE key IN (?, ?) ORDER BY key')
          .all('analytics_consent', 'analytics_consent_version');
      expect(read()).toEqual(expected);
      clock.mockReturnValue(6000);
      analytics.persistAnalyticsConsent(true);
      expect(read()).toEqual(expected);
    } finally {
      clock.mockRestore();
      db.close();
    }
  });

  it('shuts down within the two-second quit budget', async () => {
    const analytics = await initialize();
    mockPostHog.shutdown.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5_000))
    );
    const startedAt = Date.now();
    await analytics.shutdownAnalytics();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('discards the PostHog queue before shutdown and drops all later events', async () => {
    const analytics = await initialize();
    await analytics.setMainAnalyticsConsent(false);
    analytics.trackMainProcessError('unhandled_rejection');

    expect(mockPostHog.capture).not.toHaveBeenCalled();
    expect(mockPostHog.optOut).toHaveBeenCalledTimes(1);
    expect(mockPostHog.setPersistedProperty).toHaveBeenCalledWith('queue', []);
    expect(mockPostHog.shutdown).toHaveBeenCalledTimes(1);
    expect(mockPostHog.setPersistedProperty.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostHog.shutdown.mock.invocationCallOrder[0]
    );
  });

  it('attempts every revoked-client cleanup and preserves the first raw failure', async () => {
    const analytics = await initialize();
    const failure = Object.freeze(new Error('controlled opt-out failure'));
    mockPostHog.optOut.mockRejectedValueOnce(failure);
    mockPostHog.setPersistedProperty.mockImplementationOnce(() => {
      throw undefined;
    });
    await expect(analytics.setMainAnalyticsConsent(false)).rejects.toBe(failure);
    expect(mockPostHog.setPersistedProperty).toHaveBeenCalledWith('queue', []);
    expect(mockPostHog.shutdown).toHaveBeenCalledTimes(1);
  });

  function feedbackDatabase(db: Database.Database = createTestDb()): Database.Database {
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      INSERT INTO settings VALUES ('analytics_consent','true',0), ('analytics_consent_version','3',0);
      CREATE TABLE analytics_event_outbox (event_id TEXT PRIMARY KEY,event_name TEXT,payload_schema_version INTEGER,
        reference_kind TEXT,reference_id TEXT,properties_json TEXT,created_at_ms INTEGER,send_attempts INTEGER,
        last_attempt_at_ms INTEGER,sent_at_ms INTEGER,origin_json TEXT);`);
    mockGetDb.mockReturnValue(db);
    return db;
  }
  it('persists renderer scientific events before delivery and preserves the complete retry capture', async () => {
    const db = feedbackDatabase();
    const analytics = await initialize();
    try {
      analytics.registerAnalyticsHandlers();
      const capturedAtMs = Date.now() - 1000;
      const request: RendererWorkflowTelemetryRequest = {
        origin: analytics.captureOptionalTelemetryOrigin()!,
        context: { ...CONTEXT },
        eventName: 'workflow_action_observed',
        eventId: '69800000-0000-4000-8000-000000000051',
        capturedAtMs,
        properties: {
          feature_area: 'scientific_workflow',
          workflow: 'annotation',
          workflow_action: 'create',
          workflow_status: 'created',
          action_phase: 'result',
          success: true,
          action_id: '69800000-0000-4000-8000-000000000052',
          occurred_at_ms: capturedAtMs,
        },
      };
      mockPostHog.flush.mockRejectedValue(new Error('Ingestion unavailable'));
      expect(await ipcHandlers.get('analytics:enqueueWorkflowEvent')!({}, request)).toBe(true);
      const read = () =>
        db.prepare('SELECT * FROM analytics_event_outbox WHERE event_id = ?').get(request.eventId);
      expect(read()).toMatchObject({
        event_name: request.eventName,
        reference_kind: 'renderer_workflow',
        created_at_ms: capturedAtMs,
        sent_at_ms: null,
      });
      await analytics.drainMainAnalyticsOutbox();
      expect(read()).toMatchObject({ sent_at_ms: null });
      mockPostHog.flush.mockImplementation(flushQueued);
      await analytics.drainMainAnalyticsOutbox();
      expect(read()).toMatchObject({ sent_at_ms: expect.any(Number) });
      const captures = mockPostHog.capture.mock.calls
        .map(([input]) => input)
        .filter((input) => input.uuid === request.eventId);
      expect(captures.length).toBeGreaterThanOrEqual(2);
      expect(captures[0]).toMatchObject({
        distinctId: CONTEXT.distinctId,
        timestamp: new Date(capturedAtMs),
        properties: {
          $insert_id: request.eventId,
          $session_id: CONTEXT.sessionId,
          occurred_at_ms: capturedAtMs,
          event_version: CLOSED_BETA_EVENT_VERSIONS.workflow_action_observed,
        },
      });
      expect(captures[0]?.properties).not.toHaveProperty('emitted_at_ms');
      for (const capture of captures) expect(capture).toEqual(captures[0]);
    } finally {
      await analytics.shutdownAnalytics();
      db.close();
    }
  });

  it('refuses renderer scientific admission under stale consent, identity or invalid payloads', async () => {
    const db = feedbackDatabase();
    const analytics = await initialize();
    try {
      analytics.registerAnalyticsHandlers();
      const invoke = (request: unknown) =>
        ipcHandlers.get('analytics:enqueueWorkflowEvent')!({}, request);
      const request: RendererWorkflowTelemetryRequest = {
        origin: analytics.captureOptionalTelemetryOrigin()!,
        context: { ...CONTEXT },
        eventName: 'workflow_action_observed',
        eventId: '69800000-0000-4000-8000-000000000061',
        capturedAtMs: Date.now(),
        properties: {
          feature_area: 'scientific_workflow',
          workflow: 'annotation',
          workflow_action: 'create',
          workflow_status: 'created',
          action_phase: 'result',
          success: true,
        },
      };
      expect(
        await invoke({ ...request, context: { ...CONTEXT, generation: CONTEXT.generation + 1 } })
      ).toBe(false);
      expect(
        await invoke({ ...request, origin: { ...request.origin, contextId: randomUUID() } })
      ).toBe(false);
      expect(await invoke({ ...request, eventName: 'auth_started' })).toBe(false);
      expect(await invoke({ ...request, capturedAtMs: NaN })).toBe(false);
      expect(
        await invoke({
          ...request,
          properties: { ...request.properties, sequence: 'PRIVATE_BASES' },
        })
      ).toBe(false);
      expect(
        await invoke({
          ...request,
          properties: { ...request.properties, $insert_id: randomUUID() },
        })
      ).toBe(false);
      analytics.persistAnalyticsConsent(false);
      expect(await invoke(request)).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
    } finally {
      await analytics.shutdownAnalytics();
      db.close();
    }
  });

  it('upgrades explicit consent without replacing the accepted receipt epoch', async () => {
    const db = feedbackDatabase();
    try {
      db.exec(`INSERT INTO settings VALUES ('analytics_consent_basis','default',0);
        INSERT INTO settings VALUES ('feedback_telemetry_consent_scope','33690000-0000-4000-8000-000000000077',0);`);
      const analytics = await import('../analytics');
      analytics.persistAnalyticsConsent(true, 'explicit');
      const read = (key: string) =>
        db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get(key);
      expect(read('analytics_consent')).toEqual({ value: 'true', updated_at: 0 });
      expect(read('analytics_consent_version')).toEqual({ value: '3', updated_at: 0 });
      expect(read('analytics_consent_basis')).toMatchObject({ value: 'explicit' });
      expect(read('feedback_telemetry_consent_scope')).toEqual({
        value: '33690000-0000-4000-8000-000000000077',
        updated_at: 0,
      });
    } finally {
      db.close();
    }
  });

  function feedbackReceipt(
    origin: NonNullable<ReturnType<typeof import('../analytics').captureFeedbackTelemetryOrigin>>
  ): FeedbackReceipt {
    return {
      origin,
      operationId: '33690000-0000-4000-8000-000000000001',
      stage: 'backend_accepted',
      originalAtMs: Date.now() - 1000,
      occurredAtMs: Date.now(),
      attempt: 2,
    };
  }
  it('issues the optional origin in the real identity ack and purges only table receipts on opt-out', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await import('../analytics');
      analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
      analytics.registerAnalyticsHandlers();
      const sync = ipcHandlers.get('analytics:syncContext')!;
      const ack = (await sync(
        {},
        CONTEXT
      )) as import('../../shared/analytics-types').AnalyticsIdentitySyncResult;
      const accepted = JSON.parse(
        (
          db
            .prepare('SELECT value FROM settings WHERE key = ?')
            .get('analytics_optional_context_v1') as { value: string }
        ).value
      );
      expect(ack).toMatchObject({
        accepted: true,
        optionalOrigin: {
          consentScope: accepted.consentScope,
          contextId: accepted.contextId,
          classification: accepted.classification,
          processId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        },
      });
      expect(await sync({}, CONTEXT)).toMatchObject({ accepted: false, optionalOrigin: null });
      const prefix = 'table_notebook_reopen_v1:';
      db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run(
        prefix + 'synthetic',
        'private receipt',
        0
      );
      db.prepare('INSERT INTO settings VALUES (?, ?, ?)').run('x' + prefix, 'unrelated setting', 0);
      const before = ack.optionalOrigin!;
      analytics.persistAnalyticsConsent(false);
      expect(
        db.prepare('SELECT value FROM settings WHERE key = ?').get(prefix + 'synthetic')
      ).toBeUndefined();
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('x' + prefix)).toEqual({
        value: 'unrelated setting',
      });
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      await analytics.grantMainAnalyticsConsent();
      const next = (await sync(
        {},
        { ...CONTEXT, generation: 2 }
      )) as import('../../shared/analytics-types').AnalyticsIdentitySyncResult;
      expect(next.accepted).toBe(true);
      expect(next.optionalOrigin!.consentScope).not.toBe(before.consentScope);
      expect(next.optionalOrigin!.contextId).not.toBe(before.contextId);
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('atomically refuses a queued table write after opt-out and preserves a newer regranted operation', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const key = 'table_notebook_reopen_v1:synthetic-atomic-row';
      const receipt = {
        version: 1,
        phase: 'accepted',
        operationId: randomUUID(),
        revisionId: randomUUID(),
        acceptedAtMs: Date.now(),
        origin,
        appSessionId: randomUUID(),
        episodeCorrelationId: randomUUID(),
      };
      const stale = {
        kind: 'write' as const,
        key,
        expectedValue: null,
        value: JSON.stringify(receipt),
        updatedAtMs: Date.now(),
        origin,
      };
      let release!: () => void;
      const held = new Promise<void>((yes) => {
        release = yes;
      });
      const queued = held.then(() => analytics.mutateTableNotebookReceipt(stale));
      analytics.persistAnalyticsConsent(false);
      release();
      expect(await queued).toBe(false);
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toBeUndefined();
      await analytics.grantMainAnalyticsConsent();
      analytics.syncAnalyticsIdentityContext({ ...CONTEXT, generation: 2 });
      const freshOrigin = analytics.captureOptionalTelemetryOrigin()!;
      const fresh = {
        ...receipt,
        operationId: randomUUID(),
        revisionId: randomUUID(),
        origin: freshOrigin,
      };
      const value = JSON.stringify(fresh);
      expect(analytics.mutateTableNotebookReceipt({ ...stale, value, origin: freshOrigin })).toBe(
        true
      );
      expect(analytics.mutateTableNotebookReceipt(stale)).toBe(false);
      expect(
        analytics.mutateTableNotebookReceipt({ kind: 'retire', key, expectedValue: stale.value })
      ).toBe(false);
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({ value });
      expect(
        analytics.mutateTableNotebookReceipt({
          ...stale,
          origin: freshOrigin,
          expectedValue: value,
          value: JSON.stringify({ ...fresh, cells: 'PRIVATE_CELL_FORBIDDEN' }),
        })
      ).toBe(false);
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({ value });
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });

  it('keeps an explicit basis and the original clock on a default reaffirmation', async () => {
    const db = feedbackDatabase();
    try {
      db.exec(`INSERT INTO settings VALUES ('analytics_consent_basis','explicit',0);`);
      const analytics = await import('../analytics');
      analytics.persistAnalyticsConsent(true);
      const rows = db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all();
      expect(rows).toEqual([
        { key: 'analytics_consent', value: 'true', updated_at: 0 },
        { key: 'analytics_consent_basis', value: 'explicit', updated_at: 0 },
        { key: 'analytics_consent_version', value: '3', updated_at: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it('retains the original table commit across a real database reopen only under native cold-resume authority', async () => {
    const fixture = createFileTestDb('table-commit-cold-resume');
    let reopened: Database.Database | undefined;
    try {
      feedbackDatabase(fixture.db);
      let analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const key = 'table_notebook_reopen_v1:synthetic-cold-row';
      const acceptedAtMs = Date.now();
      const accepted = {
        version: 1,
        phase: 'accepted',
        operationId: randomUUID(),
        revisionId: randomUUID(),
        acceptedAtMs,
        origin,
        appSessionId: randomUUID(),
        episodeCorrelationId: randomUUID(),
        observation: {
          version: 1,
          operation: 'paste',
          surface: 'expanded',
          rows: 2,
          columns: 3,
          calculation: {
            result: 'none',
            evaluatedCount: 0,
            errorCount: 0,
            savedCount: 0,
            staleCount: 0,
            unavailableCount: 0,
          },
        },
      };
      const marker = JSON.stringify(accepted);
      expect(
        analytics.mutateTableNotebookReceipt({
          kind: 'write',
          key,
          expectedValue: null,
          value: marker,
          updatedAtMs: acceptedAtMs,
          origin,
        })
      ).toBe(true);
      const committed = {
        ...accepted,
        phase: 'committed',
        path: '/synthetic/Book',
        authorityFingerprint: 'synthetic-native-publication',
        committedAtMs: Date.now(),
        committedEventId: randomUUID(),
      };
      const value = JSON.stringify(committed);
      expect(
        analytics.mutateTableNotebookReceipt({
          kind: 'write',
          key,
          expectedValue: marker,
          value,
          updatedAtMs: committed.committedAtMs,
          origin,
        })
      ).toBe(true);
      await analytics.shutdownAnalytics();
      fixture.db.close();
      vi.resetModules();
      reopened = openFileTestDb(fixture.dbPath);
      mockGetDb.mockReturnValue(reopened);
      analytics = await initialize();
      const current = analytics.captureOptionalTelemetryOrigin()!;
      expect(current.contextId).toBe(origin.contextId);
      expect(current.processId).not.toBe(origin.processId);
      expect(
        analytics.mutateTableNotebookReceipt({
          kind: 'write',
          key,
          expectedValue: value,
          value: JSON.stringify({
            ...committed,
            phase: 'reopened',
            readbackMatch: true,
            reopenedAtMs: Date.now(),
            reopenedEventId: randomUUID(),
          }),
          updatedAtMs: Date.now(),
          origin: current,
        })
      ).toBe(true);
      const stored = JSON.parse(
        (reopened.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string })
          .value
      );
      expect(stored).toMatchObject({ ...committed, phase: 'reopened', readbackMatch: true });
      const events = reopened
        .prepare(
          "SELECT event_id, created_at_ms, properties_json FROM analytics_event_outbox WHERE reference_kind = 'table_notebook_revision'"
        )
        .all() as { event_id: string; created_at_ms: number; properties_json: string }[];
      expect(events.map((event) => event.event_id).sort()).toEqual(
        [committed.committedEventId, stored.reopenedEventId].sort()
      );
      expect(
        events.find((event) => event.event_id === committed.committedEventId)!.created_at_ms
      ).toBe(committed.committedAtMs);
      analytics.recoverTableNotebookTelemetry();
      expect(
        reopened
          .prepare(
            "SELECT event_id FROM analytics_event_outbox WHERE reference_kind = 'table_notebook_revision'"
          )
          .all()
      ).toHaveLength(2);
      analytics.persistAnalyticsConsent(false);
      expect(reopened.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toBeUndefined();
      await analytics.shutdownAnalytics();
    } finally {
      reopened?.close();
      fixture.cleanup();
    }
  });

  it('never manufactures operation/calculation provenance for legacy rows or permits mutation after acceptance', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const key = 'table_notebook_reopen_v1:synthetic-provenance-row';
      const accepted = {
        version: 1,
        phase: 'accepted',
        operationId: randomUUID(),
        revisionId: randomUUID(),
        acceptedAtMs: Date.now(),
        origin,
        appSessionId: randomUUID(),
        episodeCorrelationId: randomUUID(),
      };
      const marker = JSON.stringify(accepted);
      const write = (expectedValue: string | null, value: string) =>
        analytics.mutateTableNotebookReceipt({
          kind: 'write',
          key,
          expectedValue,
          value,
          updatedAtMs: Date.now(),
          origin,
        });
      expect(write(null, marker)).toBe(true);
      const committed = {
        ...accepted,
        phase: 'committed',
        path: '/synthetic/Book',
        authorityFingerprint: 'synthetic-native-publication',
        committedAtMs: Date.now(),
        committedEventId: randomUUID(),
      };
      const legacy = JSON.stringify(committed);
      expect(write(marker, legacy)).toBe(true);
      analytics.recoverTableNotebookTelemetry();
      expect(
        db
          .prepare(
            "SELECT event_id FROM analytics_event_outbox WHERE reference_kind = 'table_notebook_revision'"
          )
          .all()
      ).toEqual([]);
      const observation = {
        version: 1,
        operation: 'paste',
        surface: 'expanded',
        rows: 2,
        columns: 3,
        calculation: {
          result: 'mixed_failed',
          evaluatedCount: 2,
          errorCount: 1,
          savedCount: 1,
          staleCount: 1,
          unavailableCount: 0,
        },
      };
      expect(
        write(
          legacy,
          JSON.stringify({
            ...committed,
            phase: 'reopened',
            readbackMatch: true,
            reopenedAtMs: Date.now(),
            reopenedEventId: randomUUID(),
            observation,
          })
        )
      ).toBe(false);
      const fresh = {
        ...accepted,
        operationId: randomUUID(),
        revisionId: randomUUID(),
        observation,
      };
      const freshMarker = JSON.stringify(fresh);
      expect(write(legacy, freshMarker)).toBe(true);
      const next = { ...committed, ...fresh, phase: 'committed', committedEventId: randomUUID() };
      expect(
        write(
          freshMarker,
          JSON.stringify({ ...next, observation: { ...observation, operation: 'edit' } })
        )
      ).toBe(false);
      expect(
        write(
          freshMarker,
          JSON.stringify({ ...next, observation: { ...observation, cells: 'PRIVATE_SCIENCE' } })
        )
      ).toBe(false);
      expect(
        write(
          freshMarker,
          JSON.stringify({ ...next, observation: { ...observation, rows: 1_000_001 } })
        )
      ).toBe(false);
      expect(write(freshMarker, JSON.stringify(next))).toBe(true);
      const events = db
        .prepare(
          "SELECT properties_json FROM analytics_event_outbox WHERE reference_kind = 'table_notebook_revision'"
        )
        .all() as { properties_json: string }[];
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].properties_json)).toMatchObject({
        table_operation: 'paste',
        table_surface: 'expanded',
        table_calculation_result: 'mixed_failed',
        table_rows: 2,
        table_columns: 3,
        table_formula_count: 2,
        table_calculation_error_count: 1,
        table_saved_result_count: 1,
        table_stale_result_count: 1,
        success: true,
        outcome_kind: 'table_save_committed',
      });
      expect(events[0].properties_json).not.toContain('PRIVATE_SCIENCE');
      expect(events[0].properties_json).not.toContain('/synthetic/Book');
      expect(events[0].properties_json).not.toContain('synthetic-native-publication');
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });

  it.each(['consent', 'context'] as const)(
    'sends native restore stages once through the shared SDK and retires authority on %s change',
    async (retirement) => {
      const file = createFileTestDb('native-restore-sdk');
      const db = file.db;
      const { ensureSchema } = await import('../schema');
      ensureSchema(db, file.dbPath);
      const put = db.prepare(
        'INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)'
      );
      put.run('analytics_consent', 'true', 0);
      put.run('analytics_consent_version', '3', 0);
      db.prepare(
        `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at) VALUES (1,'PRIVATE_RESTORE','/private/restore','private-workspace',1,1)`
      ).run();
      mockGetDb.mockReturnValue(db);
      const analytics = await initialize();
      const metrics = await import('../workspace-sync-restore-telemetry');
      const held: Array<
        () =>
          | import('../workspace-sync-restore-telemetry').WorkspaceSyncRestoreTelemetryEvent
          | null
      > = [];
      const lock = randomUUID();
      try {
        const context = {
          ...CONTEXT,
          kind: 'identified' as const,
          generation: CONTEXT.generation + 1,
        };
        expect(analytics.syncAnalyticsIdentityContext(context)).toBe(true);
        const original = analytics.captureOptionalTelemetryOrigin();
        metrics.configureWorkspaceSyncRestoreTelemetry({
          captureOrigin: () => analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId),
          currentAccountId: () => CONTEXT.distinctId,
          openCommittedDatabase: () => openReadonlyFileTestDb(file.dbPath),
          publish: (reader) => {
            held.push(reader);
            return analytics.enqueueOptionalAnalyticsEventFromReceipt(reader);
          },
        });
        db.transaction(() => {
          db.prepare(
            `INSERT INTO workspace_sync_restore_locks (workspace_id,lock_id,source_remote_version_id,remote_workspace_id,owner_account_id,status,started_at,expires_at) VALUES (1,?,'private-version','private-remote',?,'restoring',100,1000)`
          ).run(lock, CONTEXT.distinctId);
          metrics.acceptWorkspaceSyncRestoreTelemetry(db, lock);
          db.prepare(
            "UPDATE workspace_sync_restore_locks SET status='completed',completed_at=150 WHERE lock_id=?"
          ).run(lock);
          metrics.settleWorkspaceSyncRestoreTelemetry(db, lock);
        })();
        metrics.publishWorkspaceSyncRestoreTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        const wire = () =>
          mockPostHog.capture.mock.calls
            .filter(
              ([value]) =>
                value.event === 'workspace_sync_stage' &&
                value.properties.sync_operation === 'restore'
            )
            .map(([value]) => value);
        expect(wire().map((v) => v.properties.sync_stage)).toEqual(['accepted', 'restored']);
        expect(wire().map((v) => v.timestamp)).toEqual([new Date(100), new Date(150)]);
        expect(new Set(wire().map((v) => v.properties.$insert_id)).size).toBe(2);
        for (const value of wire()) {
          expect(value.distinctId).toBe(CONTEXT.distinctId);
          expect(value.properties).toMatchObject({ operation_id: lock, origin_started_at_ms: 100 });
        }
        expect(JSON.stringify(wire())).not.toMatch(
          /PRIVATE_RESTORE|private-workspace|private-version|private-remote|private\/restore|sourceVersionId|ownerAccountId/
        );
        expect(JSON.stringify(wire())).not.toContain(original?.consentScope);
        expect(JSON.stringify(wire())).not.toContain(original?.contextId);
        metrics.publishWorkspaceSyncRestoreTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        expect(wire()).toHaveLength(2);
        const reader = held.at(-1);
        expect(reader?.()).not.toBeNull();
        const native = db.prepare('SELECT * FROM workspace_sync_restore_locks').get();
        if (retirement === 'consent') analytics.persistAnalyticsConsent(false);
        else
          analytics.syncAnalyticsIdentityContext({
            ...context,
            generation: context.generation + 1,
          });
        expect(reader?.()).toBeNull();
        expect(db.prepare('SELECT * FROM workspace_sync_restore_locks').get()).toEqual(native);
        await analytics.shutdownAnalytics();
      } finally {
        metrics.configureWorkspaceSyncRestoreTelemetry(null);
        file.cleanup();
      }
    }
  );

  it('keeps private, unknown and synthetic runtime provenance distinct on Reference SDK publication', async () => {
    const file = createFileTestDb('reference-runtime-provenance');
    const { ensureSchema } = await import('../schema');
    ensureSchema(file.db, file.dbPath);
    const setting = file.db.prepare(
      'INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)'
    );
    setting.run('analytics_consent', 'true', 0);
    setting.run('analytics_consent_version', '3', 0);
    const publications = new Map<'private' | 'unknown' | 'synthetic', Record<string, unknown>[]>();
    const correlationProperties = new Set([
      'operation_id',
      'occurred_at_ms',
      'origin_started_at_ms',
      '$session_id',
      'app_session_id',
      'pseudonymous_install_id',
      'telemetry_canary_id',
      'ci_run_id',
    ]);
    try {
      for (const subject of [
        { kind: 'test', packaged: true, synthetic: false, classification: 'private' },
        { kind: 'unknown', packaged: true, synthetic: false, classification: 'unknown' },
        { kind: 'test', packaged: false, synthetic: true, classification: 'synthetic' },
      ] as const) {
        vi.resetModules();
        mockPostHog.capture.mockClear();
        mockGetDb.mockReturnValue(file.db);
        electronAppState.isPackaged = subject.packaged;
        vi.stubGlobal('__DNAFORGE_APP_BUILD__', {
          kind: subject.kind,
          version: '1.0.0',
          sourceReleaseVersion: '1.0.0',
          sourceCommit: '1234567890123456789012345678901234567890',
          sourceModified: false,
        });
        vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', 'closed_beta');
        vi.stubGlobal('__DNAFORGE_BUILD_TAG__', actorBuildTagStamp);
        vi.stubGlobal('__POSTHOG_API_KEY__', 'phc_test123');
        delete process.env.POSTHOG_API_KEY;
        vi.stubEnv('DNAFORGE_TELEMETRY_CANARY_ID', '');
        vi.stubEnv('DNAFORGE_TELEMETRY_ENVIRONMENT', '');
        const analytics = await import('../analytics');
        const { beginHostedReferenceInstallObservation } =
          await import('../reference-assets/hosted-reference-install-telemetry');
        try {
          analytics.initAnalyticsMain(
            subject.synthetic
              ? { DNAFORGE_TELEMETRY_CANARY_ID: '66666666-6666-4666-8666-666666666666' }
              : {},
            { consent: 'true', version: '3' }
          );
          expect(analytics.syncAnalyticsIdentityContext(CONTEXT)).toBe(true);
          expect(analytics.captureOptionalTelemetryOrigin()?.classification).toBe(
            subject.classification
          );
          beginHostedReferenceInstallObservation(
            (observation) =>
              analytics.trackAllowedEvent('hosted_reference_install_observed', observation),
            () => 100
          );
          const outgoing = mockPostHog.capture.mock.calls
            .filter(([value]) => value.event === 'hosted_reference_install_observed')
            .map(([value]) => value.properties);
          expect(outgoing).toHaveLength(1);
          expect(outgoing).toMatchObject([
            {
              feature_area: 'scientific_workflow',
              install_phase: 'started',
              is_synthetic: subject.synthetic,
              telemetry_actor: subject.synthetic ? 'canary' : 'user',
            },
          ]);
          publications.set(
            subject.classification,
            outgoing.map((properties) =>
              Object.fromEntries(
                Object.entries(properties).filter(([key]) => !correlationProperties.has(key))
              )
            )
          );
        } finally {
          await analytics.shutdownAnalytics();
        }
      }
      expect(publications.get('synthetic')).not.toEqual(publications.get('private'));
      expect(publications.get('synthetic')).not.toEqual(publications.get('unknown'));
      expect(publications.get('private')).not.toEqual(publications.get('unknown'));
    } finally {
      file.cleanup();
    }
  });

  function optionalInput() {
    const id = randomUUID();
    return {
      eventId: id,
      eventName: 'benchling_migration_run_disposition_changed' as const,
      payloadSchemaVersion: 1 as const,
      referenceKind: 'benchling_migration_disposition' as const,
      referenceId: id,
      properties: { $insert_id: id, prior_outcome: 'failed', disposition: 'discarded' },
      createdAtMs: 100,
    };
  }
  it.each([
    {
      name: 'ordinary published release',
      kind: 'release',
      packaged: true,
      tagged: true,
      actor: '',
      expected: 'eligible_release',
    },
    {
      name: 'packaged test build',
      kind: 'test',
      packaged: true,
      tagged: true,
      actor: '',
      expected: 'private',
    },
    {
      name: 'development build',
      kind: 'development',
      packaged: false,
      tagged: false,
      actor: '',
      expected: 'private',
    },
    {
      name: 'asserted packaged maintainer',
      kind: 'release',
      packaged: true,
      tagged: true,
      actor: 'maintainer',
      expected: 'private',
    },
    {
      name: 'asserted packaged CI',
      kind: 'release',
      packaged: true,
      tagged: true,
      actor: 'ci',
      expected: 'synthetic',
    },
    {
      name: 'authorized test canary',
      kind: 'test',
      packaged: false,
      tagged: false,
      actor: '',
      canary: true,
      expected: 'synthetic',
    },
    {
      name: 'unknown build identity',
      kind: 'unknown',
      packaged: true,
      tagged: true,
      actor: '',
      expected: 'unknown',
    },
    {
      name: 'untagged packaged build',
      kind: 'release',
      packaged: true,
      tagged: false,
      actor: '',
      expected: 'unknown',
    },
    {
      name: 'release with staging runtime authority',
      kind: 'release',
      packaged: true,
      tagged: true,
      actor: '',
      staging: true,
      expected: 'unknown',
    },
  ] as const)(
    'keeps $name provenance on committed native enablement at SDK egress',
    async (subject) => {
      electronAppState.isPackaged = subject.packaged;
      vi.stubGlobal('__DNAFORGE_APP_BUILD__', {
        kind: subject.kind,
        version: '1.0.0',
        sourceReleaseVersion: '1.0.0',
        sourceCommit: '1234567890123456789012345678901234567890',
        sourceModified: false,
      });
      vi.stubGlobal('__DNAFORGE_RELEASE_CHANNEL__', 'closed_beta');
      vi.stubGlobal('__DNAFORGE_BUILD_TAG__', subject.tagged ? actorBuildTagStamp : '');
      vi.stubGlobal('__POSTHOG_API_KEY__', 'phc_test123');
      delete process.env.POSTHOG_API_KEY;
      const config: Record<string, string> = {};
      if (subject.actor === 'maintainer' || subject.actor === 'ci') {
        vi.stubGlobal(
          '__DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__',
          sealTelemetryActorAssertionPublicKey(actorAssertionPublicKey)
        );
        config.DNAFORGE_TELEMETRY_ACTOR = subject.actor;
        config.DNAFORGE_TELEMETRY_ACTOR_ASSERTION = actorAssertion(
          subject.actor,
          subject.actor === 'ci' ? '32902696778' : undefined
        );
        if (subject.actor === 'ci') config.GITHUB_RUN_ID = '32902696778';
      }
      if ('canary' in subject)
        config.DNAFORGE_TELEMETRY_CANARY_ID = '66666666-6666-4666-8666-666666666666';
      if ('staging' in subject) {
        config.POSTHOG_API_KEY = 'phc_test123';
        config.POSTHOG_HOST = 'http://127.0.0.1:9999';
        config.DNAFORGE_TELEMETRY_ENVIRONMENT = 'staging';
      }
      const file = createFileTestDb('native-origin-classification');
      const db = file.db;
      const { ensureSchema } = await import('../schema');
      ensureSchema(db, file.dbPath);
      db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
        'analytics_consent',
        'true',
        0
      );
      db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
        'analytics_consent_version',
        '3',
        0
      );
      db.prepare(
        `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at) VALUES (1,'PRIVATE_CLASSIFICATION_PROJECT','/private/classification/project','workspace-a',1,1)`
      ).run();
      mockGetDb.mockReturnValue(db);
      const analytics = await import('../analytics');
      const metrics = await import('../workspace-sync-enablement-telemetry');
      const owner = await import('../workspace-sync-binding');
      try {
        analytics.initAnalyticsMain(config, { consent: 'true', version: '3' });
        expect(
          analytics.syncAnalyticsIdentityContext({
            ...CONTEXT,
            kind: 'identified',
            generation: CONTEXT.generation + 1,
          })
        ).toBe(true);
        expect(analytics.captureOptionalTelemetryOrigin()?.classification).toBe(subject.expected);
        metrics.configureWorkspaceSyncEnablementTelemetry({
          captureOrigin: () => analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId),
          currentAccountId: () => CONTEXT.distinctId,
          openCommittedDatabase: () => openReadonlyFileTestDb(file.dbPath),
          publish: (reader) => analytics.enqueueOptionalAnalyticsEventFromReceipt(reader),
        });
        const time = vi.spyOn(Date, 'now').mockReturnValue(100);
        try {
          await owner.ensureWorkspaceSyncBinding(db, {
            workspaceUuid: 'workspace-a',
            ownerAccountId: CONTEXT.distinctId,
            ownerOrgId: null,
            nowMs: 10,
            claimClient: {
              claimWorkspace: async (request) => ({
                clientWorkspaceId: request.clientWorkspaceId,
                remoteWorkspaceId: '44444444-4444-4444-8444-444444444444',
                claimedByAccountId: request.ownerAccountId,
                owner: { kind: 'personal', accountId: request.ownerAccountId },
              }),
            },
          });
        } finally {
          time.mockRestore();
        }
        metrics.publishWorkspaceSyncEnablementTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        const outgoing = mockPostHog.capture.mock.calls
          .filter(([value]) => value.event === 'workspace_backup_enabled')
          .map(([value]) => value);
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]).toMatchObject({
          distinctId: CONTEXT.distinctId,
          timestamp: new Date(100),
          properties: {
            workspace_origin_class: subject.expected,
            origin_started_at_ms: 100,
            occurred_at_ms: 100,
          },
        });
        expect(JSON.stringify(outgoing)).not.toMatch(
          /PRIVATE_CLASSIFICATION_PROJECT|private\/classification|workspace-a|ownerAccountId|remoteWorkspaceId/
        );
      } finally {
        metrics.configureWorkspaceSyncEnablementTelemetry(null);
        await analytics.shutdownAnalytics();
        file.cleanup();
      }
    }
  );

  it.each(['consent', 'context'] as const)(
    'sends committed native enablement once through the shared SDK and retires optional authority on %s change',
    async (retirement) => {
      const file = createFileTestDb('native-enablement-sdk');
      const db = file.db;
      const { ensureSchema } = await import('../schema');
      ensureSchema(db, file.dbPath);
      db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
        'analytics_consent',
        'true',
        0
      );
      db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
        'analytics_consent_version',
        '3',
        0
      );
      db.prepare(
        `INSERT INTO workspaces (id,name,path,repo_uuid,created_at,last_opened_at)
         VALUES (1,'PRIVATE_ENABLE_PROJECT','/private/enable/project','workspace-a',1,1)`
      ).run();
      mockGetDb.mockReturnValue(db);
      const analytics = await initialize();
      const metrics = await import('../workspace-sync-enablement-telemetry');
      const owner = await import('../workspace-sync-binding');
      const native = await import('../workspace-sync-enablement');
      const held: Array<() => WorkspaceSyncEnablementTelemetryEvent | null> = [];
      try {
        const nativeContext = {
          ...CONTEXT,
          kind: 'identified' as const,
          generation: CONTEXT.generation + 1,
        };
        expect(analytics.syncAnalyticsIdentityContext(nativeContext)).toBe(true);
        const original = analytics.captureOptionalTelemetryOrigin();
        expect(original).not.toBeNull();
        metrics.configureWorkspaceSyncEnablementTelemetry({
          captureOrigin: () => analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId),
          currentAccountId: () => CONTEXT.distinctId,
          openCommittedDatabase: () => openReadonlyFileTestDb(file.dbPath),
          publish: (reader) => {
            held.push(reader);
            return analytics.enqueueOptionalAnalyticsEventFromReceipt(reader);
          },
        });
        const time = vi.spyOn(Date, 'now').mockReturnValue(100);
        try {
          await owner.ensureWorkspaceSyncBinding(db, {
            workspaceUuid: 'workspace-a',
            ownerAccountId: CONTEXT.distinctId,
            ownerOrgId: null,
            nowMs: 10,
            claimClient: {
              claimWorkspace: async (request) => ({
                clientWorkspaceId: request.clientWorkspaceId,
                remoteWorkspaceId: '44444444-4444-4444-8444-444444444444',
                claimedByAccountId: request.ownerAccountId,
                owner: { kind: 'personal', accountId: request.ownerAccountId },
              }),
            },
          });
        } finally {
          time.mockRestore();
        }
        const accepted = native.readWorkspaceSyncEnablement(db, 'workspace-a');
        metrics.publishWorkspaceSyncEnablementTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        const wire = () =>
          mockPostHog.capture.mock.calls
            .filter(([value]) => value.event === 'workspace_backup_enabled')
            .map(([value]) => value);
        expect(wire()).toHaveLength(1);
        expect(wire()[0]?.distinctId).toBe(CONTEXT.distinctId);
        expect(wire()[0]?.timestamp).toEqual(new Date(100));
        expect(wire()[0]?.properties.workspace_origin_class).toBe(original?.classification);
        expect(wire()[0]?.properties).toMatchObject({
          feature_area: 'workspace',
          operation_id: accepted?.episodes[0]?.operationId,
          origin_started_at_ms: 100,
          occurred_at_ms: 100,
        });
        expect(JSON.stringify(wire())).not.toMatch(
          /workspace-a|PRIVATE_ENABLE_PROJECT|private\/enable|ownerAccountId|remoteWorkspaceId/
        );
        expect(JSON.stringify(wire())).not.toContain(original?.consentScope);
        expect(JSON.stringify(wire())).not.toContain(original?.contextId);
        metrics.publishWorkspaceSyncEnablementTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        expect(wire()).toHaveLength(1);
        const readHeld = held.at(-1);
        expect(readHeld?.()).not.toBeNull();
        expect(
          analytics.enqueueOptionalAnalyticsEventFromReceipt(() => {
            const receipt = readHeld?.();
            return receipt
              ? {
                  ...receipt,
                  event: {
                    ...receipt.event,
                    properties: {
                      ...receipt.event.properties,
                      workspace_origin_class: 'eligible_release',
                    },
                  },
                }
              : null;
          })
        ).toBe(false);
        const neighbors = [
          '_cloud_backup_enable_telemetry_receipt_v10:neighbor',
          '_cloud_backup_enable_telemetry_receipt_v1',
          'Xcloud_backup_enable_telemetry_receipt_v1:neighbor',
        ];
        for (const key of neighbors)
          db.prepare('INSERT INTO settings VALUES (?,?,?)').run(key, 'preserved', 100);
        if (retirement === 'consent') analytics.persistAnalyticsConsent(false);
        else
          analytics.syncAnalyticsIdentityContext({
            ...nativeContext,
            generation: nativeContext.generation + 1,
          });
        expect(readHeld?.()).toBeNull();
        expect(native.readWorkspaceSyncEnablement(db, 'workspace-a')).toEqual(accepted);
        for (const key of neighbors)
          expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({
            value: 'preserved',
          });
        await analytics.shutdownAnalytics();
      } finally {
        metrics.configureWorkspaceSyncEnablementTelemetry(null);
        file.cleanup();
      }
    }
  );

  function nativeUploadJob(): WorkspaceSyncQueueJob {
    return {
      acceptedOperationId: '66666666-6666-4666-8666-666666666666',
      acceptedOperationStartedAt: 100,
      id: 'native-upload-private-job',
      workspaceId: 1,
      operation: 'upload',
      status: 'pending',
      idempotencyKey: 'private-content-key',
      baseRemoteVersionId: 'private-remote-version',
      localHeadSha: 'private-head',
      bundleContentSha256: 'private-scientific-content',
      attemptCount: 0,
      nextAttemptAt: null,
      lockedAt: null,
      lockedByDeviceId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 100,
      updatedAt: 100,
    };
  }

  it.each(['consent', 'context'] as const)(
    'sends committed native upload stages once through the shared SDK and retires v2 authority on %s change',
    async (retirement) => {
      const file = createFileTestDb('native-upload-stage-sdk');
      const db = feedbackDatabase(file.db);
      const analytics = await initialize();
      const metrics = await import('../workspace-sync-upload-telemetry');
      const held: Array<() => WorkspaceSyncUploadTelemetryEvent | null> = [];
      try {
        const nativeContext = {
          ...CONTEXT,
          kind: 'identified' as const,
          generation: CONTEXT.generation + 1,
        };
        expect(analytics.syncAnalyticsIdentityContext(nativeContext)).toBe(true);
        const original = analytics.captureOptionalTelemetryOrigin()!;
        metrics.configureWorkspaceSyncUploadTelemetry({
          captureOrigin: () => analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId),
          currentAccountId: () => CONTEXT.distinctId,
          openCommittedDatabase: () => openReadonlyFileTestDb(file.dbPath),
          publish: (reader) => {
            held.push(reader);
            return analytics.enqueueOptionalAnalyticsEventFromReceipt(reader);
          },
        });
        const job = nativeUploadJob();
        db.transaction(() =>
          metrics.acceptWorkspaceSyncUploadTelemetry(db, {
            job,
            ownerAccountId: CONTEXT.distinctId,
            nowMs: 100,
            retry: false,
          })
        )();
        db.transaction(() =>
          metrics.settleWorkspaceSyncUploadTelemetry(db, {
            job,
            operationId: metrics.readWorkspaceSyncUploadTelemetryOperation(db, job),
            outcome: 'uploaded',
            nowMs: 200,
          })
        )();
        metrics.publishWorkspaceSyncUploadTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        const wire = () =>
          mockPostHog.capture.mock.calls
            .filter(([value]) => value.event === 'workspace_sync_stage')
            .map(([value]) => value);
        expect(wire()).toHaveLength(2);
        expect(wire().map((value) => value.properties.sync_stage)).toEqual([
          'accepted',
          'uploaded',
        ]);
        expect(wire().map((value) => value.timestamp)).toEqual([new Date(100), new Date(200)]);
        expect(new Set(wire().map((value) => value.uuid)).size).toBe(2);
        expect(wire()[1]?.properties).toMatchObject({
          operation_id: wire()[0]?.properties.operation_id,
          origin_started_at_ms: 100,
          occurred_at_ms: 200,
        });
        expect(JSON.stringify(wire())).not.toMatch(
          /native-upload-private-job|private-content|private-head|private-remote|private-scientific/
        );
        expect(JSON.stringify(wire())).not.toContain(original.consentScope);
        expect(JSON.stringify(wire())).not.toContain(original.contextId);
        expect(
          mockPostHog.capture.mock.calls.filter(
            ([value]) =>
              value.event === 'meaningful_activity_completed' ||
              value.event === 'workspace_sync_observed'
          )
        ).toHaveLength(0);
        metrics.publishWorkspaceSyncUploadTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        expect(wire()).toHaveLength(2);
        const readHeld = held.at(-1);
        expect(readHeld).not.toBeNull();
        expect(readHeld?.()).not.toBeNull();
        const neighbors = [
          '_cloud_backup_telemetry_receipt_v20:neighbor',
          '_cloud_backup_telemetry_receipt_v2',
          'Xcloud_backup_telemetry_receipt_v2:neighbor',
        ];
        for (const key of neighbors)
          db.prepare('INSERT INTO settings VALUES (?,?,?)').run(key, 'preserved', 100);
        if (retirement === 'consent') analytics.persistAnalyticsConsent(false);
        else
          analytics.syncAnalyticsIdentityContext({
            ...nativeContext,
            generation: nativeContext.generation + 1,
          });
        expect(
          db
            .prepare('SELECT key FROM settings WHERE substr(key,1,?) = ?')
            .all(
              metrics.WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX.length,
              metrics.WORKSPACE_SYNC_UPLOAD_RECEIPT_PREFIX
            )
        ).toEqual([]);
        expect(readHeld?.()).toBeNull();
        for (const key of neighbors)
          expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({
            value: 'preserved',
          });
        metrics.publishWorkspaceSyncUploadTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        expect(wire()).toHaveLength(2);
      } finally {
        metrics.configureWorkspaceSyncUploadTelemetry(null);
        await analytics.shutdownAnalytics();
        file.cleanup();
      }
    }
  );

  it.each([
    { event: 'workspace_sync_stage', route: 'direct' },
    { event: 'workspace_sync_stage', route: 'optional' },
    { event: 'workspace_recovery_stage', route: 'direct' },
    { event: 'workspace_recovery_stage', route: 'optional' },
    { event: 'workspace_backup_enabled', route: 'direct' },
    { event: 'workspace_backup_enabled', route: 'optional' },
  ] as const)(
    'refuses native receipt stages through uncommitted main ingress: $event/$route',
    async ({ event, route }) => {
      const db = feedbackDatabase();
      const analytics = await initialize();
      try {
        const origin = analytics.captureOptionalTelemetryOrigin();
        if (!origin) throw new Error('Expected the current consented main origin.');
        const id = randomUUID();
        const properties = {
          feature_area: 'workspace',
          operation_id: id,
          origin_started_at_ms: 100,
          occurred_at_ms: event === 'workspace_backup_enabled' ? 100 : 200,
          ...(event === 'workspace_sync_stage'
            ? { sync_operation: 'upload', sync_stage: 'uploaded' }
            : event === 'workspace_recovery_stage'
              ? { recovery_stage: 'retained' }
              : {}),
        };
        mockPostHog.capture.mockClear();
        if (route === 'direct') {
          expect(analytics.trackAllowedEvent(event, properties)).toBe(false);
          expect(analytics.trackEvent(event, properties)).toBe(false);
        } else {
          expect(
            analytics.enqueueOptionalAnalyticsEvent(origin, {
              eventId: id,
              eventName: event,
              payloadSchemaVersion: 1,
              referenceKind:
                event === 'workspace_sync_stage'
                  ? 'workspace_sync_upload'
                  : event === 'workspace_recovery_stage'
                    ? 'workspace_sync_recovery'
                    : 'workspace_sync_enablement',
              referenceId: id,
              properties,
              createdAtMs: event === 'workspace_backup_enabled' ? 100 : 200,
            })
          ).toBe(false);
        }
        await analytics.drainMainAnalyticsOutbox();
        expect(
          mockPostHog.capture.mock.calls.filter(([value]) => value.event === event)
        ).toHaveLength(0);
      } finally {
        await analytics.shutdownAnalytics();
        db.close();
      }
    }
  );

  it.each(['consent', 'context'] as const)(
    'sends committed native recovery stages once through the shared SDK and retires their authority on %s change',
    async (retirement) => {
      const file = createFileTestDb('native-recovery-stage-sdk');
      const db = feedbackDatabase(file.db);
      const analytics = await initialize();
      const metrics = await import('../workspace-sync-recovery-telemetry');
      const held: Array<() => WorkspaceSyncRecoveryTelemetryEvent | null> = [];
      try {
        const nativeContext = {
          ...CONTEXT,
          kind: 'identified' as const,
          generation: CONTEXT.generation + 1,
        };
        expect(analytics.syncAnalyticsIdentityContext(nativeContext)).toBe(true);
        const original = analytics.captureOptionalTelemetryOrigin()!;
        metrics.configureWorkspaceSyncRecoveryTelemetry({
          captureOrigin: () => analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId),
          currentAccountId: () => CONTEXT.distinctId,
          openCommittedDatabase: () => openReadonlyFileTestDb(file.dbPath),
          publish: (reader) => {
            held.push(reader);
            return analytics.enqueueOptionalAnalyticsEventFromReceipt(reader);
          },
        });
        const job = nativeUploadJob();
        const intent: WorkspaceSyncRecoveryCandidateIntent = {
          schema: 'dnaforge.desktop-recovery-intent/v1',
          acceptedOperationId: '77777777-7777-4777-8777-777777777777',
          parentAcceptedOperationId: null,
          idempotencyKey: 'candidate:private-content-key',
          ownerAccountId: CONTEXT.distinctId,
          remoteWorkspaceId: 'private-remote',
          localHeadSha: 'private-head',
          snapshotContentSha256: 'a'.repeat(64),
          requestSha256: 'b'.repeat(64),
          createdAtMs: 100,
          retainedAtMs: null,
        };
        const retained = {
          ...intent,
          retainedAtMs: 200,
          receipt: {
            id: '88888888-8888-4888-8888-888888888888',
            accountId: CONTEXT.distinctId,
            baseVersionId: null,
            contentSha256: intent.snapshotContentSha256,
            requestSha256: intent.requestSha256,
            reason: 'dirty',
            coverage: 'captured-bytes',
            createdAt: '2026-11-02T00:00:00.000Z',
            expiresAt: '2026-11-09T00:00:00.000Z',
          },
        } satisfies WorkspaceSyncRecoveryCandidateIntent;
        db.transaction(() =>
          metrics.acceptWorkspaceSyncRecoveryTelemetry(db, {
            job,
            intent,
            previousOperationId: null,
            nowMs: 100,
          })
        )();
        db.transaction(() =>
          metrics.settleWorkspaceSyncRecoveryTelemetry(db, { job, intent: retained })
        )();
        metrics.publishWorkspaceSyncRecoveryTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        const wire = () =>
          mockPostHog.capture.mock.calls
            .filter(([value]) => value.event === 'workspace_recovery_stage')
            .map(([value]) => value);
        expect(wire()).toHaveLength(2);
        expect(wire().map((value) => value.properties.recovery_stage)).toEqual([
          'accepted',
          'retained',
        ]);
        expect(wire().map((value) => value.timestamp)).toEqual([new Date(100), new Date(200)]);
        expect(new Set(wire().map((value) => value.uuid)).size).toBe(2);
        expect(wire()[1]?.properties).toMatchObject({
          operation_id: intent.acceptedOperationId,
          origin_started_at_ms: 100,
          occurred_at_ms: 200,
        });
        expect(JSON.stringify(wire())).not.toMatch(
          /native-upload-private-job|private-content|private-head|private-remote|private-scientific/
        );
        for (const value of [
          intent.snapshotContentSha256,
          intent.requestSha256,
          retained.receipt.id,
          original.consentScope,
          original.contextId,
        ])
          expect(JSON.stringify(wire())).not.toContain(value);
        expect(
          mockPostHog.capture.mock.calls.filter(
            ([value]) =>
              value.event === 'meaningful_activity_completed' ||
              value.event === 'workspace_sync_observed' ||
              value.event === 'workspace_sync_stage'
          )
        ).toHaveLength(0);
        metrics.publishWorkspaceSyncRecoveryTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        expect(wire()).toHaveLength(2);
        const readHeld = held.at(-1);
        expect(readHeld?.()).not.toBeNull();
        const neighbors = [
          '_cloud_backup_recovery_telemetry_receipt_v10:neighbor',
          '_cloud_backup_recovery_telemetry_receipt_v1',
          'Xcloud_backup_recovery_telemetry_receipt_v1:neighbor',
        ];
        for (const key of neighbors)
          db.prepare('INSERT INTO settings VALUES (?,?,?)').run(key, 'preserved', 100);
        if (retirement === 'consent') analytics.persistAnalyticsConsent(false);
        else
          analytics.syncAnalyticsIdentityContext({
            ...nativeContext,
            generation: nativeContext.generation + 1,
          });
        expect(
          db
            .prepare('SELECT key FROM settings WHERE substr(key,1,?) = ?')
            .all(
              metrics.WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX.length,
              metrics.WORKSPACE_SYNC_RECOVERY_RECEIPT_PREFIX
            )
        ).toEqual([]);
        expect(readHeld?.()).toBeNull();
        for (const key of neighbors)
          expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({
            value: 'preserved',
          });
        metrics.publishWorkspaceSyncRecoveryTelemetry(db);
        await analytics.drainMainAnalyticsOutbox();
        expect(wire()).toHaveLength(2);
      } finally {
        metrics.configureWorkspaceSyncRecoveryTelemetry(null);
        await analytics.shutdownAnalytics();
        file.cleanup();
      }
    }
  );

  it('binds a native upload origin to its actual account while the prior analytics identity is still current', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      expect(analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId)).toBeNull();
      expect(
        analytics.syncAnalyticsIdentityContext({
          ...CONTEXT,
          kind: 'identified',
          generation: CONTEXT.generation + 1,
        })
      ).toBe(true);
      const matching = analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId);
      expect(matching).not.toBeNull();
      expect(matching).toEqual(analytics.captureOptionalTelemetryOrigin());
      const otherAccount = randomUUID();
      expect(analytics.captureOptionalTelemetryOrigin(otherAccount)).toBeNull();
      expect(analytics.captureOptionalTelemetryOrigin(CONTEXT.distinctId)).toEqual(matching);
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });

  it('issues no optional origin from an enabled flag or caller UUIDs without durable accepted context', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await import('../analytics');
      analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      const forged = {
        consentScope: randomUUID(),
        contextId: randomUUID(),
        processId: randomUUID(),
        classification: 'private' as const,
      };
      expect(analytics.enqueueOptionalAnalyticsEvent(forged, optionalInput())).toBe(false);
      expect(analytics.syncAnalyticsIdentityContext(CONTEXT)).toBe(true);
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      expect(Object.isFrozen(origin)).toBe(true);
      expect(origin).not.toBeNull();
      expect(
        analytics.enqueueOptionalAnalyticsEvent(
          { ...origin, classification: 'eligible_release' },
          optionalInput()
        )
      ).toBe(false);
      db.prepare("UPDATE settings SET value = 'false' WHERE key = 'analytics_consent'").run();
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput())).toBe(false);
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('returns exact pending/SENT presence only while original authority remains admissible', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const input = optionalInput();
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      const row = db
        .prepare('SELECT * FROM analytics_event_outbox WHERE event_id = ?')
        .get(input.eventId) as Record<string, unknown>;
      expect(row.sent_at_ms).not.toBeNull();
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(true);
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, { ...input, createdAtMs: 101 })).toBe(
        false
      );
      expect(
        analytics.enqueueOptionalAnalyticsEvent(origin, {
          ...input,
          properties: { ...input.properties, message: 'private decoy' },
        })
      ).toBe(false);
      expect(
        Reflect.apply(analytics.enqueueOptionalAnalyticsEvent, undefined, [
          origin,
          { ...input, eventName: 'auth_completed' },
        ])
      ).toBe(false);
      await analytics.drainMainAnalyticsOutbox();
      expect(
        db.prepare('SELECT * FROM analytics_event_outbox WHERE event_id = ?').get(input.eventId)
      ).toEqual(row);
      const wire = mockPostHog.capture.mock.calls.filter(
        ([value]) => value.uuid === input.eventId
      )[0]![0];
      expect(wire.timestamp).toEqual(new Date(100));
      expect(JSON.stringify(wire)).not.toContain(origin.consentScope);
      expect(JSON.stringify(wire)).not.toContain(origin.contextId);
      expect(JSON.stringify(wire)).not.toContain('sent_at_ms');
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('deletes updater delivery receipts immediately at durable opt-out with exact-prefix and product-intent isolation', async () => {
    const file = createFileTestDb('updater-optional-receipt-revocation');
    const previousUserData = electronAppState.userDataPath;
    const productIntentPath = join(file.tmpDir, 'update-install-intent.json');
    const productIntentBytes = Buffer.from(
      '{"fromVersion":"1.0.0","targetVersion":"2.0.0","attemptedAt":1000}\n'
    );
    let analytics: Awaited<ReturnType<typeof initialize>> | undefined;
    try {
      const db = feedbackDatabase(file.db);
      electronAppState.userDataPath = file.tmpDir;
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      realFs.writeFileSync(productIntentPath, productIntentBytes);
      analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const updater = await import('../update-install-telemetry');
      const prefix = '_update_install_telemetry_receipt_v1:';
      const insert = db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)');
      for (const attemptedAt of [1000, 1100]) {
        const measurement = updater.createUpdateInstallMeasurement(db);
        measurement.terminal = {
          outcome: 'failed',
          occurredAtMs: attemptedAt + 500,
          code: 'same_version_relaunch',
        };
        expect(
          analytics.enqueueOptionalAnalyticsEvent(origin, {
            eventId: measurement.operationId,
            eventName: 'app_update_install_attempt',
            payloadSchemaVersion: 1,
            referenceKind: 'updater_operation',
            referenceId: measurement.operationId,
            createdAtMs: attemptedAt,
            properties: {
              $insert_id: measurement.operationId,
              operation_id: measurement.operationId,
              feature_area: 'reliability',
              action_phase: 'start',
              outcome: 'started',
              from_version: '1.0.0',
              version: '2.0.0',
              occurred_at_ms: attemptedAt,
              origin_started_at_ms: attemptedAt,
              origin_boot_id: measurement.originBootId,
            },
          })
        ).toBe(true);
        insert.run(
          prefix + measurement.operationId,
          JSON.stringify({
            fromVersion: '1.0.0',
            targetVersion: '2.0.0',
            attemptedAt,
            measurement,
          }),
          attemptedAt
        );
      }
      const cloudPrefix = '_cloud_backup_telemetry_receipt_v1:';
      insert.run(cloudPrefix + 'owner:upload:private-native-job', '{"version":1}', 1000);
      insert.run(cloudPrefix + 'pending:private-event', '{"version":1}', 1000);
      insert.run(cloudPrefix + 'published:private-version', '{"version":1}', 1000);
      const cloudRows = () =>
        db
          .prepare('SELECT key FROM settings WHERE substr(key,1,?)=?')
          .all(cloudPrefix.length, cloudPrefix);
      expect(cloudRows()).toHaveLength(3);
      const preservedKeys = [
        '_cloud_backup_telemetry_receipt_v10:neighbor',
        'Xcloud_backup_telemetry_receipt_v1:neighbor',
        '_update_install_telemetry_receipt_v1',
        '_update_install_telemetry_receipt_v10:lookalike',
        'Xupdate_install_telemetry_receipt_v1:lookalike',
        '_update_download_episode',
      ];
      for (const key of preservedKeys) insert.run(key, 'product-or-unrelated', 1000);
      const deliveryReceipts = () =>
        db.prepare('SELECT key FROM settings WHERE substr(key,1,?) = ?').all(prefix.length, prefix);
      expect(deliveryReceipts()).toHaveLength(2);
      analytics.persistAnalyticsConsent(false);

      expect(deliveryReceipts()).toEqual([]);
      expect(cloudRows()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      expect(readFileSync(productIntentPath)).toEqual(productIntentBytes);
      for (const key of preservedKeys)
        expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)).toEqual({
          value: 'product-or-unrelated',
        });
      await analytics.grantMainAnalyticsConsent();
      expect(analytics.syncAnalyticsIdentityContext(CONTEXT)).toBe(true);
      updater.reconcileUpdateInstallTelemetryReceipt(db);
      expect(cloudRows()).toEqual([]);
      expect(deliveryReceipts()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      expect(readFileSync(productIntentPath)).toEqual(productIntentBytes);
    } finally {
      try {
        await analytics?.shutdownAnalytics();
      } finally {
        electronAppState.userDataPath = previousUserData;
        file.cleanup();
      }
    }
  });
  it('reconciles an original updater terminal after a same-context startup grant without changing its consent epoch', async () => {
    const fixture = createFileTestDb('updater-terminal-resumed-consent');
    const intentPath = join(fixture.tmpDir, 'update-install-intent.json');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let reopened: Database.Database | undefined;
    let reader: Database.Database | undefined;
    let analytics: Awaited<ReturnType<typeof initialize>> | undefined;
    try {
      feedbackDatabase(fixture.db);
      fixture.db.prepare('UPDATE settings SET updated_at = ?').run(100);
      analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      let updater = await import('../update-install-telemetry');
      const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const downloadId = randomUUID();
      expect(
        updater.recordUpdateDownloadMeasurement(fixture.db, 'app_update_downloaded', {
          operation_id: downloadId,
          occurred_at_ms: 500,
          download_duration_ms: 100,
          version: '2.0.0',
        })
      ).toBe(true);
      const accepted = {
        fromVersion: '1.0.0',
        targetVersion: '2.0.0',
        attemptedAt: 1000,
        measurement: updater.createUpdateInstallMeasurement(
          fixture.db,
          undefined,
          undefined,
          downloadId
        ),
      };
      const readCommitted = () =>
        JSON.parse(realFs.readFileSync(intentPath, 'utf8')) as typeof accepted;
      realFs.writeFileSync(intentPath, JSON.stringify(accepted));
      updater.recordUpdateInstallMeasurement(fixture.db, accepted, true, readCommitted);
      await analytics.drainMainAnalyticsOutbox();
      expect(
        fixture.db
          .prepare('SELECT sent_at_ms FROM analytics_event_outbox WHERE event_id = ?')
          .get(accepted.measurement.operationId)
      ).toEqual({ sent_at_ms: 1000 });
      expect(accepted.measurement.consentEpoch).toBe(100);
      expect(accepted.measurement.downloadOperationId).toBe(downloadId);
      await analytics.shutdownAnalytics();
      analytics = undefined;
      fixture.db.close();
      vi.resetModules();

      reopened = openFileTestDb(fixture.dbPath);
      mockGetDb.mockReturnValue(reopened);
      analytics = await import('../analytics');
      analytics.initAnalyticsMain(undefined, { consent: 'true', version: '3' });
      updater = await import('../update-install-telemetry');
      clock.mockReturnValue(2000);
      const terminalReceipt = {
        ...accepted,
        measurement: {
          ...accepted.measurement,
          terminal: {
            outcome: 'failed' as const,
            occurredAtMs: 2000,
            code: 'same_version_relaunch',
            bootId: updater.UPDATE_BOOT_ID,
          },
        },
      };
      const terminalBytes = JSON.stringify(terminalReceipt);
      realFs.writeFileSync(intentPath, terminalBytes);
      updater.recordUpdateInstallMeasurement(reopened, terminalReceipt, false, readCommitted);
      reader = openReadonlyFileTestDb(fixture.dbPath);
      const terminalId = accepted.measurement.terminalEventId;
      const readTerminal = () =>
        reader!
          .prepare(
            'SELECT event_id, created_at_ms, sent_at_ms, properties_json FROM analytics_event_outbox WHERE event_id = ?'
          )
          .get(terminalId) as
          | {
              event_id: string;
              created_at_ms: number;
              sent_at_ms: number | null;
              properties_json: string;
            }
          | undefined;
      const pendingKey = '_update_install_telemetry_receipt_v1:' + accepted.measurement.operationId;
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      expect(readTerminal()).toBeUndefined();
      const pending = reader.prepare('SELECT value FROM settings WHERE key = ?').get(pendingKey) as
        | { value: string }
        | undefined;
      expect(pending ? JSON.parse(pending.value) : null).toEqual(terminalReceipt);

      clock.mockReturnValue(3000);

      await analytics.grantMainAnalyticsConsent();
      expect(
        reader.prepare('SELECT updated_at FROM settings WHERE key = ?').get('analytics_consent')
      ).toEqual({ updated_at: 100 });
      analytics.registerAnalyticsHandlers(undefined, () =>
        updater.reconcileUpdateInstallTelemetryReceipt(reopened!)
      );
      const resumedContext = { ...CONTEXT, generation: 2, rendererInstanceId: randomUUID() };
      expect(await ipcHandlers.get('analytics:syncContext')!({}, resumedContext)).toMatchObject({
        accepted: true,
      });
      const resumedOrigin = analytics.captureOptionalTelemetryOrigin()!;
      expect(resumedOrigin).toMatchObject({
        consentScope: origin.consentScope,
        contextId: origin.contextId,
      });
      expect(resumedOrigin.processId).not.toBe(origin.processId);
      expect(readTerminal()).toMatchObject({
        event_id: terminalId,
        created_at_ms: 2000,
        sent_at_ms: null,
      });
      const refreshedContext = { ...resumedContext, generation: 3 };
      expect(await ipcHandlers.get('analytics:syncContext')!({}, refreshedContext)).toMatchObject({
        accepted: true,
        optionalOrigin: resumedOrigin,
      });
      expect(await ipcHandlers.get('analytics:syncContext')!({}, resumedContext)).toMatchObject({
        accepted: false,
      });
      await analytics.drainMainAnalyticsOutbox();
      const delivered = readTerminal()!;
      expect(delivered.sent_at_ms).toBe(3000);
      expect(JSON.parse(delivered.properties_json)).toMatchObject({
        operation_id: accepted.measurement.operationId,
        download_operation_id: downloadId,
        origin_boot_id: accepted.measurement.originBootId,
        origin_started_at_ms: 1000,
        occurred_at_ms: 2000,
        update_boot_id: updater.UPDATE_BOOT_ID,
        action_phase: 'error',
        outcome: 'failed',
        error_code: 'same_version_relaunch',
      });
      expect(
        reader.prepare('SELECT value FROM settings WHERE key = ?').get(pendingKey)
      ).toBeUndefined();
      clock.mockReturnValue(4000);
      await analytics.grantMainAnalyticsConsent();
      updater.reconcileUpdateInstallTelemetryReceipt(reopened);
      updater.reconcileUpdateInstallTelemetryReceipt(reopened);
      await analytics.drainMainAnalyticsOutbox();
      expect(readTerminal()).toEqual(delivered);
      expect(realFs.readFileSync(intentPath, 'utf8')).toBe(terminalBytes);
      const terminalCaptures = mockPostHog.capture.mock.calls.filter(
        ([capture]) => capture.uuid === terminalId
      );
      expect(terminalCaptures).toHaveLength(1);
      expect(terminalCaptures[0][0]).toMatchObject({
        distinctId: CONTEXT.distinctId,
        timestamp: new Date(2000),
        properties: { $insert_id: terminalId },
      });
    } finally {
      try {
        await analytics?.shutdownAnalytics();
      } finally {
        reader?.close();
        reopened?.close();
        clock.mockRestore();
        fixture.cleanup();
      }
    }
  });

  it('fences same-millisecond revoke/regrant without resurrecting old optional rows', async () => {
    const db = feedbackDatabase();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(500);
    try {
      const analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const input = optionalInput();
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      await analytics.revokeMainAnalyticsConsent();
      await analytics.grantMainAnalyticsConsent();
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      analytics.syncAnalyticsIdentityContext(CONTEXT);
      const next = analytics.captureOptionalTelemetryOrigin()!;
      expect(next.consentScope).not.toBe(origin.consentScope);
      expect(next.contextId).not.toBe(origin.contextId);
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      expect(analytics.enqueueOptionalAnalyticsEvent(next, optionalInput())).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      await analytics.shutdownAnalytics();
    } finally {
      clock.mockRestore();
      db.close();
    }
  });
  it.each(['distinctId', 'sessionId', 'rendererInstanceId'] as const)(
    'fences A→B→A changes to %s and blocks a retired SDK transport retry',
    async (changedField) => {
      const db = feedbackDatabase();
      try {
        const analytics = await initialize();
        const currentContext = { ...CONTEXT, rendererInstanceId: randomUUID(), generation: 2 };
        expect(analytics.syncAnalyticsIdentityContext(currentContext)).toBe(true);
        const origin = analytics.captureOptionalTelemetryOrigin()!;
        const oldTransport = mockPostHogConstructor.mock.calls.at(-1)![1]!.fetch!;
        expect(
          analytics.syncAnalyticsIdentityContext({
            ...currentContext,
            [changedField]: randomUUID(),
            generation: 3,
          })
        ).toBe(true);
        expect(analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput())).toBe(false);
        expect(analytics.syncAnalyticsIdentityContext({ ...currentContext, generation: 4 })).toBe(
          true
        );
        expect(analytics.captureOptionalTelemetryOrigin()!.contextId).not.toBe(origin.contextId);
        expect(analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput())).toBe(false);
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        await expect(
          oldTransport('http://127.0.0.1:43123/batch/', { method: 'POST', headers: {}, body: '{}' })
        ).rejects.toThrow('authority closed');
        expect(fetch).not.toHaveBeenCalled();
        await analytics.shutdownAnalytics();
      } finally {
        db.close();
      }
    }
  );
  it('keeps late SDK transport blocked after durable consent closes and duplicate sync is rejected', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const transport = mockPostHogConstructor.mock.calls.at(-1)![1]!.fetch!;
      const clientCount = mockPostHogConstructor.mock.calls.length;
      db.prepare("UPDATE settings SET value = 'false' WHERE key = 'analytics_consent'").run();
      expect(analytics.syncAnalyticsIdentityContext(CONTEXT)).toBe(false);
      expect(mockPostHogConstructor).toHaveBeenCalledTimes(clientCount);
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput())).toBe(false);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await expect(
        transport('http://127.0.0.1:43123/batch/', { method: 'POST', headers: {}, body: '{}' })
      ).rejects.toThrow('authority closed');
      expect(fetch).not.toHaveBeenCalled();
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('resumes only an existing exact original-process row after a same-authority restart', async () => {
    const db = feedbackDatabase();
    try {
      let analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const input = optionalInput();
      mockPostHog.flush.mockResolvedValue(undefined);
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      expect(db.prepare('SELECT sent_at_ms FROM analytics_event_outbox').get()).toEqual({
        sent_at_ms: null,
      });
      await analytics.shutdownAnalytics();
      vi.resetModules();
      analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      const nowOrigin = analytics.captureOptionalTelemetryOrigin()!;
      expect(nowOrigin.contextId).toBe(origin.contextId);
      expect(nowOrigin.processId).not.toBe(origin.processId);
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput())).toBe(false);
      mockPostHog.flush.mockImplementation(flushQueued);
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      expect(db.prepare('SELECT sent_at_ms FROM analytics_event_outbox').get()).toEqual({
        sent_at_ms: expect.any(Number),
      });
      const emitted = mockPostHog.capture.mock.calls
        .filter(([value]) => value.uuid === input.eventId)
        .at(-1)![0];
      expect(emitted.distinctId).toBe(CONTEXT.distinctId);
      expect(emitted.timestamp).toEqual(new Date(100));
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('rejects exact duplicate context while preserving the live origin and valid acknowledgment', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      expect(analytics.syncAnalyticsIdentityContext(CONTEXT)).toBe(false);
      expect(analytics.captureOptionalTelemetryOrigin()).toEqual(origin);
      const input = optionalInput();
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, input)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      expect(
        db
          .prepare(
            'SELECT send_attempts, last_attempt_at_ms, sent_at_ms FROM analytics_event_outbox WHERE event_id = ?'
          )
          .get(input.eventId)
      ).toEqual({
        send_attempts: 1,
        last_attempt_at_ms: expect.any(Number),
        sent_at_ms: expect.any(Number),
      });
      const emitted = mockPostHog.capture.mock.calls.filter(
        ([value]) => value.uuid === input.eventId
      );
      expect(emitted).toHaveLength(1);
      expect(emitted[0]![0]).toMatchObject({
        uuid: input.eventId,
        distinctId: CONTEXT.distinctId,
        timestamp: new Date(input.createdAtMs),
      });
      expect(analytics.captureOptionalTelemetryOrigin()).toEqual(origin);
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('repairs a committed receipt missing from the global outbox after reopening the same context', async () => {
    const fixture = createFileTestDb('optional-origin-receipt');
    let reopened: Database.Database | undefined;
    let reader: Database.Database | undefined;
    try {
      feedbackDatabase(fixture.db);
      let analytics = await initialize();
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      const event = optionalInput();
      fixture.db.exec(
        'CREATE TABLE domain_receipt_fixture (event_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)'
      );
      const original: CommittedOptionalAnalyticsReceipt<typeof event.properties> = {
        origin,
        event,
      };
      const encoded = JSON.stringify(original);
      fixture.db.transaction(() =>
        fixture.db
          .prepare('INSERT INTO domain_receipt_fixture VALUES (?,?)')
          .run(event.eventId, encoded)
      )();
      reader = openReadonlyFileTestDb(fixture.dbPath);
      const readCommitted = () => {
        const row = reader!
          .prepare('SELECT receipt_json FROM domain_receipt_fixture WHERE event_id = ?')
          .get(event.eventId) as { receipt_json: string } | undefined;
        return row ? (JSON.parse(row.receipt_json) as typeof original) : null;
      };
      expect(readCommitted()).toEqual(original);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      await analytics.shutdownAnalytics();
      fixture.db.close();
      vi.resetModules();
      reopened = openFileTestDb(fixture.dbPath);
      mockGetDb.mockReturnValue(reopened);
      analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      const current = analytics.captureOptionalTelemetryOrigin()!;
      expect(current.contextId).toBe(origin.contextId);
      expect(current.processId).not.toBe(origin.processId);
      expect(analytics.enqueueOptionalAnalyticsEvent(origin, event)).toBe(false);
      mockPostHog.flush.mockResolvedValue(undefined);
      expect(analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      const pending = reopened
        .prepare('SELECT * FROM analytics_event_outbox WHERE event_id = ?')
        .get(event.eventId) as {
        origin_json: string;
        created_at_ms: number;
        sent_at_ms: number | null;
      };
      expect(pending.sent_at_ms).toBeNull();
      expect(pending.created_at_ms).toBe(100);
      expect(JSON.parse(pending.origin_json).origin).toEqual(origin);
      expect(JSON.parse(pending.origin_json).context).toEqual(CONTEXT);
      mockPostHog.flush.mockImplementation(flushQueued);
      expect(analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted)).toBe(true);
      await analytics.drainMainAnalyticsOutbox();
      expect(
        reopened
          .prepare('SELECT sent_at_ms FROM analytics_event_outbox WHERE event_id = ?')
          .get(event.eventId)
      ).toEqual({ sent_at_ms: expect.any(Number) });
      const sentCalls = mockPostHog.capture.mock.calls.filter(
        ([value]) => value.uuid === event.eventId
      );
      expect(sentCalls.at(-1)![0].timestamp).toEqual(new Date(100));
      expect(sentCalls.at(-1)![0].distinctId).toBe(CONTEXT.distinctId);
      expect(
        reader
          .prepare('SELECT receipt_json FROM domain_receipt_fixture WHERE event_id = ?')
          .get(event.eventId)
      ).toEqual({ receipt_json: encoded });
      await analytics.shutdownAnalytics();
    } finally {
      reader?.close();
      reopened?.close();
      fixture.cleanup();
    }
  });
  it.each([
    'revoked',
    'regranted',
    'changed_context',
    'legacy',
    'missing',
    'changed_receipt',
  ] as const)(
    'refuses committed-receipt repair across %s authority or receipt changes',
    async (reason) => {
      const db = feedbackDatabase();
      try {
        const analytics = await initialize();
        const origin = analytics.captureOptionalTelemetryOrigin()!;
        const event = optionalInput();
        const receipt: CommittedOptionalAnalyticsReceipt<typeof event.properties> = {
          origin,
          event,
        };
        db.exec(
          'CREATE TABLE domain_receipt_fixture (event_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)'
        );
        const store = db.prepare('INSERT OR REPLACE INTO domain_receipt_fixture VALUES (?,?)');
        store.run(event.eventId, JSON.stringify(receipt));
        if (reason === 'revoked' || reason === 'regranted')
          await analytics.revokeMainAnalyticsConsent();
        if (reason === 'regranted') {
          await analytics.grantMainAnalyticsConsent();
          analytics.syncAnalyticsIdentityContext(CONTEXT);
        }
        if (reason === 'changed_context')
          analytics.syncAnalyticsIdentityContext({
            ...CONTEXT,
            distinctId: randomUUID(),
            generation: 2,
          });
        if (reason === 'legacy') {
          const legacy = {
            origin: {
              consentScope: origin.consentScope,
              processId: origin.processId,
              classification: origin.classification,
            },
            event,
          };
          store.run(event.eventId, JSON.stringify(legacy));
        }
        if (reason === 'missing') db.prepare('DELETE FROM domain_receipt_fixture').run();
        let reads = 0;
        const readCommitted = () => {
          reads++;
          if (reason === 'changed_receipt' && reads === 2) {
            store.run(
              event.eventId,
              JSON.stringify({ ...receipt, event: { ...event, createdAtMs: 101 } })
            );
          }
          const row = db
            .prepare('SELECT receipt_json FROM domain_receipt_fixture WHERE event_id = ?')
            .get(event.eventId) as { receipt_json: string } | undefined;
          return row ? (JSON.parse(row.receipt_json) as typeof receipt) : null;
        };
        expect(analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted)).toBe(false);
        expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
          n: 0,
        });
        await analytics.shutdownAnalytics();
      } finally {
        db.close();
      }
    }
  );
  it('purges revoked in-flight rows and refuses late SDK success as SENT', async () => {
    const db = feedbackDatabase();
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      mockPostHog.flush.mockImplementation(async function (this: object) {
        enter();
        await released;
        await flushQueued.call(this);
      });
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput());
      const sending = analytics.drainMainAnalyticsOutbox();
      try {
        await entered;
        await analytics.revokeMainAnalyticsConsent();
      } finally {
        release();
      }
      await sending;
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
    } finally {
      release();
      db.close();
    }
  });
  it('closes the gate and discards SDK work even when durable revocation fails with a raw primary', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      const failure = Object.freeze(new Error('controlled consent storage failure'));
      mockGetDb.mockImplementation(() => {
        throw failure;
      });
      await expect(analytics.revokeMainAnalyticsConsent()).rejects.toBe(failure);
      expect(analytics.captureOptionalTelemetryOrigin()).toBeNull();
      expect(mockPostHog.optOut).toHaveBeenCalled();
      expect(mockPostHog.setPersistedProperty).toHaveBeenCalledWith('queue', []);
    } finally {
      mockGetDb.mockReturnValue(db);
      db.close();
    }
  });
  it('keeps provider/SQL details private while failed SDK delivery remains pending', async () => {
    const db = feedbackDatabase();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      mockPostHog.flush.mockRejectedValue(new Error('private filename / raw provider key decoy'));
      const origin = analytics.captureOptionalTelemetryOrigin()!;
      analytics.enqueueOptionalAnalyticsEvent(origin, optionalInput());
      await analytics.drainMainAnalyticsOutbox();
      expect(db.prepare('SELECT sent_at_ms FROM analytics_event_outbox').get()).toEqual({
        sent_at_ms: null,
      });
      expect(warn).toHaveBeenCalledWith('[analytics] durable outbox drain failed', {
        stage: 'optional_delivery',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('decoy');
      await analytics.shutdownAnalytics();
    } finally {
      warn.mockRestore();
      db.close();
    }
  });
  it('refuses legacy feedback origins and the old transient delivery-account bypass', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      const origin = analytics.captureFeedbackTelemetryOrigin()!;
      const legacy = { ...origin };
      delete legacy.contextId;
      mockPostHog.capture.mockClear();
      analytics.recordFeedbackTelemetry(feedbackReceipt(legacy));
      expect(
        analytics.trackAllowedEvent('feedback_stage', { feedback_stage: 'backend_accepted' })
      ).toBe(false);
      const generic = analytics.captureOptionalTelemetryOrigin()!;
      expect(
        analytics.enqueueOptionalAnalyticsEvent(generic, {
          ...optionalInput(),
          eventName: 'feedback_stage',
        })
      ).toBe(false);
      await analytics.drainMainAnalyticsOutbox();
      expect(
        mockPostHog.capture.mock.calls.filter(([input]) => input.event === 'feedback_stage')
      ).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM analytics_event_outbox').get()).toEqual({
        n: 0,
      });
      await analytics.shutdownAnalytics();
    } finally {
      db.close();
    }
  });
  it('fences prior feedback authority on account change while new operation metrics stay anonymous', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const origin = analytics.captureFeedbackTelemetryOrigin();
      expect(origin).not.toBeNull();
      analytics.syncAnalyticsIdentityContext({
        ...CONTEXT,
        generation: CONTEXT.generation + 1,
        distinctId: '33690000-0000-4000-8000-000000000002',
      });
      mockPostHog.capture.mockClear();
      analytics.recordFeedbackTelemetry(feedbackReceipt(origin!));
      await analytics.drainMainAnalyticsOutbox();
      expect(
        mockPostHog.capture.mock.calls.filter(([input]) => input.event === 'feedback_stage')
      ).toEqual([]);
      const currentOrigin = analytics.captureFeedbackTelemetryOrigin()!;
      analytics.recordFeedbackTelemetry(feedbackReceipt(currentOrigin));
      await analytics.drainMainAnalyticsOutbox();
      const event = mockPostHog.capture.mock.calls.find(
        ([input]) => input.event === 'feedback_stage'
      )?.[0];
      if (!event) throw new Error('Expected the current feedback_stage capture');
      expect(event.distinctId).toBe(currentOrigin.metricId);
      expect(event.distinctId).not.toBe(CONTEXT.distinctId);
      expect(event.properties).toMatchObject({
        identity_kind: 'anonymous',
        feedback_origin: 'current',
        feedback_stage: 'backend_accepted',
      });
      const originStartedAt = event.properties.origin_started_at_ms;
      const occurredAt = event.properties.occurred_at_ms;
      const emittedAt = event.properties.emitted_at_ms;
      if (
        typeof originStartedAt !== 'number' ||
        typeof occurredAt !== 'number' ||
        typeof emittedAt !== 'number'
      ) {
        throw new Error('Expected numeric original, occurrence and emission clocks');
      }
      expect(originStartedAt).toBeLessThanOrEqual(occurredAt);
      expect(occurredAt).toBeLessThanOrEqual(emittedAt);
      expect(event.properties.$insert_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(event)).not.toContain(origin!.consentScope);
    } finally {
      db.close();
    }
  });
  it('revokes old feedback origin nonces durably across opt-out and later opt-in', async () => {
    const db = feedbackDatabase();
    try {
      const analytics = await initialize();
      const old = analytics.captureFeedbackTelemetryOrigin()!;
      await analytics.revokeMainAnalyticsConsent();
      await analytics.grantMainAnalyticsConsent();
      analytics.syncAnalyticsIdentityContext(CONTEXT);
      mockPostHog.capture.mockClear();
      analytics.recordFeedbackTelemetry(feedbackReceipt(old));
      expect(
        mockPostHog.capture.mock.calls.filter(([input]) => input.event === 'feedback_stage')
      ).toEqual([]);
      const current = analytics.captureFeedbackTelemetryOrigin()!;
      expect(current.consentScope).not.toBe(old.consentScope);
      analytics.recordFeedbackTelemetry(feedbackReceipt(current));
      await analytics.drainMainAnalyticsOutbox();
      expect(
        mockPostHog.capture.mock.calls.filter(([input]) => input.event === 'feedback_stage')
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  it('preserves origin timing and operation-only identity across a restarted analytics module', async () => {
    const db = feedbackDatabase();
    try {
      let analytics = await initialize();
      const origin = analytics.captureFeedbackTelemetryOrigin()!;
      const receipt = feedbackReceipt(origin);
      mockPostHog.flush.mockResolvedValue(undefined);
      analytics.recordFeedbackTelemetry(receipt);
      await analytics.drainMainAnalyticsOutbox();
      const first = mockPostHog.capture.mock.calls.find(
        ([input]) => input.event === 'feedback_stage'
      )![0];
      await analytics.shutdownAnalytics();
      vi.resetModules();
      analytics = await initialize();
      await analytics.drainMainAnalyticsOutbox();
      mockPostHog.capture.mockClear();
      mockPostHog.flush.mockImplementation(flushQueued);
      analytics.recordFeedbackTelemetry(receipt);
      await analytics.drainMainAnalyticsOutbox();
      const restored = mockPostHog.capture.mock.calls.find(
        ([input]) => input.event === 'feedback_stage'
      )![0];
      expect(restored.distinctId).toBe(first.distinctId);
      expect(restored.properties).toMatchObject({
        feedback_origin: 'restored',
        origin_started_at_ms: receipt.originalAtMs,
        identity_kind: 'anonymous',
        $insert_id: first.properties.$insert_id,
      });
    } finally {
      db.close();
    }
  });
});

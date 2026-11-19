// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAFE_AUTOCAPTURE_CONFIG, SAFE_POSTHOG_PRIVACY_CONFIG } from '@waypoint/analytics-policy';
import type { PlatformBridge } from '../../platform/types';
import type { RuntimeProfile } from '../../shared/runtime-profile';
import type {
  AnalyticsIdentityContext,
  RendererWorkflowTelemetryRequest,
} from '../../shared/analytics-types';

const IDS = {
  distinct: '550e8400-e29b-41d4-a716-446655440010',
  session: '550e8400-e29b-41d4-a716-446655440020',
  install: '550e8400-e29b-41d4-a716-446655440030',
  canary: '550e8400-e29b-41d4-a716-446655440040',
};
const mockRequestQueueUnload = vi.fn();
const mockRequestQueueEnable = vi.fn();
const mockRetryQueueUnload = vi.fn();
const mockRequestQueue: {
  _queue: unknown[];
  _flushTimeout: ReturnType<typeof setTimeout> | undefined;
  _isPaused: boolean;
  enable: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
} = {
  _queue: [],
  _flushTimeout: undefined,
  _isPaused: false,
  enable: mockRequestQueueEnable,
  unload: mockRequestQueueUnload,
};
const mockRetryQueue: {
  _queue: unknown[];
  _poller: ReturnType<typeof setTimeout> | undefined;
  _isPolling: boolean;
  unload: ReturnType<typeof vi.fn>;
} = {
  _queue: [],
  _poller: undefined,
  _isPolling: false,
  unload: mockRetryQueueUnload,
};
const mockPosthog = {
  config: {
    request_batching: true,
  },
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  getFeatureFlag: vi.fn(() => true),
  reset: vi.fn(),
  group: vi.fn(),
  resetGroups: vi.fn(),
  getGroups: vi.fn((): Record<string, string> => ({})),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  get_distinct_id: vi.fn(() => IDS.distinct),
  get_session_id: vi.fn(() => IDS.session),
  onFeatureFlags: vi.fn(() => () => {}),
  __request_queue: [] as unknown[],
  _requestQueue: mockRequestQueue,
  _retryQueue: mockRetryQueue,
};

vi.mock('posthog-js/lib/src/entrypoints/module.es', () => ({ default: mockPosthog }));

function testRuntimeConfig() {
  return {
    apiKey: 'phc_test123',
    host: 'http://127.0.0.1:48123',
    appVersion: '0.7.9',
    platformFamily: 'macos',
    environment: 'staging',
    releaseChannel: 'closed_beta',
    buildTag: 'v0.7.9-beta.1',
    pseudonymousInstallId: IDS.install,
    isSynthetic: true,
    telemetryCanaryId: IDS.canary,
    telemetryActor: 'canary',
  };
}

function installBridge(overrides: Record<string, unknown> = {}) {
  const analytics = {
    getRuntimeConfig: vi.fn(async () => testRuntimeConfig()),
    syncContext: vi.fn(async () => ({ accepted: true })),
    persistConsent: vi.fn(async () => {}),
    setConsent: vi.fn(async (_enabled: boolean) => {}),
    onBetaAttributionUpdated: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { electronAPI?: unknown }).electronAPI = { analytics };
  return analytics;
}

function diagnosticProfile(): RuntimeProfile {
  return {
    kind: 'scenario-e2e',
    isElectron: true,
    isE2e: true,
    scenarioMutationAllowed: true,
    scenarioMutationReason: 'Owned disposable analytics test profile.',
  };
}

function installDiagnosticBridge(
  profile: RuntimeProfile,
  analytics?: ReturnType<typeof installBridge>
): void {
  const runtime = {
    getProfile: () => profile,
  } satisfies Pick<PlatformBridge['runtime'], 'getProfile'>;
  vi.stubGlobal('electronAPI', { runtime, ...(analytics ? { analytics } : {}) });
}

let analyticsOwnerForTest: typeof import('../analytics') | null = null;
async function loadAnalyticsOwnerForTest() {
  const owner = await import('../analytics');
  if (analyticsOwnerForTest && analyticsOwnerForTest !== owner) {
    throw new Error('Close the original analytics owner before resetting modules');
  }
  analyticsOwnerForTest = owner;
  return owner;
}

async function closeAnalyticsOwnerForTest(): Promise<void> {
  const owner = analyticsOwnerForTest;
  if (!owner) return;
  await owner.optOutAnalytics();
  owner.disposeAnalyticsPreidentityDiagnosticsForTest();
  analyticsOwnerForTest = null;
}

async function initializeAndEnable() {
  const analytics = await loadAnalyticsOwnerForTest();
  const { useAuthStore } = await import('../../stores/auth-store');
  useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
  expect(await analytics.initAnalyticsRenderer()).toBe(true);
  await analytics.optInAnalytics();
  await vi.waitFor(() =>
    expect(
      (
        window as unknown as {
          electronAPI?: { analytics?: { syncContext?: ReturnType<typeof vi.fn> } };
        }
      ).electronAPI?.analytics?.syncContext
    ).toHaveBeenCalled()
  );
  return analytics;
}

describe('renderer analytics', () => {
  beforeEach(() => {
    expect(analyticsOwnerForTest).toBeNull();
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv('VITE_POSTHOG_API_KEY', '');
    mockPosthog.get_distinct_id.mockReturnValue(IDS.distinct);
    mockPosthog.get_session_id.mockReturnValue(IDS.session);
    mockPosthog.__request_queue = [];
    mockPosthog.config.request_batching = true;
    mockRequestQueue._queue = [];
    mockRequestQueue._flushTimeout = undefined;
    mockRequestQueue._isPaused = false;
    mockRequestQueue.enable = mockRequestQueueEnable;
    mockRequestQueue.unload = mockRequestQueueUnload;
    mockRetryQueue._queue = [];
    mockRetryQueue._poller = undefined;
    mockRetryQueue._isPolling = false;
    mockRetryQueue.unload = mockRetryQueueUnload;
    localStorage.clear();
    (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
  });

  afterEach(async () => {
    await closeAnalyticsOwnerForTest();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it.each([
    'workspace_sync_stage',
    'workspace_recovery_stage',
    'workspace_backup_enabled',
  ] as const)('refuses native receipt stages through renderer ingress: %s', async (event) => {
    installBridge();
    const analytics = await initializeAndEnable();
    mockPosthog.capture.mockClear();
    const properties = {
      feature_area: 'workspace',
      operation_id: '99999999-9999-4999-8999-999999999999',
      origin_started_at_ms: 100,
      occurred_at_ms: event === 'workspace_backup_enabled' ? 100 : 200,
      ...(event === 'workspace_sync_stage'
        ? { sync_operation: 'upload', sync_stage: 'uploaded' }
        : event === 'workspace_recovery_stage'
          ? { recovery_stage: 'retained' }
          : {}),
    };
    expect(analytics.trackAllowedEvent(event, properties)).toBe(false);
    expect(analytics.trackRendererEvent(event, properties)).toBe(false);
    expect(mockPosthog.capture.mock.calls.filter(([name]) => name === event)).toHaveLength(0);
  });

  it('groups the signed-in account by its single organization', async () => {
    const organization = '018f3fd0-0000-7000-8000-000000000031';
    const listOrganizations = vi.fn(async () => ({
      ok: true as const,
      organizations: [
        {
          orgId: organization,
          slug: 'example-lab',
          displayName: 'Example Lab',
          role: 'member',
          canCreateManagedProjects: false,
          isAdministrator: false,
        },
      ],
    }));
    vi.stubGlobal('electronAPI', { cloudSync: { listOrganizations } });
    const analytics = await loadAnalyticsOwnerForTest();

    await analytics.groupAnalyticsByOrganization(IDS.distinct);
    expect(mockPosthog.group).toHaveBeenCalledWith('organization', organization);

    listOrganizations.mockResolvedValueOnce({
      ok: true as const,
      organizations: [
        { ...(await listOrganizations.mock.results[0]!.value).organizations[0]! },
        {
          orgId: '018f3fd0-0000-7000-8000-000000000032',
          slug: 'other-lab',
          displayName: 'Other Lab',
          role: 'member',
          canCreateManagedProjects: false,
          isAdministrator: false,
        },
      ],
    });
    mockPosthog.getGroups.mockReturnValueOnce({ organization });
    await analytics.groupAnalyticsByOrganization(IDS.distinct);
    expect(mockPosthog.resetGroups).toHaveBeenCalledTimes(1);

    mockPosthog.group.mockClear();
    await analytics.groupAnalyticsByOrganization('018f3fd0-0000-7000-8000-000000000099');
    expect(mockPosthog.group).not.toHaveBeenCalled();
  });

  it('exposes preidentity diagnostics only in a test build and main-approved disposable Electron profile', async () => {
    const analytics = await loadAnalyticsOwnerForTest();
    const profile = diagnosticProfile();
    installDiagnosticBridge(profile);
    vi.stubEnv('MODE', 'production');
    expect(analytics.getAnalyticsPreidentityDiagnosticsForTest()).toBeNull();
    vi.stubEnv('MODE', 'development');
    expect(analytics.getAnalyticsPreidentityDiagnosticsForTest()).toBeNull();
    vi.stubEnv('MODE', 'test');
    const deniedProfiles: RuntimeProfile[] = [
      { ...profile, kind: 'primary' },
      { ...profile, isElectron: false },
      { ...profile, isE2e: false },
      { ...profile, scenarioMutationAllowed: false },
    ];
    for (const denied of deniedProfiles) {
      installDiagnosticBridge(denied);
      expect(analytics.getAnalyticsPreidentityDiagnosticsForTest()).toBeNull();
    }
    installDiagnosticBridge(profile);
    expect(analytics.getAnalyticsPreidentityDiagnosticsForTest()).not.toBeNull();
    analytics.disposeAnalyticsPreidentityDiagnosticsForTest();
  });

  it('holds only renderer acknowledgment and forwards the exact real native result once', async () => {
    const { createPreidentityDiagnostics } = await import('../analytics-preidentity-diagnostics');
    const owner = createPreidentityDiagnostics(
      () => true,
      () => {
        throw new Error('not probed');
      }
    );
    owner.armNext();
    owner.transitionStarted(7);
    const result = {
      accepted: true,
      authority: {
        actorKind: 'test' as const,
        executionMode: 'synthetic' as const,
        impersonated: false,
      },
    };
    let settled = false;
    const forwarded = owner.publicationGate()!(result).then((value) => {
      settled = true;
      return value;
    });
    expect(await owner.waitForNativeResult()).toBe(result);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await owner.release()).toBe(result);
    expect(await forwarded).toBe(result);
    await expect(owner.release()).rejects.toThrow('cancelled');
    expect(() => owner.armNext()).toThrow('cancelled');
    owner.dispose();
  });

  it('expires an armed hold and rejects stale generations without fabricating native acceptance', async () => {
    vi.useFakeTimers();
    try {
      const { createPreidentityDiagnostics } = await import('../analytics-preidentity-diagnostics');
      const owner = createPreidentityDiagnostics(
        () => true,
        () => {
          throw new Error('not probed');
        }
      );
      owner.armNext();
      owner.transitionStarted(1);
      const gate = owner.publicationGate()!;
      owner.transitionStarted(2);
      await expect(
        gate({
          accepted: false,
          authority: { actorKind: 'unknown', executionMode: 'interactive', impersonated: false },
        })
      ).rejects.toThrow('cancelled');
      owner.dispose();
      const expiring = createPreidentityDiagnostics(
        () => true,
        () => {
          throw new Error('not probed');
        }
      );
      expiring.armNext();
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(expiring.waitForNativeResult()).rejects.toThrow('cancelled');
      await expect(expiring.release()).rejects.toThrow('cancelled');
      expiring.dispose();
      const acknowledged = createPreidentityDiagnostics(
        () => true,
        () => {
          throw new Error('not probed');
        }
      );
      acknowledged.armNext();
      acknowledged.transitionStarted(1);
      const real = {
        accepted: false,
        authority: {
          actorKind: 'unknown' as const,
          executionMode: 'interactive' as const,
          impersonated: false,
        },
      };
      const forwarding = acknowledged.publicationGate()!(real);
      expect(await acknowledged.waitForNativeResult()).toBe(real);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(await forwarding).toBe(real);
      acknowledged.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects cached diagnostic access after gate loss or disposal', async () => {
    const { createPreidentityDiagnostics } = await import('../analytics-preidentity-diagnostics');
    let enabled = true;
    const owner = createPreidentityDiagnostics(
      () => enabled,
      () => {
        throw new Error('not probed');
      }
    );
    owner.armNext();
    enabled = false;
    expect(() => owner.read()).toThrow('cancelled');
    expect(owner.publicationGate()).toBeNull();
    owner.dispose();
    enabled = true;
    expect(() => owner.armNext()).toThrow('cancelled');
    expect(() => owner.waitForNativeResult()).toThrow('cancelled');
  });

  for (const revoke of [false, true]) {
    it(`observes only retained public controls and original clocks; consent purge=${revoke}`, async () => {
      vi.stubEnv('MODE', 'test');
      const bridge = installBridge();
      installDiagnosticBridge(diagnosticProfile(), bridge);
      const analytics = await initializeAndEnable();
      const { useAuthStore } = await import('../../stores/auth-store');
      const { PREIDENTITY_PUBLIC_CONTROL, PREIDENTITY_SYNTHETIC_SENTINEL } =
        await import('../analytics-preidentity-diagnostics');
      const diagnostic = analytics.getAnalyticsPreidentityDiagnosticsForTest()!;
      diagnostic.armNext();
      useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
      const native = await diagnostic.waitForNativeResult();
      expect(native.accepted).toBe(true);
      expect(diagnostic.read().ready).toBe(false);
      mockPosthog.capture.mockClear();
      const publicButton = document.createElement('button');
      publicButton.dataset.testid = PREIDENTITY_PUBLIC_CONTROL;
      const privateWrapper = document.createElement('div');
      privateWrapper.setAttribute('data-ph-no-capture', '');
      const privateButton = document.createElement('button');
      privateButton.textContent = PREIDENTITY_SYNTHETIC_SENTINEL;
      privateWrapper.append(privateButton);
      document.body.append(publicButton, privateWrapper);
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_784_985_600_250);
      try {
        publicButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const publicProbe = diagnostic.read();
        expect(publicProbe.pendingCount).toBe(1);
        expect(publicProbe.publicControlCount).toBe(1);
        privateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(diagnostic.read()).toEqual(publicProbe);
        expect(publicProbe.occurrenceClockRange).toEqual({
          first: 1_784_985_600_250,
          last: 1_784_985_600_250,
        });
        expect(publicProbe.syntheticSentinelPresent).toBe(false);
        expect(Object.keys(publicProbe).sort()).toEqual(
          [
            'ready',
            'consentClass',
            'generation',
            'pendingCount',
            'pendingHead',
            'publicControlCount',
            'occurrenceClockRange',
            'syntheticSentinelPresent',
          ].sort()
        );
        expect(JSON.stringify(publicProbe)).not.toContain(IDS.distinct);
        expect(mockPosthog.capture).not.toHaveBeenCalled();
        if (revoke) {
          await analytics.optOutAnalytics();
          expect(diagnostic.read().pendingCount).toBe(0);
          await expect(diagnostic.release()).rejects.toThrow('cancelled');
          expect(mockPosthog.capture).not.toHaveBeenCalled();
        } else {
          expect(await diagnostic.release()).toBe(native);
          await vi.waitFor(() =>
            expect(mockPosthog.capture).toHaveBeenCalledWith(
              'interaction_observed',
              expect.objectContaining({ target_test_id: PREIDENTITY_PUBLIC_CONTROL }),
              { timestamp: new Date(1_784_985_600_250) }
            )
          );
        }
      } finally {
        await closeAnalyticsOwnerForTest();
        now.mockRestore();
        publicButton.remove();
        privateWrapper.remove();
        diagnostic.dispose();
      }
    });
  }

  it('removes the previous owner listener before a fresh held owner queues its public control', async () => {
    vi.stubEnv('MODE', 'test');
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const publicButton = document.createElement('button');
    publicButton.dataset.testid = 'f17-preidentity-public-control';
    document.body.append(publicButton);
    try {
      installBridge();
      await initializeAndEnable();
      const originalClickListener = added.mock.calls
        .filter(([type]) => type === 'click')
        .at(-1)?.[1];
      expect(originalClickListener).toBeTypeOf('function');
      publicButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(mockPosthog.capture).toHaveBeenCalledTimes(1);

      await closeAnalyticsOwnerForTest();
      expect(removed).toHaveBeenCalledWith('click', originalClickListener, { capture: true });
      publicButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
      vi.resetModules();
      const bridge = installBridge();
      installDiagnosticBridge(diagnosticProfile(), bridge);
      const current = await initializeAndEnable();
      const { useAuthStore } = await import('../../stores/auth-store');
      const diagnostic = current.getAnalyticsPreidentityDiagnosticsForTest()!;
      diagnostic.armNext();
      useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
      expect((await diagnostic.waitForNativeResult()).accepted).toBe(true);
      const beforeOccurrence = Date.now();
      publicButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const afterOccurrence = Date.now();
      const probe = diagnostic.read();
      expect(probe.ready).toBe(false);
      expect(probe.pendingCount).toBe(1);
      expect(probe.publicControlCount).toBe(1);
      expect(probe.occurrenceClockRange?.first).toBeGreaterThanOrEqual(beforeOccurrence);
      expect(probe.occurrenceClockRange?.last).toBeLessThanOrEqual(afterOccurrence);
      expect(probe.occurrenceClockRange?.first).toBe(probe.occurrenceClockRange?.last);
      expect(probe.syntheticSentinelPresent).toBe(false);
      expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
    } finally {
      await closeAnalyticsOwnerForTest();
      publicButton.remove();
      added.mockRestore();
      removed.mockRestore();
    }
  });

  it('history producer survives the real common sanitizer and consent gate without private content', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const { beginHistoryObservation } = await import('../chat-history-telemetry');
    mockPosthog.capture.mockClear();
    const operation = beginHistoryObservation(
      'resume',
      'history_surface',
      '33760000-0000-4000-8000-000000000003'
    );
    operation.store({
      result: 'persisted_available',
      authority: 'keyed_state',
      availability: 'persisted',
    });
    operation.pane({
      result: 'pane_presented',
      authority: 'pane_commit',
      paneRole: 'current_pane',
    });
    const rows = mockPosthog.capture.mock.calls.filter(
      ([event]) => event === 'chat_history_observed'
    );
    expect(rows).toHaveLength(3);
    expect(rows.map(([, properties]) => properties.history_stage)).toEqual([
      'operation',
      'store',
      'pane',
    ]);
    expect(new Set(rows.map(([, properties]) => properties.operation_id)).size).toBe(1);
    for (const [, properties] of rows) {
      expect(properties).toMatchObject({
        history_action: 'resume',
        history_shadow_cleanup: 'NOT_ATTESTED',
      });
      for (const key of ['query', 'title', 'conversation_id', 'workspace_path', 'error'])
        expect(properties).not.toHaveProperty(key);
    }
    await analytics.optOutAnalytics();
    mockPosthog.capture.mockClear();
    beginHistoryObservation('new', 'store').store({
      result: 'new_created',
      authority: 'sqlite_return',
    });
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('optional history observation contains SDK capture exceptions', async () => {
    installBridge();
    await initializeAndEnable();
    const { beginHistoryObservation } = await import('../chat-history-telemetry');
    mockPosthog.capture.mockImplementationOnce(() => {
      throw new Error('synthetic sink refusal');
    });
    expect(() =>
      beginHistoryObservation('list', 'store').store({
        result: 'loaded_empty',
        authority: 'loaded_titles',
      })
    ).not.toThrow();
  });

  it('publishes Jobs stages through the actual common consent and sanitizer boundary', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const { beginJobManagement } = await import('../jobs-management-telemetry');
    mockPosthog.capture.mockClear();
    const action = beginJobManagement('stop', {
      owner: 'managed-operation',
      freshness: 'current',
      mode: 'managed',
      state: 'running',
      availability: 'none',
      observedAtMs: 101,
    });
    action.confirm(true);
    action.settle({ phase: 'accepted', result: 'stop_accepted', authority: 'owner_ack' });
    action.record({
      phase: 'observed',
      result: 'terminal_cancelled',
      authority: 'owner_record',
      freshness: 'current',
      state: 'cancelled',
      observedAtMs: 202,
    });
    action.record({ phase: 'observed', result: 'terminal_succeeded', authority: 'owner_record' });
    const rows = mockPosthog.capture.mock.calls.filter(
      ([event]) => event === 'job_management_observed'
    );
    expect(rows).toHaveLength(4);
    expect(rows.map(([, properties]) => properties.jobs_stage)).toEqual([
      'intent',
      'confirmation',
      'request',
      'record',
    ]);
    expect(new Set(rows.map(([, properties]) => properties.operation_id)).size).toBe(1);
    expect(rows[2]?.[1]).toMatchObject({
      jobs_phase: 'accepted',
      jobs_result: 'stop_accepted',
      jobs_context_basis: 'intent_snapshot',
      jobs_observed_at_ms: 101,
    });
    expect(rows[3]?.[1]).toMatchObject({
      jobs_phase: 'observed',
      jobs_result: 'terminal_cancelled',
      jobs_context_basis: 'record_observation',
      jobs_observed_at_ms: 202,
    });
    for (const [, properties] of rows) {
      expect(properties).toMatchObject({
        jobs_operation_relation: 'action_only_native_not_exported',
      });
      for (const key of [
        'job_id',
        'native_id',
        'provider_id',
        'subject_id',
        'path',
        'title',
        'error',
        'digest',
      ])
        expect(properties).not.toHaveProperty(key);
    }
    expect(
      mockPosthog.capture.mock.calls.filter(([event]) => event === 'telemetry_payload_rejected')
    ).toEqual([]);

    const privateId = '33770000-0000-4000-8000-000000000007';
    const sample = rows[0]![1];
    analytics.trackRendererEvent('job_management_observed', {
      ...sample,
      job_id: privateId,
      native_id: privateId,
    });
    const exported = mockPosthog.capture.mock.calls
      .filter(([event]) => event === 'job_management_observed')
      .at(-1)![1];
    expect(exported).not.toHaveProperty('job_id');
    expect(exported).not.toHaveProperty('native_id');
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain(privateId);
    await analytics.optOutAnalytics();
    mockPosthog.capture.mockClear();
    const disabled = beginJobManagement('import');
    disabled.settle({ phase: 'result', result: 'import_not_applied', authority: 'adapter_return' });
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('contains real SDK capture exceptions for optional Jobs observations', async () => {
    installBridge();
    await initializeAndEnable();
    const { beginJobManagement } = await import('../jobs-management-telemetry');
    mockPosthog.capture.mockImplementationOnce(() => {
      throw new Error('PRIVATE SDK refusal');
    });
    expect(() =>
      beginJobManagement('release').settle({
        phase: 'result',
        result: 'release_returned',
        authority: 'owner_ack',
      })
    ).not.toThrow();
  });

  it('Skills use the actual common renderer publisher and keep useful task reuse unattested', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const { beginSkillObservation } = await import('../skill-operation-telemetry');
    mockPosthog.capture.mockClear();
    const operation = beginSkillObservation('install', {
      host: 'codex-sdk',
      scope: 'workspace',
      source: 'catalog',
    });
    operation.settle('owner_return', 'accepted', { authority: 'owner_return' });
    operation.readback('inventory_matched', {
      installed: 'installed',
      authority: 'native_inventory',
      freshness: 'current_readback',
    });
    operation.readback('inventory_unavailable');
    const rows = mockPosthog.capture.mock.calls.filter(
      ([event]) => event === 'skill_operation_observed'
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(([, properties]) => properties.operation_id)).size).toBe(1);
    expect(rows.map(([, properties]) => properties.skills_stage)).toEqual([
      'intent',
      'owner_return',
      'readback',
    ]);
    for (const [, properties] of rows)
      expect(properties).toMatchObject({
        skills_task_reuse: 'not_attested',
        skills_operation_relation: 'observation_only_native_not_exported',
      });
    expect(
      mockPosthog.capture.mock.calls.filter(([event]) => event === 'telemetry_payload_rejected')
    ).toEqual([]);
    const privateId = '59900000-0000-4000-8000-000000000009';
    analytics.trackRendererEvent('skill_operation_observed', {
      ...rows[0]![1],
      skill_id: privateId,
      native_id: privateId,
      instructions: 'PRIVATE_SKILL_BODY',
    });
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain(privateId);
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain('PRIVATE_SKILL_BODY');
    await analytics.optOutAnalytics();
    mockPosthog.capture.mockClear();
    beginSkillObservation('instruction_load').settle('instruction', 'instruction_returned', {
      instruction: 'full',
    });
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('does not project an old Skills outcome after real common consent opt-out and opt-in', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const { beginSkillObservation } = await import('../skill-operation-telemetry');
    const original = beginSkillObservation('install', { source: 'catalog' });
    await analytics.optOutAnalytics();
    await analytics.optInAnalytics();
    mockPosthog.capture.mockClear();
    original.settle('owner_return', 'accepted');
    original.readback('inventory_matched', { installed: 'installed' });
    expect(
      mockPosthog.capture.mock.calls.filter(([event]) => event === 'skill_operation_observed')
    ).toEqual([]);
  });

  it('keeps History and Jobs outcomes out of a new real common consent episode', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const { beginHistoryObservation } = await import('../chat-history-telemetry');
    const { beginJobManagement } = await import('../jobs-management-telemetry');
    const history = beginHistoryObservation('delete', 'history_surface');
    const jobs = beginJobManagement('history');
    await analytics.optOutAnalytics();
    await analytics.optInAnalytics();
    mockPosthog.capture.mockClear();
    history.store({ result: 'delete_returned', authority: 'sqlite_return' });
    history.pane({ result: 'placeholder_presented' });
    jobs.settle({ phase: 'result', result: 'history_returned', authority: 'owner_history_return' });
    expect(
      mockPosthog.capture.mock.calls.filter(([event]) =>
        ['chat_history_observed', 'job_management_observed'].includes(event)
      )
    ).toEqual([]);
  });

  it('contains optional Skills SDK failure after actual common initialization', async () => {
    installBridge();
    await initializeAndEnable();
    const { beginSkillObservation } = await import('../skill-operation-telemetry');
    mockPosthog.capture.mockImplementationOnce(() => {
      throw new Error('PRIVATE optional SDK');
    });
    expect(() => beginSkillObservation('review').settle('owner_return', 'reviewed')).not.toThrow();
  });

  it.each([
    ['resolve', false],
    ['reject', false],
    ['resolve', true],
    ['reject', true],
  ] as const)(
    'keeps startup appearance read %s bound to original consent (same episode resume: %s)',
    async (completion, resumeExistingEpisode) => {
      installBridge();
      const analytics = await initializeAndEnable();
      let resolve!: (value: string | null) => void;
      let reject!: (reason: Error) => void;
      const read = new Promise<string | null>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const apply = vi.fn(async (factor: number) => ({ status: 'applied' as const, factor }));
      const write = vi.fn(async (_key: string, _value: string) => {});
      vi.doMock('../../db', () => ({ getSetting: () => read, setSetting: write }));
      vi.doMock('../../platform', () => ({
        platform: () => ({ window: { setZoomLevel: apply } }),
      }));
      vi.doMock('../../utils/environment', () => ({ isDesktopRuntime: () => true }));
      try {
        const owner = await import('../applyZoomLevel');
        const startup = owner.applyZoomLevel();
        expect(
          mockPosthog.capture.mock.calls.some(
            ([event, properties]) =>
              event === 'workflow_action_observed' &&
              properties.workflow === 'appearance_display' &&
              properties.action_phase === 'start'
          )
        ).toBe(true);
        await analytics.setAnalyticsConsent(false);
        await analytics.setAnalyticsConsent(true, { resumeExistingEpisode });
        mockPosthog.capture.mockClear();
        if (completion === 'resolve') resolve('1.25');
        else reject(new Error('private appearance read sentinel'));
        await startup;
        expect(
          mockPosthog.capture.mock.calls.filter(
            ([event, properties]) =>
              event === 'workflow_action_observed' && properties.workflow === 'appearance_display'
          )
        ).toHaveLength(0);
        expect(owner.useDisplayZoomStore.getState().phase).toBe(
          completion === 'resolve' ? 'saved' : 'read_failed'
        );
        if (completion === 'resolve') expect(apply).toHaveBeenCalledWith(1.25);
        else expect(apply).not.toHaveBeenCalled();
        await owner.setDisplayZoom(1.5);
        expect(
          mockPosthog.capture.mock.calls.some(
            ([event, properties]) =>
              event === 'workflow_action_observed' &&
              properties.workflow === 'appearance_display' &&
              properties.outcome_kind === 'preference_persisted'
          )
        ).toBe(true);
      } finally {
        resolve(null);
        vi.doUnmock('../../db');
        vi.doUnmock('../../platform');
        vi.doUnmock('../../utils/environment');
      }
    }
  );

  it('does not revive a refused appearance start when consent returns before its stages', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    await analytics.setAnalyticsConsent(false);
    const { beginAppearanceObservation } = await import('../appearance-observation');
    const operation = beginAppearanceObservation('appearance_theme');
    await analytics.setAnalyticsConsent(true);
    mockPosthog.capture.mockClear();
    operation.stage('preference_applied');
    operation.end('preference_persisted');
    expect(
      mockPosthog.capture.mock.calls.filter(
        ([event, properties]) =>
          event === 'workflow_action_observed' && properties.workflow === 'appearance_theme'
      )
    ).toHaveLength(0);
    const fresh = beginAppearanceObservation('appearance_theme');
    fresh.stage('preference_applied');
    fresh.end('preference_persisted');
    expect(
      mockPosthog.capture.mock.calls.some(
        ([event, properties]) =>
          event === 'workflow_action_observed' &&
          properties.workflow === 'appearance_theme' &&
          properties.outcome_kind === 'preference_persisted'
      )
    ).toBe(true);
  }, 120_000);

  it('does not late-qualify an image whose start was refused before actual consent recovery', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const image = await import('../../features/document-opening/image-view-lifecycle');
    const { useCanvasStore } = await import('../../features/canvas/store');
    const { presentDocument } = await import('../../features/canvas/present-document');
    image.resetImageViewLifecycleForTests();
    useCanvasStore.getState().reset();
    try {
      await analytics.setAnalyticsConsent(false);
      mockPosthog.capture.mockClear();
      const path = '/synthetic/consent-image.png';
      const request = image.beginImageOpenRequest({ filePath: path });
      const result = presentDocument({ type: 'image', entityId: path, label: 'Synthetic' });
      if (result.status !== 'presented') throw new Error('Synthetic image presentation failed');
      image.admitImageOpen(request, result);
      const owner = image.beginImageRead({ tabId: result.tabId, filePath: path });
      owner.readStarted();
      owner.bytesReady();
      await analytics.setAnalyticsConsent(true);
      mockPosthog.capture.mockClear();
      owner.decoded();
      expect(
        mockPosthog.capture.mock.calls.filter(
          ([event, properties]) =>
            event === 'workflow_action_observed' &&
            (properties.workflow === 'image' || properties.workflow === 'content')
        )
      ).toHaveLength(0);
      const later = image.beginImageOpenRequest({ filePath: path });
      image.admitImageOpen(later, { ...result, disposition: 'reused' });
      expect(
        mockPosthog.capture.mock.calls.filter(
          ([event, properties]) =>
            event === 'workflow_action_observed' &&
            properties.workflow === 'image' &&
            properties.outcome_kind === 'image_reuse_ready'
        )
      ).toHaveLength(1);
      owner.dispose();
    } finally {
      image.resetImageViewLifecycleForTests();
      useCanvasStore.getState().reset();
    }
  }, 120_000);

  it('keeps an in-flight image terminal suppressed through actual opt-out and later opt-in', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const image = await import('../../features/document-opening/image-view-lifecycle');
    const { useCanvasStore } = await import('../../features/canvas/store');
    const { presentDocument } = await import('../../features/canvas/present-document');
    image.resetImageViewLifecycleForTests();
    useCanvasStore.getState().reset();
    try {
      const path = '/synthetic/revoked-image.png';
      const request = image.beginImageOpenRequest({ filePath: path });
      const result = presentDocument({ type: 'image', entityId: path, label: 'Synthetic' });
      if (result.status !== 'presented') throw new Error('Synthetic image presentation failed');
      image.admitImageOpen(request, result);
      const owner = image.beginImageRead({ tabId: result.tabId, filePath: path });
      owner.readStarted();
      owner.bytesReady();
      await analytics.setAnalyticsConsent(false);
      mockPosthog.capture.mockClear();
      owner.decoded();
      await analytics.setAnalyticsConsent(true);
      expect(
        mockPosthog.capture.mock.calls.filter(
          ([event, properties]) =>
            event === 'workflow_action_observed' &&
            properties.action_id === request?.id &&
            properties.action_phase === 'result'
        )
      ).toHaveLength(0);
      owner.dispose();
    } finally {
      image.resetImageViewLifecycleForTests();
      useCanvasStore.getState().reset();
    }
  });

  it.each([false, true])(
    'never revives old image stages or readiness after consent returns (resume episode: %s)',
    async (resumeExistingEpisode) => {
      installBridge();
      const analytics = await initializeAndEnable();
      const image = await import('../../features/document-opening/image-view-lifecycle');
      const { useCanvasStore } = await import('../../features/canvas/store');
      const { presentDocument } = await import('../../features/canvas/present-document');
      image.resetImageViewLifecycleForTests();
      useCanvasStore.getState().reset();
      try {
        const path = '/synthetic/old-consent-origin.png';
        const request = image.beginImageOpenRequest({ filePath: path });
        const result = presentDocument({ type: 'image', entityId: path, label: 'Synthetic' });
        if (result.status !== 'presented') throw new Error('Synthetic image presentation failed');
        image.admitImageOpen(request, result);
        const owner = image.beginImageRead({ tabId: result.tabId, filePath: path });
        owner.readStarted();
        expect(
          mockPosthog.capture.mock.calls.some(
            ([event, properties]) =>
              event === 'workflow_action_observed' &&
              properties.action_id === request?.id &&
              properties.action_phase === 'start'
          )
        ).toBe(true);
        await analytics.setAnalyticsConsent(false);
        await analytics.setAnalyticsConsent(true, { resumeExistingEpisode });
        mockPosthog.capture.mockClear();
        owner.bytesReady();
        owner.decoded();
        expect(
          mockPosthog.capture.mock.calls.filter(
            ([event, properties]) =>
              event === 'workflow_action_observed' &&
              (properties.workflow === 'image' || properties.workflow === 'content')
          )
        ).toHaveLength(0);
        expect(
          mockPosthog.capture.mock.calls.filter(
            ([event]) => event === 'meaningful_activity_completed'
          )
        ).toHaveLength(0);
        const later = image.beginImageOpenRequest({ filePath: path });
        image.admitImageOpen(later, { ...result, disposition: 'reused' });
        expect(
          mockPosthog.capture.mock.calls.filter(
            ([event, properties]) =>
              event === 'workflow_action_observed' &&
              properties.action_id === later?.id &&
              properties.outcome_kind === 'image_reuse_ready'
          )
        ).toHaveLength(1);
        owner.dispose();
      } finally {
        image.resetImageViewLifecycleForTests();
        useCanvasStore.getState().reset();
      }
    }
  );

  it('durably admits scientific completions through the native authority without an SDK duplicate', async () => {
    const origin = {
      consentScope: '69800000-0000-4000-8000-000000000030',
      contextId: '69800000-0000-4000-8000-000000000031',
      processId: '69800000-0000-4000-8000-000000000032',
      classification: 'synthetic' as const,
    };
    const enqueueWorkflowEvent = vi.fn(async (_request: RendererWorkflowTelemetryRequest) => true);
    const syncContext = vi.fn(async (_context: AnalyticsIdentityContext) => ({
      accepted: true,
      optionalOrigin: origin,
    }));
    installBridge({ syncContext, enqueueWorkflowEvent });
    const analytics = await initializeAndEnable();
    mockPosthog.capture.mockClear();
    const properties = {
      feature_area: 'scientific_workflow',
      workflow: 'annotation',
      workflow_action: 'create',
      workflow_status: 'created',
      action_phase: 'result',
      success: true,
      action_id: '69800000-0000-4000-8000-000000000033',
      $insert_id: '69800000-0000-4000-8000-000000000034',
    };
    const before = Date.now();
    expect(analytics.trackRendererEvent('workflow_action_observed', properties)).toBe(true);
    properties.workflow_status = 'failed';
    expect(enqueueWorkflowEvent).toHaveBeenCalledTimes(1);
    const request = enqueueWorkflowEvent.mock.calls[0]![0];
    expect(request).toMatchObject({
      origin,
      context: syncContext.mock.calls.at(-1)![0],
      eventName: 'workflow_action_observed',
      eventId: properties.$insert_id,
      properties: { ...properties, workflow_status: 'created' },
    });
    expect(request.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(request.capturedAtMs).toBeLessThanOrEqual(Date.now());
    expect(request.properties).not.toHaveProperty('screen_category');
    expect(request.properties).toHaveProperty('event_version', 5);
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('refuses native scientific delivery without the current identity authority', async () => {
    const enqueueWorkflowEvent = vi.fn(async () => true);
    installBridge({ enqueueWorkflowEvent });
    const analytics = await initializeAndEnable();
    mockPosthog.capture.mockClear();
    expect(
      analytics.trackRendererEvent('workflow_action_observed', {
        feature_area: 'scientific_workflow',
        workflow: 'annotation',
        workflow_action: 'create',
        workflow_status: 'created',
        action_phase: 'result',
        success: true,
      })
    ).toBe(false);
    expect(enqueueWorkflowEvent).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('resynchronizes an expired SDK session before durably admitting its scientific action', async () => {
    const origin = {
      consentScope: '69800000-0000-4000-8000-000000000070',
      contextId: '69800000-0000-4000-8000-000000000071',
      processId: '69800000-0000-4000-8000-000000000072',
      classification: 'synthetic' as const,
    };
    const enqueueWorkflowEvent = vi.fn(async (_request: RendererWorkflowTelemetryRequest) => true);
    const syncContext = vi.fn(async (_context: AnalyticsIdentityContext) => ({
      accepted: true,
      optionalOrigin: origin,
    }));
    installBridge({ syncContext, enqueueWorkflowEvent });
    const analytics = await initializeAndEnable();
    mockPosthog.capture.mockClear();
    const sessionId = '69800000-0000-4000-8000-000000000073';
    mockPosthog.get_session_id.mockReturnValue(sessionId);
    const before = Date.now();
    expect(
      analytics.trackRendererEvent('workflow_action_observed', {
        feature_area: 'scientific_workflow',
        workflow: 'annotation',
        workflow_action: 'create',
        workflow_status: 'created',
        action_phase: 'result',
        success: true,
      })
    ).toBe(true);
    await vi.waitFor(() => expect(enqueueWorkflowEvent).toHaveBeenCalledTimes(1));
    expect(syncContext).toHaveBeenCalledTimes(2);
    expect(enqueueWorkflowEvent.mock.calls[0]![0]).toMatchObject({
      context: { sessionId },
      properties: { workflow_status: 'created' },
    });
    expect(enqueueWorkflowEvent.mock.calls[0]![0].capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('does not bypass a refused native scientific admission through the renderer SDK', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const origin = {
        consentScope: '69800000-0000-4000-8000-000000000040',
        contextId: '69800000-0000-4000-8000-000000000041',
        processId: '69800000-0000-4000-8000-000000000042',
        classification: 'synthetic' as const,
      };
      const enqueueWorkflowEvent = vi.fn(async () => false);
      installBridge({
        syncContext: vi.fn(async () => ({ accepted: true, optionalOrigin: origin })),
        enqueueWorkflowEvent,
      });
      const analytics = await initializeAndEnable();
      mockPosthog.capture.mockClear();
      analytics.trackRendererEvent('meaningful_activity_completed', {
        feature_area: 'scientific_workflow',
        workflow: 'annotation',
        workflow_action: 'create',
        workflow_status: 'created',
        action_id: '69800000-0000-4000-8000-000000000043',
      });
      await vi.waitFor(() =>
        expect(warning).toHaveBeenCalledWith(
          '[analytics] native scientific event admission unavailable'
        )
      );
      expect(mockPosthog.capture).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['session', 'distinct'] as const)(
    'binds the native optional origin to the actual SDK %s and requires a fresh ACK after observed away/back',
    async (changed) => {
      const original = {
        consentScope: '69800000-0000-4000-8000-000000000010',
        contextId: '69800000-0000-4000-8000-000000000011',
        processId: '69800000-0000-4000-8000-000000000012',
        classification: 'synthetic' as const,
      };
      let origin = original;
      installBridge({
        syncContext: vi.fn(async () => ({ accepted: true, optionalOrigin: origin })),
      });
      const analytics = await initializeAndEnable();
      expect(analytics.captureAnalyticsOptionalOrigin()).toEqual(original);
      const read = changed === 'session' ? mockPosthog.get_session_id : mockPosthog.get_distinct_id;
      const previous = read();
      read.mockReturnValue('69800000-0000-4000-8000-000000000099');
      expect(analytics.captureAnalyticsOptionalOrigin()).toBeNull();
      read.mockReturnValue(previous);
      expect(analytics.captureAnalyticsOptionalOrigin()).toBeNull();
      origin = { ...original, contextId: '69800000-0000-4000-8000-000000000013' };
      await analytics.setAnalyticsConsent(true, { resumeExistingEpisode: true });
      expect(analytics.captureAnalyticsOptionalOrigin()).toEqual(origin);
      expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain(origin.contextId);
      expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain(origin.consentScope);
    }
  );

  it('does not publish a delayed optional origin after an observed SDK mismatch returns to the old value', async () => {
    const origin = {
      consentScope: '69800000-0000-4000-8000-000000000020',
      contextId: '69800000-0000-4000-8000-000000000021',
      processId: '69800000-0000-4000-8000-000000000022',
      classification: 'synthetic' as const,
    };
    const sync = vi.fn(async () => ({ accepted: true, optionalOrigin: origin }));
    installBridge({ syncContext: sync });
    const analytics = await initializeAndEnable();
    let release!: (value: { accepted: boolean; optionalOrigin: typeof origin }) => void;
    const held = new Promise<{ accepted: boolean; optionalOrigin: typeof origin }>((yes) => {
      release = yes;
    });
    sync.mockImplementationOnce(() => held);
    const pending = analytics.setAnalyticsConsent(true, { resumeExistingEpisode: true });
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    mockPosthog.get_session_id.mockReturnValue('69800000-0000-4000-8000-000000000029');
    expect(analytics.captureAnalyticsOptionalOrigin()).toBeNull();
    mockPosthog.get_session_id.mockReturnValue(IDS.session);
    release({ accepted: true, optionalOrigin: origin });
    await pending;
    expect(analytics.captureAnalyticsOptionalOrigin()).toBeNull();
    await analytics.setAnalyticsConsent(true, { resumeExistingEpisode: true });
    expect(analytics.captureAnalyticsOptionalOrigin()).toEqual(origin);
    await analytics.setAnalyticsConsent(false);
    expect(analytics.captureAnalyticsOptionalOrigin()).toBeNull();
  });

  it('does not infer an optional origin from an enabled flag or an ACK that omits native authority', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    expect(analytics.isAnalyticsCaptureReady()).toBe(true);
    expect(analytics.captureAnalyticsOptionalOrigin()).toBeNull();
  });

  it('does not initialize when neither main nor the browser build has a public key', async () => {
    const { initAnalyticsRenderer } = await loadAnalyticsOwnerForTest();
    await expect(initAnalyticsRenderer()).resolves.toBe(false);
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });

  it('does not bypass an authoritative main-process rejection with the baked browser key', async () => {
    vi.stubEnv('VITE_POSTHOG_API_KEY', 'phc_baked_production');
    installBridge({ getRuntimeConfig: vi.fn(async () => null) });

    const { initAnalyticsRenderer } = await loadAnalyticsOwnerForTest();

    await expect(initAnalyticsRenderer()).resolves.toBe(false);
    expect(mockPosthog.init).not.toHaveBeenCalled();
  });

  it('retries renderer initialization when direct opt-in grants main consent', async () => {
    let mainConsent = false;
    const getRuntimeConfig = vi.fn(async () => (mainConsent ? testRuntimeConfig() : null));
    const setConsent = vi.fn(async (enabled: boolean) => {
      mainConsent = enabled;
    });
    installBridge({ getRuntimeConfig, setConsent });
    const analytics = await loadAnalyticsOwnerForTest();

    await analytics.setAnalyticsConsent(false);
    await expect(analytics.initAnalyticsRenderer()).resolves.toBe(false);
    await analytics.optInAnalytics();

    expect(setConsent).toHaveBeenCalledWith(true);
    expect(getRuntimeConfig).toHaveBeenCalled();
    expect(analytics.isAnalyticsInitialized()).toBe(true);
    expect(mockPosthog.opt_in_capturing).toHaveBeenCalledOnce();
  });

  it('stops accepting queued events when an opted-in session has no runtime destination', async () => {
    const getRuntimeConfig = vi.fn(async () => null as ReturnType<typeof testRuntimeConfig> | null);
    installBridge({ getRuntimeConfig });
    const analytics = await loadAnalyticsOwnerForTest();

    expect(
      analytics.trackRendererEvent('workspace_opened', {
        feature_area: 'workspace',
        workspace_source: 'startup_arg',
        workspace_kind: 'folder',
        file_count_bucket: '1',
        file_count: 1,
      })
    ).toBe(true);

    await expect(analytics.setAnalyticsConsent(true)).resolves.toBe(true);
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(false);

    getRuntimeConfig.mockResolvedValue(testRuntimeConfig());
    await analytics.setAnalyticsConsent(true);
    expect(mockPosthog.capture).not.toHaveBeenCalledWith(
      'workspace_opened',
      expect.anything(),
      expect.anything()
    );
  });

  it('uses the main-process runtime key/host and the exact privacy-safe config', async () => {
    installBridge();
    const { initAnalyticsRenderer } = await loadAnalyticsOwnerForTest();
    await expect(initAnalyticsRenderer()).resolves.toBe(true);

    expect(mockPosthog.init).toHaveBeenCalledWith(
      'phc_test123',
      expect.objectContaining({
        api_host: 'http://127.0.0.1:48123',
        api_transport: 'XHR',
        __preview_disable_xhr_credentials: true,
        autocapture: SAFE_AUTOCAPTURE_CONFIG,
        capture_pageview: false,
        capture_pageleave: false,
        request_batching: true,
        disable_session_recording: false,
        session_recording: expect.objectContaining({
          maskAllInputs: true,
          maskTextSelector: '*',
          blockSelector:
            '[data-replay-block], [data-ph-no-capture], [data-analytics-block], .ph-no-capture, .rr-block',
          captureCanvas: { recordCanvas: false },
          compress_events: false,
        }),
        persistence: 'localStorage',
        ip: false,
        mask_all_element_attributes: SAFE_POSTHOG_PRIVACY_CONFIG.mask_all_element_attributes,
        mask_all_text: SAFE_POSTHOG_PRIVACY_CONFIG.mask_all_text,
        mask_personal_data_properties: SAFE_POSTHOG_PRIVACY_CONFIG.mask_personal_data_properties,
        advanced_disable_feature_flags: false,
        advanced_disable_feature_flags_on_first_load: false,
        disable_web_experiments: false,
        disable_surveys: true,
        disable_conversations: true,
        disable_product_tours: true,
        save_referrer: true,
        save_campaign_params: true,
        enable_recording_console_log: false,
        capture_performance: true,
        capture_dead_clicks: import.meta.env.MODE !== 'test',
        capture_heatmaps: import.meta.env.MODE !== 'test',
        opt_out_useragent_filter: true,
        before_send: expect.any(Function),
      })
    );
  });

  it('keeps replay network timing while removing local resource and native job URLs', async () => {
    installBridge();
    const { buildDesktopPostHogConfig } = await loadAnalyticsOwnerForTest();
    const config = buildDesktopPostHogConfig('https://us.i.posthog.com', 'phc_0123456789abcdef');
    const recording = config.session_recording as {
      recordHeaders: boolean;
      recordBody: boolean;
      maskCapturedNetworkRequestFn: (value: { name: string; duration: number; status: number }) => {
        name: string;
        duration: number;
        status: number;
      };
    };
    expect(recording.recordHeaders).toBe(false);
    expect(recording.recordBody).toBe(false);
    const mask = recording.maskCapturedNetworkRequestFn;
    expect(
      mask({
        name: 'http://127.0.0.1:9006/operations/agent-jobs/11111111-2222-7333-8444-555555555555?token=private',
        duration: 12,
        status: 200,
      })
    ).toEqual({ name: 'dnaforge://desktop/sidecar', duration: 12, status: 200 });
    expect(
      mask({ name: 'file:///private/local-source/out/index.html', duration: 4, status: 0 })
    ).toEqual({ name: 'dnaforge://desktop/resources', duration: 4, status: 0 });
    expect(mask({ name: 'https://dnaforge.com/icon.svg', duration: 3, status: 200 })).toEqual({
      name: 'https://dnaforge.com/icon.svg',
      duration: 3,
      status: 200,
    });
  });

  it('runs every event through the final fail-closed SDK sanitizer', async () => {
    installBridge();
    const { buildDesktopPostHogConfig } = await loadAnalyticsOwnerForTest();
    const config = buildDesktopPostHogConfig('https://us.i.posthog.com', 'phc_0123456789abcdef');
    const beforeSend = config.before_send as (event: unknown) => unknown;

    expect(
      beforeSend({
        event: '$autocapture',
        properties: {
          distinct_id: IDS.distinct,
          $session_id: IDS.session,
          $current_url: 'file:///Users/private/DNA1598_FILENAME.gb?token=DNA1598_TOKEN',
          $el_text: 'DNA1598_SEQUENCE_ATGC',
          $elements: [{ tag_name: 'button', text: 'DNA1598_PRIVATE_TEXT' }],
        },
      })
    ).toEqual({
      event: '$autocapture',
      properties: {
        distinct_id: IDS.distinct,
        $session_id: IDS.session,
        $current_url: 'dnaforge://desktop/unknown',
        $pathname: '/unknown',
        $elements: [{ tag_name: 'button' }],
      },
    });
    expect(
      beforeSend({
        event: '$pageview',
        properties: { token: 'phc_0123456789abcdef', distinct_id: IDS.distinct },
      })
    ).toEqual({
      event: '$pageview',
      properties: { token: 'phc_0123456789abcdef', distinct_id: IDS.distinct },
    });
    expect(
      beforeSend({
        event: '$pageview',
        properties: { token: 'phc_otherproject123456', distinct_id: IDS.distinct },
      })
    ).toEqual({ event: '$pageview', properties: { distinct_id: IDS.distinct } });
    expect(beforeSend({ event: '$unapproved', properties: {} })).toBeNull();
    expect(
      buildDesktopPostHogConfig('http://127.0.0.1:43123', 'phc_0123456789abcdef', 'c'.repeat(64))
    ).toEqual(
      expect.objectContaining({
        request_headers: {
          'X-DNAForge-Canary-Token': 'c'.repeat(64),
        },
        __preview_disable_beacon: true,
      })
    );
  });

  it('updates the sanitized SDK URL when the committed screen changes', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const config = analytics.buildDesktopPostHogConfig(
      'https://us.i.posthog.com',
      'phc_0123456789abcdef'
    );
    analytics.setAnalyticsScreenCategory('sequence');

    const beforeSend = config.before_send as (event: unknown) => {
      properties?: Record<string, unknown>;
    };
    expect(
      beforeSend({
        event: '$autocapture',
        properties: { $current_url: 'file:///private/workspace.gb', $elements: [] },
      }).properties
    ).toMatchObject({
      $current_url: 'dnaforge://desktop/sequence',
      $pathname: '/sequence',
    });
    expect(config).toHaveProperty('session_recording');
  });

  it.each([
    { buildKind: 'test', synthetic: false, actor: 'user', expected: 'private' },
    { buildKind: 'unknown', synthetic: false, actor: 'user', expected: 'unknown' },
    { buildKind: 'test', synthetic: true, actor: 'canary', expected: 'synthetic' },
  ] as const)(
    'keeps $expected runtime provenance on renderer custom and SDK events',
    async ({ buildKind, synthetic, actor, expected }) => {
      vi.stubGlobal('__DNAFORGE_APP_BUILD__', { kind: buildKind });
      installBridge({
        getRuntimeConfig: vi.fn(async () => ({
          ...testRuntimeConfig(),
          environment: 'production',
          isSynthetic: synthetic,
          telemetryActor: actor,
        })),
      });
      const analytics = await initializeAndEnable();
      analytics.trackRendererEvent('screen_viewed', { feature_area: 'navigation' });
      expect(mockPosthog.capture).toHaveBeenCalledWith(
        'screen_viewed',
        expect.objectContaining({ runtime_origin_class: expected })
      );
      const config = mockPosthog.init.mock.calls.at(-1)?.[1];
      expect(
        config?.before_send?.({
          event: '$autocapture',
          properties: { $elements: [], runtime_origin_class: '/private/reference.gb' },
        })?.properties
      ).toMatchObject({ runtime_origin_class: expected });
    }
  );

  it('stamps environment and actor onto SDK events the sanitizer strips ', async () => {
    installBridge();
    await initializeAndEnable();
    const config = mockPosthog.init.mock.calls.at(-1)?.[1] as {
      before_send: (event: unknown) => { properties: Record<string, unknown> } | null;
    };
    const sent = config.before_send({
      event: '$autocapture',
      properties: { $current_url: 'file:///private/workspace.gb', $elements: [] },
    });
    expect(sent?.properties).toMatchObject({
      environment: 'staging',
      release_channel: 'closed_beta',
      telemetry_actor: 'canary',
    });
  });

  it('captures registered events and makes rejected payload fields visible', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();
    trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
      unsafe: 'DNA1598_SECRET',
    });
    trackRendererEvent('unregistered_event', { feature_area: 'auth' });

    expect(mockPosthog.capture).toHaveBeenCalledTimes(3);
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'screen_viewed',
      expect.objectContaining({ feature_area: 'navigation', screen_category: 'unknown' })
    );
    const screenEvent = mockPosthog.capture.mock.calls.find(([event]) => event === 'screen_viewed');
    expect(screenEvent?.[1]).not.toHaveProperty('unsafe');
    expect(mockPosthog.capture).toHaveBeenNthCalledWith(
      1,
      'telemetry_payload_rejected',
      expect.objectContaining({
        rejected_event: 'screen_viewed',
        rejected_property_keys: 'unsafe',
        rejection_reason: 'unknown_property',
      })
    );
    expect(mockPosthog.capture).toHaveBeenNthCalledWith(
      3,
      'telemetry_payload_rejected',
      expect.objectContaining({
        rejected_event: 'unregistered_event',
        rejection_reason: 'unknown_event',
      })
    );
  });

  it('accepts notebook migration contract fields without a rejection diagnostic', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();

    trackRendererEvent('notebook_migration_result', {
      feature_area: 'reliability',
      workflow_status: 'success',
      version: '2',
      source: 'database-only',
      outcome: 'success',
      success: true,
    });

    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'notebook_migration_result',
      expect.objectContaining({ version: '2', source: 'database-only' })
    );
    expect(
      mockPosthog.capture.mock.calls.filter(([event]) => event === 'telemetry_payload_rejected')
    ).toEqual([]);
  });

  it('refuses operational auth events from the consent-gated renderer SDK', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();

    expect(
      trackRendererEvent('auth_started', {
        feature_area: 'auth',
        auth_flow_category: 'desktop_oauth',
        auth_provider_category: 'github',
      })
    ).toBe(false);
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('emits one aggregate diagnostic when one renderer payload has mixed defects', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();

    trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      source_surface: 'private_surface',
      unsafe: 'DNA1598_SECRET',
    });

    const diagnostics = mockPosthog.capture.mock.calls.filter(
      ([event]) => event === 'telemetry_payload_rejected'
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.[1]).toEqual(
      expect.objectContaining({
        rejected_event: 'screen_viewed',
        rejected_property_keys: 'source_surface,unsafe',
        rejected_property_count: 2,
        rejection_reason: 'mixed_property',
      })
    );
  });

  it('accepts the bounded sample activation proxy without a rejection event', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();

    trackRendererEvent('sample_project_opened', { feature_area: 'project' });
    trackRendererEvent('first_product_action_completed', { feature_area: 'project' });

    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'sample_project_opened',
      expect.objectContaining({ feature_area: 'project' })
    );
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'first_product_action_completed',
      expect.objectContaining({ feature_area: 'project' })
    );
    expect(
      mockPosthog.capture.mock.calls.filter(
        ([capturedEvent]) => capturedEvent === 'telemetry_payload_rejected'
      )
    ).toHaveLength(0);
  });

  it('classifies malformed producer payloads without echoing raw names or values', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();
    const sentinel = 'DNA2001_COOKIE_SESSION_BEARER_PRIVATE';

    trackRendererEvent(`invalid ${sentinel}`, {
      [`authorization ${sentinel}`]: sentinel,
    });

    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'telemetry_payload_rejected',
      expect.objectContaining({
        rejected_event: 'unknown',
        rejection_reason: 'unknown_event',
      })
    );
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain(sentinel);
  });

  it('attaches main-owned release, platform, join, and canary dimensions to renderer events', async () => {
    installBridge();
    const { trackRendererEvent } = await initializeAndEnable();

    trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
      source_surface: 'startup',
    });

    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'screen_viewed',
      expect.objectContaining({
        app_version: '0.7.9',
        platform_family: 'macos',
        environment: 'staging',
        release_channel: 'closed_beta',
        build_tag: 'v0.7.9-beta.1',
        telemetry_mode: 'closed_beta',
        pseudonymous_install_id: IDS.install,
        is_synthetic: true,
        telemetry_canary_id: IDS.canary,
        telemetry_actor: 'canary',
      })
    );
  });

  it('does not capture custom events between SDK init and app-owned opt-in', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    await analytics.initAnalyticsRenderer();
    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
    });
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('buffers a sanitized startup event until consent and identity are committed', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const { getTelemetryCorrelationContext } = await import('../telemetry-correlation');
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
    analytics.setAnalyticsScreenCategory('home');
    const captureContext = getTelemetryCorrelationContext();
    const capturedAt = 1_784_985_600_000;
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(capturedAt);

    expect(
      analytics.trackRendererEvent('workspace_opened', {
        feature_area: 'workspace',
        workspace_source: 'startup_arg',
        workspace_kind: 'folder',
        file_count_bucket: '2_5',
        file_count: 3,
        private_path: '/Users/private/research.gb',
      })
    ).toBe(true);
    now.mockRestore();
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    analytics.setAnalyticsScreenCategory('settings');
    await analytics.setAnalyticsConsent(true);

    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith(
        'workspace_opened',
        expect.objectContaining({
          feature_area: 'workspace',
          workspace_source: 'startup_arg',
          workspace_kind: 'folder',
          file_count_bucket: '2_5',
          file_count: 3,
          screen_category: 'home',
          app_session_id: captureContext.appSessionId,
          episode_correlation_id: captureContext.episodeCorrelationId,
          telemetry_canary_id: IDS.canary,
        }),
        { timestamp: new Date(capturedAt) }
      )
    );
    expect(mockPosthog.capture.mock.calls[0]?.[1]).not.toHaveProperty('private_path');
  });

  it('buffers tool helpers through the same pre-consent gate', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });

    analytics.trackToolOpened('lims', 'sidebar');
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    await analytics.setAnalyticsConsent(true);

    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith(
        'tool_opened',
        expect.objectContaining({
          feature_area: 'tool_usage',
          tool_id: 'lims',
          surface: 'sidebar',
          action: 'opened',
        }),
        expect.objectContaining({ timestamp: expect.any(Date) })
      )
    );
  });

  it('buffers sanitized rejection accounting alongside pre-consent events', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
    const sentinel = 'DNA2001_PRECONSENT_PRIVATE_VALUE';

    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
      unsafe: sentinel,
    });
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    await analytics.setAnalyticsConsent(true);

    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith(
        'telemetry_payload_rejected',
        expect.objectContaining({
          rejected_event: 'screen_viewed',
          rejected_property_keys: 'unsafe',
          rejection_reason: 'unknown_property',
        }),
        expect.objectContaining({ timestamp: expect.any(Date) })
      )
    );
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'screen_viewed',
      expect.objectContaining({ feature_area: 'navigation', screen_category: 'unknown' }),
      expect.objectContaining({ timestamp: expect.any(Date) })
    );
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain(sentinel);
  });

  it('never lets rejection accounting consume semantic pre-consent capacity', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });

    for (let index = 0; index < 256; index += 1) {
      expect(
        analytics.trackRendererEvent('screen_viewed', {
          feature_area: 'navigation',
          screen_category: 'home',
          invalid_private_key: `private-${index}`,
        })
      ).toBe(true);
    }
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(false);

    await analytics.setAnalyticsConsent(true);

    await vi.waitFor(() => {
      const semanticCaptures = mockPosthog.capture.mock.calls.filter(
        ([event]) => event === 'screen_viewed'
      );
      expect(semanticCaptures).toHaveLength(256);
    });
    const rejectionCaptures = mockPosthog.capture.mock.calls.filter(
      ([event]) => event === 'telemetry_payload_rejected'
    );
    expect(rejectionCaptures).toHaveLength(33);
    expect(rejectionCaptures).toContainEqual([
      'telemetry_payload_rejected',
      expect.objectContaining({
        rejected_event: 'preconsent_rejection_queue',
        rejected_property_count: 0,
        dropped_rejection_count: 224,
        rejection_reason: 'queue_overflow',
      }),
      expect.objectContaining({ timestamp: expect.any(Date) }),
    ]);
    expect(JSON.stringify(mockPosthog.capture.mock.calls)).not.toContain('private-');
  });

  it('purges pre-consent startup events when the durable decision is opt-out', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });

    expect(
      analytics.trackRendererEvent('workspace_opened', {
        feature_area: 'workspace',
        workspace_source: 'startup_arg',
        workspace_kind: 'folder',
        file_count_bucket: '1',
        file_count: 1,
      })
    ).toBe(true);

    await analytics.setAnalyticsConsent(false);
    await analytics.setAnalyticsConsent(true);

    expect(mockPosthog.capture).not.toHaveBeenCalledWith(
      'workspace_opened',
      expect.anything(),
      expect.anything()
    );
  });

  it('buffers pre-identity semantic events losslessly and flushes them once in FIFO order', async () => {
    let acceptIdentity!: (result: { accepted: boolean }) => void;
    const identityAccepted = new Promise<{ accepted: boolean }>((resolve) => {
      acceptIdentity = resolve;
    });
    installBridge({
      syncContext: vi.fn(() => identityAccepted),
    });
    const analytics = await loadAnalyticsOwnerForTest();
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
    await analytics.initAnalyticsRenderer();

    const enable = analytics.optInAnalytics();
    await vi.waitFor(() => expect(mockPosthog.opt_in_capturing).toHaveBeenCalledOnce());
    expect(mockPosthog.startSessionRecording).toHaveBeenCalled();

    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_784_985_600_000)
      .mockReturnValueOnce(1_784_985_600_250);
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    expect(
      analytics.trackRendererEvent('tool_opened', {
        feature_area: 'tool_usage',
        tool_id: 'assembly',
        surface: 'tab',
        action: 'opened',
      })
    ).toBe(true);
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    acceptIdentity({ accepted: true });
    await enable;

    await vi.waitFor(() => expect(mockPosthog.capture).toHaveBeenCalledTimes(2));
    expect(mockPosthog.capture).toHaveBeenNthCalledWith(
      1,
      'screen_viewed',
      expect.objectContaining({ feature_area: 'navigation', screen_category: 'unknown' }),
      { timestamp: new Date(1_784_985_600_000) }
    );
    expect(mockPosthog.capture).toHaveBeenNthCalledWith(
      2,
      'tool_opened',
      expect.objectContaining({ feature_area: 'tool_usage', tool_id: 'assembly' }),
      { timestamp: new Date(1_784_985_600_250) }
    );

    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
    });
    expect(mockPosthog.capture).toHaveBeenCalledTimes(3);
    expect(mockPosthog.capture).toHaveBeenNthCalledWith(
      3,
      'screen_viewed',
      expect.objectContaining({ feature_area: 'navigation', screen_category: 'unknown' })
    );
    now.mockRestore();
  });

  it('classifies only the accepted authenticated account UUID as identified', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const { useAuthStore } = await import('../../stores/auth-store');
    const accountId = '550e8400-e29b-41d4-a716-446655440099';

    expect(analytics.isAnalyticsIdentityIdentified()).toBe(false);

    mockPosthog.get_distinct_id.mockReturnValue(accountId);
    useAuthStore.setState({
      state: {
        status: 'signed-in',
        session: {
          accountId,
          desktopSessionId: 'desktop-identified-test',
          channel: 'test',
          accessTokenExpiresAt: '2026-08-18T00:00:00.000Z',
        },
      },
      hydrated: true,
    });

    await vi.waitFor(() => expect(analytics.isAnalyticsIdentityIdentified()).toBe(true));
    expect(mockPosthog.identify).toHaveBeenCalledWith(accountId, expect.any(Object));

    mockPosthog.get_distinct_id.mockReturnValue(IDS.distinct);
    expect(analytics.isAnalyticsIdentityIdentified()).toBe(false);
  });

  it('purges pre-identity semantic events when the user opts out', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    const { useAuthStore } = await import('../../stores/auth-store');
    vi.clearAllMocks();

    let acceptResync!: (result: { accepted: boolean }) => void;
    const resyncAccepted = new Promise<{ accepted: boolean }>((resolve) => {
      acceptResync = resolve;
    });
    bridge.syncContext.mockImplementationOnce(() => resyncAccepted);
    useAuthStore.setState({
      state: { status: 'unavailable', reason: 'encryption_unavailable' },
      hydrated: true,
    });
    await vi.waitFor(() => expect(bridge.syncContext).toHaveBeenCalledOnce());

    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    await analytics.optOutAnalytics();
    acceptResync({ accepted: true });
    await Promise.resolve();

    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('preserves queued semantic events when a later identity transition supersedes the first', async () => {
    const bridge = installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    const { useAuthStore } = await import('../../stores/auth-store');
    const firstAccountId = '550e8400-e29b-41d4-a716-446655440001';
    const secondAccountId = '550e8400-e29b-41d4-a716-446655440002';
    const signedIn = (accountId: string) =>
      ({
        status: 'signed-in' as const,
        session: {
          accountId,
          desktopSessionId: `desktop-${accountId}`,
          channel: 'stable',
          accessTokenExpiresAt: '2026-07-26T00:00:00.000Z',
        },
      }) as const;
    mockPosthog.get_distinct_id.mockReturnValue(firstAccountId);
    useAuthStore.setState({
      state: signedIn(firstAccountId),
      hydrated: true,
    });
    await analytics.initAnalyticsRenderer();
    await analytics.optInAnalytics();
    vi.clearAllMocks();

    let activeDistinctId = firstAccountId;
    mockPosthog.get_distinct_id.mockImplementation(() => activeDistinctId);
    mockPosthog.identify.mockImplementation((accountId: string) => {
      activeDistinctId = accountId;
    });
    mockPosthog.reset.mockImplementation(() => {
      activeDistinctId = IDS.distinct;
    });

    let acceptAccountSwitch!: (result: { accepted: boolean }) => void;
    const accountSwitchAccepted = new Promise<{ accepted: boolean }>((resolve) => {
      acceptAccountSwitch = resolve;
    });
    bridge.syncContext
      .mockImplementationOnce(() => accountSwitchAccepted)
      .mockResolvedValueOnce({ accepted: true });
    useAuthStore.setState({
      state: signedIn(secondAccountId),
      hydrated: true,
    });
    await vi.waitFor(() => expect(bridge.syncContext).toHaveBeenCalledOnce());

    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    useAuthStore.setState({ state: { status: 'signed-out' }, hydrated: true });
    await vi.waitFor(() => expect(bridge.syncContext).toHaveBeenCalledTimes(2));
    acceptAccountSwitch({ accepted: true });
    await vi.waitFor(() => expect(mockPosthog.capture).toHaveBeenCalledTimes(1));

    expect(mockPosthog.reset).toHaveBeenCalledTimes(2);
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'screen_viewed',
      expect.objectContaining({ feature_area: 'navigation', screen_category: 'unknown' }),
      expect.objectContaining({ timestamp: expect.any(Date) })
    );
  });

  it('accepts primer save tracking without optional operation or duration fields in development', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    vi.stubEnv('DEV', true);
    expect(() =>
      analytics.trackToolActionStarted('primer_design', 'sidebar', 'created')
    ).not.toThrow();
    expect(() =>
      analytics.trackToolActionCompleted('primer_design', 'sidebar', 'created')
    ).not.toThrow();
    const calls = mockPosthog.capture.mock.calls.filter(
      ([event]) => event === 'tool_action_started' || event === 'tool_action_completed'
    );
    expect(calls).toHaveLength(2);
    for (const [, properties] of calls) {
      expect(properties).not.toHaveProperty('operation_id');
      expect(properties).not.toHaveProperty('duration_ms');
    }
    expect(
      mockPosthog.capture.mock.calls.some(([event]) => event === 'telemetry_payload_rejected')
    ).toBe(false);
  });

  it('emits correlated operation fields and drops malformed UUIDs/durations', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    const operationId = '550e8400-e29b-41d4-a716-446655440099';
    analytics.trackToolActionStarted('assembly', 'tab', 'computed', operationId);
    analytics.trackToolActionCompleted('assembly', 'tab', 'computed', operationId, 123);
    analytics.trackToolError('assembly', 'tab', 'compute', 'computed', 'not-an-id', -1);
    analytics.trackToolOperationError({
      toolId: 'assembly',
      surface: 'tab',
      attemptedAction: 'computed',
      outcomeAction: 'cancelled',
      errorClass: 'cancelled',
      operationId,
      durationMs: 200,
    });

    const eventCalls = (event: string) =>
      mockPosthog.capture.mock.calls.filter(([capturedEvent]) => capturedEvent === event);
    expect(eventCalls('tool_action_started')[0]).toEqual([
      'tool_action_started',
      expect.objectContaining({ operation_id: operationId, action: 'computed' }),
    ]);
    expect(eventCalls('tool_action_completed')[0]).toEqual([
      'tool_action_completed',
      expect.objectContaining({ operation_id: operationId, duration_ms: 123 }),
    ]);
    const toolErrorCalls = eventCalls('tool_error');
    expect(toolErrorCalls[0][1]).not.toHaveProperty('operation_id');
    expect(toolErrorCalls[0][1]).not.toHaveProperty('duration_ms');
    expect(toolErrorCalls[1]).toEqual([
      'tool_error',
      expect.objectContaining({
        action: 'cancelled',
        attempted_action: 'computed',
        error_class: 'cancelled',
        operation_id: operationId,
        duration_ms: 200,
      }),
    ]);
    expect(eventCalls('telemetry_payload_rejected')).toHaveLength(1);
  });

  it('loads and refreshes beta attribution defaults without leaking raw settings', async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          value: JSON.stringify({
            beta_invite_id: 'bti_0123456789abcdef',
            beta_cohort: 'closed_beta',
            invite_batch: 'manual_onboarding',
          }),
        },
      ]);
    let listener: (() => void) | undefined;
    const bridge = installBridge({
      onBetaAttributionUpdated: vi.fn((callback: () => void) => {
        listener = callback;
        return () => {};
      }),
    });
    (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI = {
      analytics: bridge,
      db: { select },
    };
    const analytics = await initializeAndEnable();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    listener?.();
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
    analytics.trackToolOpened('lims', 'sidebar');
    expect(mockPosthog.capture).toHaveBeenCalledWith(
      'tool_opened',
      expect.objectContaining({ beta_invite_id: 'bti_0123456789abcdef' })
    );
  });

  it('disables both SDK and main without egress and suppresses later events', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    await analytics.optOutAnalytics();
    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
    });

    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(bridge.setConsent).toHaveBeenLastCalledWith(false);
    expect(bridge.persistConsent).toHaveBeenLastCalledWith(false);
    expect(bridge.setConsent.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.persistConsent.mock.invocationCallOrder[1]
    );
  });

  it('keeps renderer analytics disabled when the SDK queue contract changes', async () => {
    installBridge();
    const analytics = await loadAnalyticsOwnerForTest();
    Object.defineProperty(mockPosthog, '_requestQueue', { value: undefined, configurable: true });
    try {
      await expect(analytics.initAnalyticsRenderer()).rejects.toThrow(
        'PostHog queue contract unavailable'
      );
      expect(mockPosthog.opt_out_capturing).toHaveBeenCalledOnce();
      expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(mockPosthog, '_requestQueue', {
        value: mockRequestQueue,
        configurable: true,
      });
    }
  });

  it('revokes SDK capture before recorder shutdown can flush buffered snapshots', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    let sdkCaptureEnabled = true;
    const recorderFlushEgress = vi.fn();
    mockPosthog.opt_out_capturing.mockImplementationOnce(() => {
      sdkCaptureEnabled = false;
    });
    mockPosthog.stopSessionRecording.mockImplementationOnce(() => {
      if (sdkCaptureEnabled) recorderFlushEgress();
    });

    await analytics.optOutAnalytics();

    expect(recorderFlushEgress).not.toHaveBeenCalled();
  });

  it('purges PostHog batching, pre-load, and retry queues before revocation returns', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    mockPosthog.__request_queue.push({ event: 'pre_load' });
    mockRequestQueue._queue.push({ event: 'batched' });
    mockRequestQueue._flushTimeout = setTimeout(() => {}, 60_000);
    mockRetryQueue._queue.push({ event: 'retry' });
    mockRetryQueue._poller = setTimeout(() => {}, 60_000);
    mockRetryQueue._isPolling = true;

    await analytics.optOutAnalytics();

    expect(mockPosthog.__request_queue).toEqual([]);
    expect(mockRequestQueue._queue).toEqual([]);
    expect(mockRequestQueue._flushTimeout).toBeUndefined();
    expect(mockRetryQueue._queue).toEqual([]);
    expect(mockRetryQueue._poller).toBeUndefined();
    expect(mockRetryQueue._isPolling).toBe(false);
    expect(mockPosthog.config.request_batching).toBe(false);
    mockRequestQueue.unload();
    mockRetryQueue.unload();
    expect(mockRequestQueueUnload).not.toHaveBeenCalled();
    expect(mockRetryQueueUnload).not.toHaveBeenCalled();
  });

  it('opts in without generating an unregistered $opt_in event and enables main', async () => {
    const bridge = installBridge();
    await initializeAndEnable();
    expect(mockPosthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(mockPosthog.startSessionRecording).toHaveBeenCalled();
    expect(bridge.setConsent).toHaveBeenCalledWith(true);
    expect(bridge.persistConsent).toHaveBeenCalledWith(true);
    expect(bridge.setConsent.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.persistConsent.mock.invocationCallOrder[0]
    );
  });

  it('closes native capture when durable opt-in persistence fails', async () => {
    const bridge = installBridge();
    bridge.persistConsent.mockRejectedValueOnce(new Error('disk full'));
    const analytics = await loadAnalyticsOwnerForTest();
    await analytics.initAnalyticsRenderer();

    await expect(analytics.optInAnalytics()).rejects.toThrow('disk full');

    expect(bridge.setConsent.mock.calls).toEqual([[true], [false]]);
    expect(mockPosthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it('closes renderer and main egress before persisting an opt-out', async () => {
    let acknowledgeMainClose!: () => void;
    const mainClose = new Promise<void>((resolve) => {
      acknowledgeMainClose = resolve;
    });
    const bridge = installBridge({
      setConsent: vi.fn((enabled: boolean) => (enabled ? Promise.resolve() : mainClose)),
    });
    const analytics = await initializeAndEnable();
    vi.clearAllMocks();

    const transition = analytics.optOutAnalytics();

    expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(bridge.setConsent).toHaveBeenCalledWith(false);
    expect(bridge.persistConsent).not.toHaveBeenCalled();

    acknowledgeMainClose();
    await transition;
    expect(bridge.persistConsent).toHaveBeenCalledWith(false);
  });

  it('restores the prior live gates when durable opt-out persistence fails', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    vi.clearAllMocks();
    bridge.persistConsent.mockRejectedValueOnce(new Error('disk full'));

    await expect(analytics.optOutAnalytics()).rejects.toThrow('disk full');

    expect(bridge.setConsent.mock.calls).toEqual([[false], [true]]);
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
    expect(mockPosthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(mockPosthog.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(mockPosthog.startSessionRecording).toHaveBeenCalled();
    expect(mockRequestQueueEnable).toHaveBeenCalledOnce();
    expect(mockPosthog.config.request_batching).toBe(true);
    mockRequestQueue.unload();
    mockRetryQueue.unload();
    expect(mockRequestQueueUnload).toHaveBeenCalledOnce();
    expect(mockRetryQueueUnload).toHaveBeenCalledOnce();

    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
    });
    expect(mockPosthog.capture).toHaveBeenCalledTimes(1);
  });

  it('stays fail-closed and does not persist when the main gate cannot close', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    vi.clearAllMocks();
    bridge.setConsent.mockRejectedValueOnce(new Error('main did not acknowledge'));

    await expect(analytics.optOutAnalytics()).rejects.toThrow('main did not acknowledge');
    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
    });

    expect(bridge.persistConsent).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  it('closes a failed startup session without persisting a user opt-out', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    vi.clearAllMocks();

    await analytics.failClosedAnalyticsForSession();
    analytics.trackRendererEvent('screen_viewed', {
      feature_area: 'navigation',
      screen_category: 'home',
    });

    expect(bridge.setConsent).toHaveBeenCalledWith(false);
    expect(bridge.persistConsent).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
    expect(mockPosthog.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  it('handles an eager main-close rejection while a prior consent transition is active', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    vi.clearAllMocks();

    let finishPriorTransition!: () => void;
    const priorTransition = new Promise<void>((resolve) => {
      finishPriorTransition = resolve;
    });
    const closeError = new Error('main close failed');
    const eagerRejection = Promise.reject(closeError);
    const catchSpy = vi.spyOn(eagerRejection, 'catch');
    let closeCalls = 0;
    bridge.setConsent.mockImplementation((enabled: boolean) => {
      if (enabled) return priorTransition;
      closeCalls += 1;
      return closeCalls === 1 ? eagerRejection : Promise.resolve();
    });

    const prior = analytics.optInAnalytics();
    await Promise.resolve();
    const failClosed = analytics.failClosedAnalyticsForSession();

    expect(catchSpy).toHaveBeenCalledOnce();
    finishPriorTransition();
    await prior;
    await expect(failClosed).rejects.toThrow('main close failed');
  });

  it('purges pre-identity events when startup fails before identity settles', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    const { useAuthStore } = await import('../../stores/auth-store');
    vi.clearAllMocks();

    let acceptResync!: (result: { accepted: boolean }) => void;
    const resyncAccepted = new Promise<{ accepted: boolean }>((resolve) => {
      acceptResync = resolve;
    });
    bridge.syncContext.mockImplementationOnce(() => resyncAccepted);
    useAuthStore.setState({
      state: { status: 'unavailable', reason: 'encryption_unavailable' },
      hydrated: true,
    });
    await vi.waitFor(() => expect(bridge.syncContext).toHaveBeenCalledOnce());

    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    expect(mockPosthog.capture).not.toHaveBeenCalled();

    await analytics.failClosedAnalyticsForSession();
    expect(bridge.persistConsent).not.toHaveBeenCalled();
    acceptResync({ accepted: true });
    await analytics.optInAnalytics();

    expect(mockPosthog.capture).not.toHaveBeenCalledWith('screen_viewed', expect.anything());
  });

  it('serializes competing opt-out and opt-in transitions', async () => {
    let acknowledgeMainClose!: () => void;
    const mainClose = new Promise<void>((resolve) => {
      acknowledgeMainClose = resolve;
    });
    const bridge = installBridge({
      setConsent: vi.fn((enabled: boolean) => (enabled ? Promise.resolve() : mainClose)),
    });
    const analytics = await initializeAndEnable();
    vi.clearAllMocks();

    const disable = analytics.setAnalyticsConsent(false);
    const enable = analytics.setAnalyticsConsent(true);
    await Promise.resolve();

    expect(bridge.setConsent.mock.calls).toEqual([[false]]);
    expect(bridge.persistConsent).not.toHaveBeenCalled();

    acknowledgeMainClose();
    await Promise.all([disable, enable]);
    expect(bridge.persistConsent.mock.calls).toEqual([[false], [true]]);
    expect(bridge.setConsent.mock.calls).toEqual([[false], [true]]);
  });

  it('never reopens capture when opt-out supersedes an in-flight opt-in', async () => {
    let acknowledgeEnable!: () => void;
    const enableMain = new Promise<void>((resolve) => {
      acknowledgeEnable = resolve;
    });
    const bridge = installBridge({
      setConsent: vi.fn((enabled: boolean) => (enabled ? enableMain : Promise.resolve())),
    });
    const analytics = await loadAnalyticsOwnerForTest();
    await analytics.initAnalyticsRenderer();

    const enable = analytics.optInAnalytics();
    await vi.waitFor(() => expect(bridge.setConsent).toHaveBeenCalledWith(true));
    const disable = analytics.optOutAnalytics();
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(false);

    acknowledgeEnable();
    await Promise.all([enable, disable]);

    expect(bridge.persistConsent.mock.calls).toEqual([[false]]);
    expect(bridge.setConsent.mock.calls).toEqual([[true], [false], [false]]);
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('keeps durable consent revoked when atomic opt-out races an in-flight grant', async () => {
    let durableConsent = false;
    let acknowledgeGrant!: () => void;
    const grantResponse = new Promise<void>((resolve) => {
      acknowledgeGrant = resolve;
    });
    const grantConsent = vi.fn(() => {
      durableConsent = true;
      return grantResponse;
    });
    const revokeConsent = vi.fn(async () => {
      durableConsent = false;
    });
    installBridge({ grantConsent, revokeConsent });
    const analytics = await loadAnalyticsOwnerForTest();
    await analytics.initAnalyticsRenderer();

    const enable = analytics.optInAnalytics();
    await vi.waitFor(() => expect(grantConsent).toHaveBeenCalledTimes(1));
    expect(durableConsent).toBe(true);

    const disable = analytics.optOutAnalytics();
    expect(revokeConsent).toHaveBeenCalledTimes(1);
    expect(durableConsent).toBe(false);

    acknowledgeGrant();
    await Promise.all([enable, disable]);

    expect(revokeConsent).toHaveBeenCalledTimes(2);
    expect(durableConsent).toBe(false);
    expect(mockPosthog.startSessionRecording).not.toHaveBeenCalled();
    expect(mockPosthog.capture).not.toHaveBeenCalled();
  });

  it('keeps queued events when opt-out persistence fails and flushes them after rollback', async () => {
    const bridge = installBridge();
    const analytics = await initializeAndEnable();
    const { useAuthStore } = await import('../../stores/auth-store');
    vi.clearAllMocks();

    let acceptResync!: (result: { accepted: boolean }) => void;
    bridge.syncContext.mockImplementationOnce(
      () =>
        new Promise<{ accepted: boolean }>((resolve) => {
          acceptResync = resolve;
        })
    );
    useAuthStore.setState({
      state: { status: 'unavailable', reason: 'encryption_unavailable' },
      hydrated: true,
    });
    await vi.waitFor(() => expect(bridge.syncContext).toHaveBeenCalledOnce());
    expect(
      analytics.trackRendererEvent('screen_viewed', {
        feature_area: 'navigation',
        screen_category: 'home',
      })
    ).toBe(true);
    bridge.persistConsent.mockRejectedValueOnce(new Error('disk full'));

    await expect(analytics.optOutAnalytics()).rejects.toThrow('disk full');
    acceptResync({ accepted: true });
    await vi.waitFor(() =>
      expect(mockPosthog.capture).toHaveBeenCalledWith(
        'screen_viewed',
        expect.objectContaining({ feature_area: 'navigation', screen_category: 'unknown' }),
        expect.objectContaining({ timestamp: expect.any(Date) })
      )
    );
  });

  it('retires local capture generations synchronously on opt-out and identity transition', async () => {
    installBridge();
    const analytics = await initializeAndEnable();
    await vi.waitFor(() => expect(analytics.isAnalyticsCaptureReady()).toBe(true));
    const first = analytics.getAnalyticsCaptureGeneration();
    const disable = analytics.optOutAnalytics();
    expect(analytics.isAnalyticsCaptureReady()).toBe(false);
    expect(analytics.getAnalyticsCaptureGeneration()).toBeGreaterThan(first);
    await disable;
    await analytics.optInAnalytics();
    await vi.waitFor(() => expect(analytics.isAnalyticsCaptureReady()).toBe(true));
    const afterOptIn = analytics.getAnalyticsCaptureGeneration();
    expect(afterOptIn).toBeGreaterThan(first);
    const { useAuthStore } = await import('../../stores/auth-store');
    useAuthStore.setState({
      state: { status: 'unavailable', reason: 'encryption_unavailable' },
      hydrated: true,
    });
    expect(analytics.isAnalyticsCaptureReady()).toBe(false);
    expect(analytics.getAnalyticsCaptureGeneration()).toBeGreaterThan(afterOptIn);
  });
});

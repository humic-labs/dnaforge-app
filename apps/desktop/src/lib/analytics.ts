import type { ToolErrorReasonCode } from '../shared/tool-error-reasons';
import posthog, { type CapturedNetworkRequest } from 'posthog-js/lib/src/entrypoints/module.es';
import { failLoudlyOnTelemetryContractViolation } from '../shared/telemetry-contract-violation';
import {
  classifyInternalOperator,
  CLICK_FIREHOSE_FLAG,
  SAFE_AUTOCAPTURE_CONFIG,
  SAFE_OPERATION_ERROR_CLASSES,
  SAFE_POSTHOG_PRIVACY_CONFIG,
  DESKTOP_SESSION_RECORDING_CONFIG,
  ANALYTICS_ORGANIZATION_GROUP,
  sanitizePostHogSdkEvent,
  type AnalyticsConsentBasis,
  type AnalyticsIdentityContext,
  type ConsentPolicyDecision,
  type SdkCaptureEvent,
} from '@waypoint/analytics-policy';
import { installAnalyticsFirehose, isClickFirehoseEnabled } from './analytics-firehose';
import {
  TOOL_ACTION_COMPLETED,
  TOOL_ACTION_STARTED,
  TOOL_ERROR,
  TOOL_OPENED,
  type ToolUsageAction,
  type ToolUsageErrorClass,
  type ToolUsageSurface,
  type ToolUsageToolId,
} from './analytics-events';
import {
  isAllowedClosedBetaEvent,
  normalizePlatformFamily,
  sanitizeClosedBetaProperties,
  type ClosedBetaEvent,
} from '../shared/analytics-allowlist';
import { isWorkspaceSyncReceiptEvent } from '../shared/workspace-sync-telemetry';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../shared/analytics-registry.generated';
import type {
  AnalyticsGrantOptions,
  AnalyticsIdentitySyncResult,
  AnalyticsRuntimeConfig,
  MeaningfulActivityActorKind,
  MeaningfulActivityAuthority,
  MeaningfulActivityExecutionMode,
  RendererWorkflowTelemetryRequest,
} from '../shared/analytics-types';
import {
  betaAttributionAnalyticsProperties,
  parseBetaAttributionSetting,
  BETA_ATTRIBUTION_SETTING_KEY,
} from '../shared/beta-attribution';
import { RendererAnalyticsIdentityCoordinator } from './analytics-identity';
import {
  getDesktopAuthSnapshot,
  subscribeDesktopAuthSnapshot,
} from '../features/auth/public/auth-state';
import { beginTelemetryEpisode, getTelemetryCorrelationContext } from './telemetry-correlation';
import {
  createPreidentityDiagnostics,
  PreidentityDiagnosticCancelled,
  PREIDENTITY_PUBLIC_CONTROL,
  PREIDENTITY_SYNTHETIC_SENTINEL,
} from './analytics-preidentity-diagnostics';
import type { RuntimeProfile } from '../shared/runtime-profile';
import type { DesktopAuthState } from '../shared/auth-types';
import type { OptionalTelemetryOrigin } from '../shared/analytics-types';
import { analyticsOrganizationId } from '../shared/analytics-organization';
import type { WorkspaceSyncOrganizationsResult } from '../shared/workspace-sync-ipc';

let initialized = false;
let rendererDestinationUnavailable = false;
let analyticsConsentState: 'off' | 'on' | 'draining' = 'off';
let betaAttributionDefaults: Record<string, unknown> = {};
let rendererRuntimeDefaults: Record<string, unknown> = {};
let currentScreenCategory = 'unknown';
let identityCoordinator: RendererAnalyticsIdentityCoordinator | null = null;
let identityReady = false;
let nativeOptionalOrigin: OptionalTelemetryOrigin | null = null;
let nativeOptionalOriginEpoch = 0;
let nativeOptionalIdentity: AnalyticsIdentityContext | null = null;
let nativeWorkflowIdentityNeedsSync = false;
let nativeOptionalPendingIdentity: { distinctId: string; sessionId: string } | null = null;
let analyticsCaptureGeneration = 0;
const UNKNOWN_MEANINGFUL_ACTIVITY_AUTHORITY: MeaningfulActivityAuthority = {
  actorKind: 'unknown',
  executionMode: 'interactive',
  impersonated: false,
};
let meaningfulActivityAuthority: MeaningfulActivityAuthority =
  UNKNOWN_MEANINGFUL_ACTIVITY_AUTHORITY;
let unsubscribeAuthStore: (() => void) | null = null;
let identityFallbackHandle: ReturnType<typeof setTimeout> | undefined;
let consentTransition: Promise<void> | null = null;
let desiredAnalyticsConsent: boolean | null = null;
const readinessSubscribers = new Set<() => void>();
const DESKTOP_IDENTIFIED_ACCOUNT_KEY = 'dnaforge_analytics_identified_account_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPERATION_ERROR_CLASS_SET = new Set<string>(SAFE_OPERATION_ERROR_CLASSES);
type PendingRendererEvent = {
  event: ClosedBetaEvent;
  properties: Record<string, unknown>;
  capturedAt: Date;
};

const pendingPreConsentEvents: PendingRendererEvent[] = [];
const PRE_CONSENT_EVENT_LIMIT = 256;

const pendingPreConsentRejectionEvents: PendingRendererEvent[] = [];
const PRE_CONSENT_REJECTION_EVENT_LIMIT = 32;
let pendingPreConsentRejectionOverflowEvent: PendingRendererEvent | null = null;
const pendingPreIdentityEvents: PendingRendererEvent[] = [];
const PRE_IDENTITY_FLUSH_CHUNK_SIZE = 250;
let preIdentityFlushScheduled = false;
let preIdentityFlushHandle: ReturnType<typeof setTimeout> | undefined;
let pendingPreIdentityHead = 0;
const COMMON_RENDERER_EVENT_PROPERTY_KEYS = new Set([
  '$insert_id',
  'app_version',
  'platform_family',
  'environment',
  'release_channel',
  'build_tag',
  'telemetry_mode',
  'beta_invite_id',
  'beta_cohort',
  'invite_batch',
  'app_session_id',
  'episode_correlation_id',
  'pseudonymous_install_id',
  'is_synthetic',
  'telemetry_canary_id',
  'telemetry_actor',
  'ci_run_id',
  'internal_operator',
  'identity_kind',
]);
let restoreRequestQueueUnload: (() => void) | null = null;
let restoreRetryQueueUnload: (() => void) | null = null;
let removeOptOutUnloadFence: (() => void) | null = null;

interface PostHogQueueInternals {
  config?: {
    request_batching?: boolean;
  };
  __request_queue?: unknown[];
  _requestQueue?: {
    _queue?: unknown[];
    _flushTimeout?: ReturnType<typeof setTimeout>;
    _isPaused?: boolean;
    enable?: () => void;
    unload?: () => void;
  };
  _retryQueue?: {
    _queue?: unknown[];
    _poller?: ReturnType<typeof setTimeout>;
    _isPolling?: boolean;
    unload?: () => void;
  };
}

interface RendererAnalyticsBridge {
  getRuntimeConfig?(): Promise<AnalyticsRuntimeConfig | null>;
  getConsentPolicy?(): Promise<ConsentPolicyDecision>;
  persistConsent?(enabled: boolean): Promise<void>;
  grantConsent?(options?: AnalyticsGrantOptions): Promise<boolean | void>;
  revokeConsent?(): Promise<void>;
  syncContext?(context: AnalyticsIdentityContext): Promise<AnalyticsIdentitySyncResult>;
  enqueueWorkflowEvent?(request: RendererWorkflowTelemetryRequest): Promise<boolean>;
  setConsent?(enabled: boolean): Promise<void>;
  onBetaAttributionUpdated?(callback: () => void): () => void;
}

interface RendererElectronApi {
  runtime?: { getProfile?(): RuntimeProfile };
  analytics?: RendererAnalyticsBridge;
  db?: {
    select<T>(sql: string, params?: unknown[]): Promise<T>;
  };
  cloudSync?: { listOrganizations?(): Promise<WorkspaceSyncOrganizationsResult> };
}

function electronApi(): RendererElectronApi | undefined {
  return (window as Window & { electronAPI?: RendererElectronApi }).electronAPI;
}

function preidentityDiagnosticsEnabled(): boolean {
  if (import.meta.env.MODE !== 'test') return false;
  try {
    const profile = electronApi()?.runtime?.getProfile?.();
    return (
      profile?.kind === 'scenario-e2e' &&
      profile.isElectron === true &&
      profile.isE2e === true &&
      profile.scenarioMutationAllowed === true
    );
  } catch {
    return false;
  }
}

let preidentityDiagnostics: ReturnType<typeof createPreidentityDiagnostics> | null = null;
function ownedPreidentityDiagnostics() {
  if (!preidentityDiagnosticsEnabled()) return null;
  return (preidentityDiagnostics ??= createPreidentityDiagnostics(
    preidentityDiagnosticsEnabled,
    (generation) => {
      let first = Infinity;
      let last = -Infinity;
      let publicControlCount = 0;
      let syntheticSentinelPresent = false;
      for (let index = 0; index < pendingPreIdentityEvents.length; index += 1) {
        const item = pendingPreIdentityEvents[index];
        syntheticSentinelPresent ||= JSON.stringify(item).includes(PREIDENTITY_SYNTHETIC_SENTINEL);
        if (index < pendingPreIdentityHead) continue;
        const clock = item.capturedAt.getTime();
        first = Math.min(first, clock);
        last = Math.max(last, clock);
        if (
          item.event === 'interaction_observed' &&
          item.properties.target_test_id === PREIDENTITY_PUBLIC_CONTROL
        ) {
          publicControlCount += 1;
        }
      }
      return {
        ready: isAnalyticsCaptureReady(),
        consentClass: analyticsConsentState,
        generation,
        pendingCount: pendingPreIdentityEvents.length - pendingPreIdentityHead,
        pendingHead: pendingPreIdentityHead,
        publicControlCount,
        occurrenceClockRange: first === Infinity ? null : { first, last },
        syntheticSentinelPresent,
      };
    }
  ));
}

export function getAnalyticsPreidentityDiagnosticsForTest() {
  const owner = ownedPreidentityDiagnostics();
  if (!owner) return null;
  return {
    armNext: () => owner.armNext(),
    waitForNativeResult: () => owner.waitForNativeResult(),
    release: () => owner.release(),
    read: () => owner.read(),
    dispose: () => owner.dispose(),
  };
}

export function disposeAnalyticsPreidentityDiagnosticsForTest(): void {
  preidentityDiagnostics?.dispose();
}

function getRendererPlatformFamily(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const platform = navigator.platform.toLowerCase().includes('mac') ? 'macos' : navigator.platform;
  return normalizePlatformFamily(platform);
}

function maskDesktopReplayNetworkRequest(
  request: CapturedNetworkRequest
): CapturedNetworkRequest | undefined {
  try {
    const url = new URL(request.name);
    if (url.protocol === 'file:') return { ...request, name: 'dnaforge://desktop/resources' };
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return { ...request, name: 'dnaforge://desktop/sidecar' };
    return request;
  } catch {
    return undefined;
  }
}

export function buildDesktopPostHogConfig(
  host: string,
  projectToken: string,
  canaryProxyToken?: string
): Record<string, unknown> {
  return {
    api_host: host,
    api_transport: 'XHR',
    __preview_disable_xhr_credentials: true,
    ...(canaryProxyToken
      ? {
          request_headers: { 'X-DNAForge-Canary-Token': canaryProxyToken },

          __preview_disable_beacon: true,
        }
      : {}),
    autocapture: SAFE_AUTOCAPTURE_CONFIG,
    capture_pageview: false,
    capture_pageleave: false,

    request_batching: true,
    disable_session_recording: false,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    session_recording: {
      ...DESKTOP_SESSION_RECORDING_CONFIG,
      recordHeaders: false,
      recordBody: false,
      maskCapturedNetworkRequestFn: maskDesktopReplayNetworkRequest,
    },
    persistence: 'localStorage',
    ip: false,
    opt_out_capturing_by_default: true,
    capture_dead_clicks: import.meta.env.MODE !== 'test',
    capture_heatmaps: import.meta.env.MODE !== 'test',

    opt_out_useragent_filter: import.meta.env.MODE === 'test',
    enable_recording_console_log: false,
    ...SAFE_POSTHOG_PRIVACY_CONFIG,
    before_send: (event: SdkCaptureEvent | null): SdkCaptureEvent | null =>
      stampSdkEventRuntime(
        sanitizePostHogSdkEvent(
          event,
          'desktop',
          currentScreenCategory,
          CLOSED_BETA_EVENT_PROPERTIES,
          projectToken,
          CLOSED_BETA_EVENT_VERSIONS
        )
      ),
    debug: import.meta.env.DEV,
  };
}

const SDK_EVENT_RUNTIME_KEYS = [
  'environment',
  'release_channel',
  'telemetry_actor',
  'app_version',
  'platform_family',
  'is_synthetic',
] as const;

function stampSdkEventRuntime(event: SdkCaptureEvent | null): SdkCaptureEvent | null {
  if (!event || !event.event.startsWith('$')) return event;
  for (const key of SDK_EVENT_RUNTIME_KEYS) {
    const value = rendererRuntimeDefaults[key];
    if (value !== undefined && event.properties[key] === undefined) {
      event.properties[key] = value;
    }
  }
  return event;
}

export async function initAnalyticsRenderer(): Promise<boolean> {
  if (initialized) return true;

  const config = await resolveRendererRuntimeConfig();
  if (!config) {
    if (desiredAnalyticsConsent === true) {
      rendererDestinationUnavailable = true;
      clearPendingPreConsentEvents();
    }
    return false;
  }
  rendererDestinationUnavailable = false;

  rendererRuntimeDefaults = {
    app_version: config.appVersion,
    platform_family: config.platformFamily,
    environment: config.environment,
    release_channel: config.releaseChannel,
    ...(config.buildTag ? { build_tag: config.buildTag } : {}),
    telemetry_mode: config.releaseChannel,
    ...(config.pseudonymousInstallId
      ? { pseudonymous_install_id: config.pseudonymousInstallId }
      : {}),
    is_synthetic: config.isSynthetic,
    ...(config.telemetryCanaryId ? { telemetry_canary_id: config.telemetryCanaryId } : {}),
    telemetry_actor: config.telemetryActor,
    ...(config.ciRunId ? { ci_run_id: config.ciRunId } : {}),
  };

  posthog.init(
    config.apiKey,
    buildDesktopPostHogConfig(config.host, config.apiKey, config.canaryProxyToken)
  );
  assertSdkQueueContract();
  initialized = true;
  identityCoordinator = createIdentityCoordinator();
  installRendererFirehose();

  void loadBetaAttributionDefaults();
  electronApi()?.analytics?.onBetaAttributionUpdated?.(() => {
    void loadBetaAttributionDefaults();
  });
  return true;
}

export function setAnalyticsScreenCategory(screenCategory: string): void {
  currentScreenCategory = screenCategory;
}

export function trackAllowedEvent(
  event: ClosedBetaEvent,
  properties?: Record<string, unknown>
): boolean {
  if (isWorkspaceSyncReceiptEvent(event) || !isAllowedClosedBetaEvent(event)) return false;
  assertRendererTelemetryContract(event, properties);
  if (rendererDestinationUnavailable) return false;
  if (!initialized || analyticsConsentState !== 'on') {
    return enqueuePreConsentEvent(event, properties);
  }

  const sanitizedProperties = sanitizeRendererEventProperties(event, properties);
  recordRejectedRendererProperties(event, properties, sanitizedProperties);
  return enqueueOrCaptureRendererEvent(event, sanitizedProperties);
}

function enqueueOrCaptureRendererEvent(
  event: ClosedBetaEvent,
  sanitizedProperties: Record<string, unknown>
): boolean {
  if (
    (event === 'workflow_action_observed' || event === 'meaningful_activity_completed') &&
    electronApi()?.analytics?.enqueueWorkflowEvent &&
    identityCoordinator &&
    (nativeWorkflowIdentityNeedsSync ||
      (nativeOptionalIdentity &&
        (posthog.get_distinct_id() !== nativeOptionalIdentity.distinctId ||
          posthog.get_session_id() !== nativeOptionalIdentity.sessionId)))
  ) {
    setIdentityReady(false);
    void startIdentitySync().catch(() =>
      console.warn('[analytics] scientific identity synchronization unavailable')
    );
  }
  if (!identityReady) {
    pendingPreIdentityEvents.push({
      event,
      properties: sanitizedProperties,
      capturedAt: new Date(Date.now()),
    });
    return true;
  }

  return captureRendererEvent(event, sanitizedProperties);
}

function captureRendererEvent(
  event: ClosedBetaEvent,
  properties: Record<string, unknown>,
  capturedAt?: Date
): boolean {
  const bridge = electronApi()?.analytics;
  if (
    (event === 'workflow_action_observed' || event === 'meaningful_activity_completed') &&
    bridge?.enqueueWorkflowEvent
  ) {
    const origin = captureAnalyticsOptionalOrigin();
    if (!origin || !nativeOptionalIdentity) return false;
    const eventId =
      typeof properties.$insert_id === 'string' && UUID_RE.test(properties.$insert_id)
        ? properties.$insert_id
        : crypto.randomUUID();
    const safe = sanitizePostHogSdkEvent(
      { event, properties: { ...properties, $insert_id: eventId } },
      'desktop',
      currentScreenCategory,
      CLOSED_BETA_EVENT_PROPERTIES,
      undefined,
      CLOSED_BETA_EVENT_VERSIONS
    );
    if (!safe) return false;
    const request: RendererWorkflowTelemetryRequest = {
      origin,
      context: { ...nativeOptionalIdentity },
      eventName: event,
      eventId,
      capturedAtMs: capturedAt?.getTime() ?? Date.now(),
      properties: safe.properties,
    };
    const unavailable = () =>
      console.warn('[analytics] native scientific event admission unavailable');
    try {
      void bridge
        .enqueueWorkflowEvent(request)
        .then((accepted) => {
          if (!accepted) unavailable();
        })
        .catch(unavailable);
      return true;
    } catch {
      unavailable();
      return false;
    }
  }
  if (capturedAt) posthog.capture(event, properties, { timestamp: capturedAt });
  else posthog.capture(event, properties);
  return true;
}

function sanitizeRendererEventProperties(
  event: ClosedBetaEvent,
  properties?: Record<string, unknown>
): Record<string, unknown> {
  return sanitizeClosedBetaProperties(normalizeRendererEventProperties(event, properties), {
    ...rendererCaptureTimeDefaults(),
    ...rendererInitializedDefaults(),
  });
}

function normalizeRendererEventProperties(
  event: ClosedBetaEvent,
  properties?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const eventProperties =
    event === TOOL_ERROR &&
    typeof properties?.error_class === 'string' &&
    !SAFE_OPERATION_ERROR_CLASS_SET.has(properties.error_class)
      ? { ...properties, error_class: 'unknown' }
      : properties;

  return eventProperties;
}

function rendererCaptureTimeDefaults(): Record<string, unknown> {
  const correlation = getTelemetryCorrelationContext();
  return {
    screen_category: currentScreenCategory,
    platform_family: getRendererPlatformFamily(),
    environment:
      import.meta.env.MODE === 'test' ? 'test' : import.meta.env.DEV ? 'development' : 'production',
    release_channel: import.meta.env.VITE_RELEASE_CHANNEL || 'unknown',
    telemetry_mode: import.meta.env.VITE_RELEASE_CHANNEL || (import.meta.env.DEV ? 'dev' : 'prod'),
    app_session_id: correlation.appSessionId,
    episode_correlation_id: correlation.episodeCorrelationId,
  };
}

function rendererInitializedDefaults(): Record<string, unknown> {
  const authState = getDesktopAuthSnapshot().state;
  const operator =
    authState.status === 'signed-in'
      ? classifyInternalOperator(authState.session.email)
      : undefined;
  return {
    ...betaAttributionDefaults,
    ...rendererRuntimeDefaults,
    ...(operator ? { internal_operator: operator } : {}),
    identity_kind: isAnalyticsIdentityIdentified() ? 'identified' : 'anonymous',
  };
}

function flushPendingPreIdentityEvents(): void {
  if (
    !identityReady ||
    analyticsConsentState !== 'on' ||
    pendingPreIdentityHead >= pendingPreIdentityEvents.length
  ) {
    return;
  }
  if (preIdentityFlushScheduled) return;
  preIdentityFlushScheduled = true;
  preIdentityFlushHandle = setTimeout(flushNextPreIdentityChunk, 0);
}

function flushNextPreIdentityChunk(): void {
  preIdentityFlushScheduled = false;
  preIdentityFlushHandle = undefined;
  if (!identityReady || analyticsConsentState !== 'on') return;
  const end = Math.min(
    pendingPreIdentityHead + PRE_IDENTITY_FLUSH_CHUNK_SIZE,
    pendingPreIdentityEvents.length
  );
  while (pendingPreIdentityHead < end) {
    const item = pendingPreIdentityEvents[pendingPreIdentityHead];
    pendingPreIdentityHead += 1;
    captureRendererEvent(item.event, item.properties, item.capturedAt);
  }
  if (pendingPreIdentityHead >= pendingPreIdentityEvents.length) {
    pendingPreIdentityEvents.length = 0;
    pendingPreIdentityHead = 0;
  }
  flushPendingPreIdentityEvents();
}

function clearPendingPreIdentityEvents(): void {
  pendingPreIdentityEvents.length = 0;
  pendingPreIdentityHead = 0;
  if (preIdentityFlushHandle !== undefined) clearTimeout(preIdentityFlushHandle);
  preIdentityFlushHandle = undefined;
  preIdentityFlushScheduled = false;
}

function promotePendingPreConsentEvents(): void {
  const retainedEvents = [
    ...pendingPreConsentEvents,
    ...pendingPreConsentRejectionEvents,
    ...(pendingPreConsentRejectionOverflowEvent ? [pendingPreConsentRejectionOverflowEvent] : []),
  ];
  for (const item of retainedEvents) {
    pendingPreIdentityEvents.push({
      event: item.event,

      properties: sanitizeClosedBetaProperties(item.properties, rendererInitializedDefaults()),
      capturedAt: item.capturedAt,
    });
  }
  pendingPreConsentEvents.length = 0;
  pendingPreConsentRejectionEvents.length = 0;
  pendingPreConsentRejectionOverflowEvent = null;
}

function clearPendingPreConsentEvents(): void {
  pendingPreConsentEvents.length = 0;
  pendingPreConsentRejectionEvents.length = 0;
  pendingPreConsentRejectionOverflowEvent = null;
}

export async function loadBetaAttributionDefaults(): Promise<void> {
  const api = electronApi();
  if (!api?.db?.select) return;
  try {
    const rows = await api.db.select<Array<{ value: string }>>(
      'SELECT value FROM settings WHERE key = ?',
      [BETA_ATTRIBUTION_SETTING_KEY]
    );
    betaAttributionDefaults = betaAttributionAnalyticsProperties(
      parseBetaAttributionSetting(rows[0]?.value)
    );
  } catch {
    betaAttributionDefaults = {};
  }
}

const OPERATIONAL_AUTH_EVENTS = new Set(['auth_started', 'auth_completed', 'auth_failed']);

export function trackRendererEvent(event: string, properties?: Record<string, unknown>): boolean {
  if (OPERATIONAL_AUTH_EVENTS.has(event)) return false;
  if (!isAllowedClosedBetaEvent(event)) {
    assertRendererTelemetryContract(event, properties);
    recordRendererPayloadRejection(event, Object.keys(properties ?? {}), 'unknown_event');
    return false;
  }
  return trackAllowedEvent(event, properties);
}

function enqueuePreConsentEvent(
  event: ClosedBetaEvent,
  properties: Record<string, unknown> | undefined
): boolean {
  if (
    desiredAnalyticsConsent === false ||
    pendingPreConsentEvents.length >= PRE_CONSENT_EVENT_LIMIT
  ) {
    return false;
  }
  const sanitizedProperties = sanitizeClosedBetaProperties(
    normalizeRendererEventProperties(event, properties),
    rendererCaptureTimeDefaults()
  );
  pendingPreConsentEvents.push({
    event,

    properties: sanitizedProperties,
    capturedAt: new Date(Date.now()),
  });

  recordRejectedRendererProperties(event, properties, sanitizedProperties);
  return true;
}

function recordRejectedRendererProperties(
  event: ClosedBetaEvent,
  input: Record<string, unknown> | undefined,
  sanitized: Record<string, unknown>
): void {
  const rejection = classifyRejectedRendererProperties(event, input, sanitized);
  if (rejection) recordRendererPayloadRejection(event, rejection.keys, rejection.reason);
}

function classifyRejectedRendererProperties(
  event: ClosedBetaEvent,
  input: Record<string, unknown> | undefined,
  sanitized: Record<string, unknown>
): { keys: string[]; reason: 'unknown_property' | 'invalid_property' | 'mixed_property' } | null {
  if (event === 'telemetry_payload_rejected' || !input) return null;
  const eventKeys = new Set<string>(CLOSED_BETA_EVENT_PROPERTIES[event]);
  const unknownKeys: string[] = [];
  const invalidKeys: string[] = [];
  for (const key of Object.keys(input)) {
    if (!eventKeys.has(key) && !COMMON_RENDERER_EVENT_PROPERTY_KEYS.has(key)) {
      unknownKeys.push(key);
    } else if (!(key in sanitized)) {
      invalidKeys.push(key);
    }
  }
  const keys = [...unknownKeys, ...invalidKeys];
  if (keys.length === 0) return null;
  const reason =
    unknownKeys.length > 0 && invalidKeys.length > 0
      ? 'mixed_property'
      : unknownKeys.length > 0
        ? 'unknown_property'
        : 'invalid_property';
  return { keys, reason };
}

const FAIL_LOUD_ON_TELEMETRY_CONTRACT = import.meta.env.DEV && import.meta.env.MODE !== 'test';

function assertRendererTelemetryContract(
  event: string,
  properties: Record<string, unknown> | undefined
): void {
  if (!FAIL_LOUD_ON_TELEMETRY_CONTRACT) return;
  if (!isAllowedClosedBetaEvent(event)) {
    failLoudlyOnTelemetryContractViolation(
      { process: 'renderer', event, reason: 'unknown_event', keys: Object.keys(properties ?? {}) },
      true
    );
    return;
  }
  const rejection = classifyRejectedRendererProperties(
    event,
    properties,
    sanitizeRendererEventProperties(event, properties)
  );
  if (rejection) {
    failLoudlyOnTelemetryContractViolation(
      { process: 'renderer', event, reason: rejection.reason, keys: rejection.keys },
      true
    );
  }
}

function recordRendererPayloadRejection(
  rejectedEvent: string,
  rejectedPropertyKeys: string[],
  reason: 'unknown_event' | 'unknown_property' | 'invalid_property' | 'mixed_property'
): void {
  if (rejectedPropertyKeys.length === 0 && reason !== 'unknown_event') {
    return;
  }
  const rejectionProperties = {
    feature_area: 'telemetry',
    rejected_event: rejectedEvent,
    rejected_property_keys: rejectedPropertyKeys.sort().join(','),
    rejected_property_count: rejectedPropertyKeys.length,
    rejection_reason: reason,
    occurred_at_ms: Date.now(),
  };
  if (!initialized || analyticsConsentState !== 'on') {
    enqueuePreConsentRejectionEvent(rejectionProperties);
    return;
  }
  const properties = sanitizeRendererEventProperties(
    'telemetry_payload_rejected',
    rejectionProperties
  );
  enqueueOrCaptureRendererEvent('telemetry_payload_rejected', properties);
}

function enqueuePreConsentRejectionEvent(properties: Record<string, unknown>): void {
  if (desiredAnalyticsConsent === false || rendererDestinationUnavailable) {
    return;
  }
  if (pendingPreConsentRejectionEvents.length >= PRE_CONSENT_REJECTION_EVENT_LIMIT) {
    const capturedAt = pendingPreConsentRejectionOverflowEvent?.capturedAt ?? new Date(Date.now());
    const previousCount = Number(
      pendingPreConsentRejectionOverflowEvent?.properties.dropped_rejection_count ?? 0
    );
    pendingPreConsentRejectionOverflowEvent = {
      event: 'telemetry_payload_rejected',
      properties: sanitizeClosedBetaProperties(
        {
          feature_area: 'telemetry',
          rejected_event: 'preconsent_rejection_queue',
          rejected_property_count: 0,
          dropped_rejection_count: previousCount + 1,
          rejection_reason: 'queue_overflow',
          occurred_at_ms: capturedAt.getTime(),
        },
        rendererCaptureTimeDefaults()
      ),
      capturedAt,
    };
    return;
  }
  pendingPreConsentRejectionEvents.push({
    event: 'telemetry_payload_rejected',
    properties: sanitizeClosedBetaProperties(properties, rendererCaptureTimeDefaults()),
    capturedAt: new Date(Date.now()),
  });
}

function toolUsageProperties(
  toolId: ToolUsageToolId,
  surface: ToolUsageSurface,
  action: ToolUsageAction,
  extra?: {
    attempted_action?: ToolUsageAction;
    error_class?: ToolUsageErrorClass;
    reason_code?: ToolErrorReasonCode;
    operation_id?: string;
    duration_ms?: number;
  }
): Record<string, unknown> {
  const optionalProperties = Object.fromEntries(
    Object.entries(extra ?? {}).filter(([, value]) => value !== undefined)
  );
  return { feature_area: 'tool_usage', tool_id: toolId, surface, action, ...optionalProperties };
}

export function trackToolOpened(toolId: ToolUsageToolId, surface: ToolUsageSurface): void {
  trackAllowedEvent(TOOL_OPENED, toolUsageProperties(toolId, surface, 'opened'));
}

export function trackToolActionStarted(
  toolId: ToolUsageToolId,
  surface: ToolUsageSurface,
  action: Exclude<ToolUsageAction, 'opened' | 'completed' | 'failed'>,
  operationId?: string
): void {
  trackAllowedEvent(
    TOOL_ACTION_STARTED,
    toolUsageProperties(toolId, surface, action, { operation_id: operationId })
  );
}

export function trackToolActionCompleted(
  toolId: ToolUsageToolId,
  surface: ToolUsageSurface,
  action: Exclude<ToolUsageAction, 'opened' | 'failed'>,
  operationId?: string,
  durationMs?: number
): void {
  trackAllowedEvent(
    TOOL_ACTION_COMPLETED,
    toolUsageProperties(toolId, surface, action, {
      operation_id: operationId,
      duration_ms: durationMs,
    })
  );
}

export function trackToolError(
  toolId: ToolUsageToolId,
  surface: ToolUsageSurface,
  errorClass: ToolUsageErrorClass = 'unknown',
  attemptedAction: ToolUsageAction = 'failed',
  operationId?: string,
  durationMs?: number
): void {
  trackAllowedEvent(
    TOOL_ERROR,
    toolUsageProperties(toolId, surface, 'failed', {
      attempted_action: attemptedAction,
      error_class: errorClass,
      operation_id: operationId,
      duration_ms: durationMs,
    })
  );
}

export function trackToolOperationError(input: {
  toolId: ToolUsageToolId;
  surface: ToolUsageSurface;
  attemptedAction: ToolUsageAction;
  outcomeAction: 'failed' | 'cancelled';
  errorClass: ToolUsageErrorClass;
  reasonCode?: ToolErrorReasonCode;
  operationId: string;
  durationMs: number;
}): void {
  trackAllowedEvent(
    TOOL_ERROR,
    toolUsageProperties(input.toolId, input.surface, input.outcomeAction, {
      attempted_action: input.attemptedAction,
      error_class: input.errorClass,
      reason_code: input.reasonCode,
      operation_id: input.operationId,
      duration_ms: input.durationMs,
    })
  );
}

async function optOutAnalyticsTransition(
  wasEnabledAtRequest?: boolean,
  immediateNativeRevocation?: Promise<void>
): Promise<void> {
  const bridge = electronApi()?.analytics;
  const wasEnabled = wasEnabledAtRequest ?? analyticsConsentState === 'on';

  if (analyticsConsentState !== 'draining') closeRendererEgressGateImmediately();

  if (immediateNativeRevocation) {
    try {
      await immediateNativeRevocation;
    } catch (error) {
      await rollbackFailedOptOut(error, wasEnabled, bridge);
    }
  } else {
    try {
      await bridge?.setConsent?.(false);
    } catch (error) {
      analyticsConsentState = 'off';
      throw error;
    }
    try {
      await bridge?.persistConsent?.(false);
    } catch (error) {
      await rollbackFailedOptOut(error, wasEnabled, bridge);
    }
  }

  clearPendingPreIdentityEvents();
  analyticsConsentState = 'off';
}

async function rollbackFailedOptOut(
  error: unknown,
  wasEnabled: boolean,
  bridge: RendererAnalyticsBridge | undefined
): Promise<never> {
  if (!wasEnabled) {
    clearPendingPreIdentityEvents();
    analyticsConsentState = 'off';
    throw error;
  }

  try {
    desiredAnalyticsConsent = true;
    await bridge?.setConsent?.(true);
    if (initialized) await projectOptInToSdkAndIdentity();
  } catch (rollbackError) {
    analyticsConsentState = 'off';
    throw Object.assign(
      new Error('Failed to persist analytics opt-out and restore the prior consent state'),
      { cause: rollbackError }
    );
  }
  throw error;
}

let uninstallRendererFirehose: (() => void) | null = null;

function installRendererFirehose(): void {
  uninstallRendererFirehose?.();
  uninstallRendererFirehose = installAnalyticsFirehose({
    capture: (event, properties) => {
      trackRendererEvent(event, properties);
    },
    isEnabled: () =>
      analyticsConsentState === 'on' &&
      isClickFirehoseEnabled((key) =>
        key === CLICK_FIREHOSE_FLAG ? posthog.getFeatureFlag(CLICK_FIREHOSE_FLAG) : undefined
      ),
  });
}

function closeRendererEgressGateImmediately(): void {
  preidentityDiagnostics?.cancel();
  analyticsConsentState = 'draining';
  setIdentityReady(false);
  clearIdentityFallback();
  clearPendingPreConsentEvents();
  uninstallRendererFirehose?.();
  uninstallRendererFirehose = null;
  if (!initialized) return;
  posthog.opt_out_capturing();
  posthog.stopSessionRecording();
  purgeUnsentRendererTelemetry();
}

function assertSdkQueueContract(): void {
  const sdk = posthog as PostHogQueueInternals;
  if (
    !Array.isArray(sdk.__request_queue) ||
    !Array.isArray(sdk._requestQueue?._queue) ||
    typeof sdk._requestQueue?.enable !== 'function' ||
    typeof sdk._requestQueue?.unload !== 'function' ||
    !Array.isArray(sdk._retryQueue?._queue) ||
    typeof sdk._retryQueue?.unload !== 'function'
  ) {
    posthog.opt_out_capturing();
    posthog.stopSessionRecording();
    throw new Error('PostHog queue contract unavailable; renderer analytics remains disabled');
  }
}

function purgeUnsentRendererTelemetry(): void {
  const internals = posthog as PostHogQueueInternals;
  const requestQueue = internals._requestQueue;
  if (requestQueue?._flushTimeout !== undefined) {
    clearTimeout(requestQueue._flushTimeout);
    requestQueue._flushTimeout = undefined;
  }
  requestQueue?._queue?.splice(0);
  if (requestQueue) requestQueue._isPaused = true;
  internals.__request_queue?.splice(0);

  const retryQueue = internals._retryQueue;
  if (retryQueue?._poller !== undefined) {
    clearTimeout(retryQueue._poller);
    retryQueue._poller = undefined;
  }
  retryQueue?._queue?.splice(0);
  if (retryQueue) retryQueue._isPolling = false;

  if (internals.config) internals.config.request_batching = false;
  suppressSdkUnloadFlushes(internals);
  installOptOutUnloadFence();
}

function suppressSdkUnloadFlushes(internals: PostHogQueueInternals): void {
  const requestQueue = internals._requestQueue;
  if (requestQueue?.unload && !restoreRequestQueueUnload) {
    const original = requestQueue.unload;
    requestQueue.unload = () => {};
    restoreRequestQueueUnload = () => {
      requestQueue.unload = original;
      requestQueue.enable?.();
    };
  }

  const retryQueue = internals._retryQueue;
  if (retryQueue?.unload && !restoreRetryQueueUnload) {
    const original = retryQueue.unload;
    retryQueue.unload = () => {};
    restoreRetryQueueUnload = () => {
      retryQueue.unload = original;
    };
  }
}

function restoreSdkUnloadFlushes(): void {
  const internals = posthog as PostHogQueueInternals;
  if (internals.config) internals.config.request_batching = true;
  removeOptOutUnloadFence?.();
  removeOptOutUnloadFence = null;
  restoreRequestQueueUnload?.();
  restoreRequestQueueUnload = null;
  restoreRetryQueueUnload?.();
  restoreRetryQueueUnload = null;
}

function installOptOutUnloadFence(): void {
  if (removeOptOutUnloadFence || typeof window === 'undefined') return;
  const clearBeforeSdkUnload = (): void => {
    const internals = posthog as PostHogQueueInternals;
    internals.__request_queue?.splice(0);
    internals._requestQueue?._queue?.splice(0);
    internals._retryQueue?._queue?.splice(0);
    suppressSdkUnloadFlushes(internals);
  };
  window.addEventListener('pagehide', clearBeforeSdkUnload, { capture: true });
  window.addEventListener('unload', clearBeforeSdkUnload, { capture: true });
  removeOptOutUnloadFence = () => {
    window.removeEventListener('pagehide', clearBeforeSdkUnload, { capture: true });
    window.removeEventListener('unload', clearBeforeSdkUnload, { capture: true });
  };
}

async function optInAnalyticsTransition(): Promise<void> {
  const bridge = electronApi()?.analytics;
  if (!(await enableMainAndPersistConsent(bridge, 'explicit'))) return;
  beginTelemetryEpisode();
  if (await initAnalyticsRenderer()) await projectOptInToSdkAndIdentity();
}

async function projectOptInToSdkAndIdentity(): Promise<void> {
  if (desiredAnalyticsConsent === false) return;
  restoreSdkUnloadFlushes();
  analyticsConsentState = 'on';
  setIdentityReady(false);
  promotePendingPreConsentEvents();
  posthog.opt_in_capturing({ captureEventName: false });
  posthog.startSessionRecording();
  installRendererFirehose();
  await startIdentitySync();
}

async function setAnalyticsConsentTransition(resumeExistingEpisode: boolean): Promise<boolean> {
  const bridge = electronApi()?.analytics;
  if (!(await enableMainAndPersistConsent(bridge, 'default'))) return false;
  if (!resumeExistingEpisode) beginTelemetryEpisode();
  if (await initAnalyticsRenderer()) await projectOptInToSdkAndIdentity();
  return true;
}

async function enableMainAndPersistConsent(
  bridge: RendererAnalyticsBridge | undefined,
  basis: AnalyticsConsentBasis
): Promise<boolean> {
  if (bridge?.grantConsent) {
    const granted = await bridge.grantConsent(basis === 'explicit' ? { basis } : undefined);
    if (granted === false) return false;
    if (desiredAnalyticsConsent === false) {
      if (bridge.revokeConsent) await bridge.revokeConsent();
      else {
        await bridge.setConsent?.(false);
        await bridge.persistConsent?.(false);
      }
      return false;
    }
    return true;
  }

  await bridge?.setConsent?.(true);
  if (isOptOutDesired()) {
    await bridge?.setConsent?.(false);
    return false;
  }
  try {
    await bridge?.persistConsent?.(true);
  } catch (error) {
    try {
      await bridge?.setConsent?.(false);
    } catch (rollbackError) {
      throw Object.assign(
        new Error('Failed to persist analytics opt-in and close the native capture gate'),
        { cause: rollbackError }
      );
    }
    throw error;
  }
  if (isOptOutDesired()) {
    await bridge?.setConsent?.(false);
    await bridge?.persistConsent?.(false);
    return false;
  }
  return true;
}

function isOptOutDesired(): boolean {
  return desiredAnalyticsConsent === false;
}

function serializeConsentTransition<T>(transition: () => Promise<T>): Promise<T> {
  const result = consentTransition ? consentTransition.then(transition, transition) : transition();
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  consentTransition = tail;
  void tail.then(() => {
    if (consentTransition === tail) consentTransition = null;
  });
  return result;
}

export function optOutAnalytics(): Promise<void> {
  desiredAnalyticsConsent = false;
  const wasEnabled = analyticsConsentState === 'on';
  closeRendererEgressGateImmediately();
  const immediateNativeRevocation = electronApi()?.analytics?.revokeConsent?.();
  return serializeConsentTransition(() =>
    optOutAnalyticsTransition(wasEnabled, immediateNativeRevocation)
  );
}

export function optInAnalytics(): Promise<void> {
  desiredAnalyticsConsent = true;
  rendererDestinationUnavailable = false;
  return serializeConsentTransition(optInAnalyticsTransition);
}

export function failClosedAnalyticsForSession(): Promise<void> {
  desiredAnalyticsConsent = false;

  closeRendererEgressGateImmediately();
  clearPendingPreIdentityEvents();
  const immediateMainClose = electronApi()?.analytics?.setConsent?.(false);

  void immediateMainClose?.catch(() => undefined);
  return serializeConsentTransition(async () => {
    try {
      await immediateMainClose;
    } finally {
      clearPendingPreIdentityEvents();
      analyticsConsentState = 'off';
    }
  });
}

export function setAnalyticsConsent(
  enabled: boolean,
  options: { resumeExistingEpisode?: boolean } = {}
): Promise<boolean> {
  desiredAnalyticsConsent = enabled;
  if (!enabled) {
    const wasEnabled = analyticsConsentState === 'on';
    closeRendererEgressGateImmediately();
    const immediateNativeRevocation = electronApi()?.analytics?.revokeConsent?.();
    return serializeConsentTransition(async () => {
      await optOutAnalyticsTransition(wasEnabled, immediateNativeRevocation);
      return true;
    });
  }
  rendererDestinationUnavailable = false;
  return serializeConsentTransition(() =>
    setAnalyticsConsentTransition(options.resumeExistingEpisode === true)
  );
}

export async function readAnalyticsConsentPolicy(): Promise<ConsentPolicyDecision | null> {
  return (await electronApi()?.analytics?.getConsentPolicy?.()) ?? null;
}

export function isAnalyticsOptedOut(): boolean {
  if (!initialized) return true;
  return posthog.has_opted_out_capturing();
}

export function isAnalyticsInitialized(): boolean {
  return initialized;
}

export function getAnalyticsCaptureGeneration(): number {
  return analyticsCaptureGeneration;
}

export function isAnalyticsCaptureReady(): boolean {
  return initialized && analyticsConsentState === 'on' && identityReady;
}

export function captureAnalyticsOptionalOrigin(): OptionalTelemetryOrigin | null {
  const identity = nativeOptionalIdentity ?? nativeOptionalPendingIdentity;
  if (
    identity &&
    (posthog.get_distinct_id() !== identity.distinctId ||
      posthog.get_session_id() !== identity.sessionId)
  ) {
    nativeOptionalOrigin = null;
    nativeOptionalIdentity = null;
    nativeOptionalPendingIdentity = null;
    nativeOptionalOriginEpoch += 1;
    nativeWorkflowIdentityNeedsSync = true;
  }
  return isAnalyticsCaptureReady() && nativeOptionalOrigin ? { ...nativeOptionalOrigin } : null;
}

export function isAnalyticsIdentityIdentified(): boolean {
  if (!isAnalyticsCaptureReady()) return false;
  const auth = getDesktopAuthSnapshot();
  if (!auth.hydrated || auth.state.status !== 'signed-in') return false;
  const accountId = auth.state.session.accountId;
  return UUID_RE.test(accountId) && posthog.get_distinct_id() === accountId;
}

export function getAnalyticsIdentifiedAccountId(): string | null {
  if (!isAnalyticsIdentityIdentified()) return null;
  const state = getDesktopAuthSnapshot().state;
  return state.status === 'signed-in' ? state.session.accountId : null;
}

export type { MeaningfulActivityActorKind, MeaningfulActivityExecutionMode };

export function getMeaningfulActivityAuthority(): {
  actorKind: MeaningfulActivityActorKind;
  executionMode: MeaningfulActivityExecutionMode;
  impersonated: boolean;
} {
  return meaningfulActivityAuthority;
}

export function subscribeAnalyticsCaptureReady(callback: () => void): () => void {
  readinessSubscribers.add(callback);
  return () => readinessSubscribers.delete(callback);
}

export const ORG_AUTH_DESKTOP_SIGNIN_FLAG = 'org_auth_desktop_signin';

export const WORKSPACE_CLOUD_SYNC_FLAG = 'workspace_cloud_sync';

export function isDesktopSignInFeatureEnabled(): boolean {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') return true;
  if (import.meta.env.VITE_ENABLE_DESKTOP_SIGNIN === 'false') return false;
  if (import.meta.env.VITE_ENABLE_DESKTOP_SIGNIN === 'true') return true;
  return true;
}

export function isWorkspaceCloudSyncFeatureEnabled(): boolean {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') return true;

  if (import.meta.env.VITE_ENABLE_WORKSPACE_CLOUD_SYNC === 'false') return false;
  if (import.meta.env.VITE_ENABLE_WORKSPACE_CLOUD_SYNC === 'true') return true;

  return true;
}

export function onFeatureFlagsReady(cb: () => void): () => void {
  if (!initialized) return () => {};
  return posthog.onFeatureFlags(() => cb());
}

export async function hasTelemetryDestination(): Promise<boolean> {
  if (import.meta.env.VITE_SENTRY_DSN || import.meta.env.VITE_POSTHOG_API_KEY) return true;
  const analyticsBridge = electronApi()?.analytics;
  if (!analyticsBridge?.getRuntimeConfig) return false;
  try {
    return (await analyticsBridge.getRuntimeConfig()) !== null;
  } catch {
    return true;
  }
}

async function resolveRendererRuntimeConfig(): Promise<AnalyticsRuntimeConfig | null> {
  const analyticsBridge = electronApi()?.analytics;
  if (analyticsBridge?.getRuntimeConfig) {
    try {
      return await analyticsBridge.getRuntimeConfig();
    } catch {
      return null;
    }
  }

  const apiKey = import.meta.env.VITE_POSTHOG_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
    appVersion: typeof __APP_VERSION__ === 'undefined' ? '0.0.0' : __APP_VERSION__,
    platformFamily: getRendererPlatformFamily(),
    environment:
      import.meta.env.MODE === 'test' ? 'test' : import.meta.env.DEV ? 'development' : 'production',
    releaseChannel: import.meta.env.VITE_RELEASE_CHANNEL || 'unknown',
    isSynthetic: false,
    telemetryActor: import.meta.env.DEV || import.meta.env.MODE === 'test' ? 'dev' : 'user',
  };
}

export async function groupAnalyticsByOrganization(accountId: string): Promise<void> {
  try {
    const listed = await electronApi()?.cloudSync?.listOrganizations?.();
    if (!listed?.ok || posthog.get_distinct_id() !== accountId) return;
    const organizationId = analyticsOrganizationId(listed.organizations);
    if (organizationId) posthog.group(ANALYTICS_ORGANIZATION_GROUP, organizationId);
    else if (Object.keys(posthog.getGroups()).length > 0) posthog.resetGroups();
  } catch {}
}

function createIdentityCoordinator(): RendererAnalyticsIdentityCoordinator | null {
  const syncContext = electronApi()?.analytics?.syncContext;
  if (!syncContext) return null;
  const diagnostics = ownedPreidentityDiagnostics();
  return new RendererAnalyticsIdentityCoordinator({
    onTransitionStarted: (generation) => {
      nativeOptionalOriginEpoch += 1;
      nativeOptionalOrigin = null;
      nativeOptionalIdentity = null;
      nativeOptionalPendingIdentity = null;
      diagnostics?.transitionStarted(generation);
    },
    sdk: {
      getDistinctId: () => posthog.get_distinct_id(),
      getSessionId: () => posthog.get_session_id(),
      identify: (accountId, traits) => posthog.identify(accountId, traits),
      reset: (resetDeviceId) => {
        setIdentityReady(false);
        posthog.reset(resetDeviceId);
      },
      optIn: () => posthog.opt_in_capturing({ captureEventName: false }),
    },
    syncContext: async (context) => {
      const originEpoch = nativeOptionalOriginEpoch;
      nativeOptionalPendingIdentity = {
        distinctId: context.distinctId,
        sessionId: context.sessionId,
      };
      const gate = diagnostics?.publicationGate();
      const nativeResult = await syncContext(context);
      const result = gate ? await gate(nativeResult) : nativeResult;
      if (
        originEpoch === nativeOptionalOriginEpoch &&
        analyticsConsentState === 'on' &&
        posthog.get_distinct_id() === context.distinctId &&
        posthog.get_session_id() === context.sessionId
      ) {
        const origin = result.optionalOrigin;
        nativeOptionalOrigin =
          result.accepted &&
          origin &&
          [origin.consentScope, origin.contextId, origin.processId].every((id) =>
            UUID_RE.test(id)
          ) &&
          ['synthetic', 'private', 'unknown', 'eligible_release'].includes(origin.classification)
            ? Object.freeze({ ...origin })
            : null;
        nativeOptionalIdentity = nativeOptionalOrigin ? { ...context } : null;
      }
      if (originEpoch === nativeOptionalOriginEpoch) nativeOptionalPendingIdentity = null;
      meaningfulActivityAuthority = result.authority ?? UNKNOWN_MEANINGFUL_ACTIVITY_AUTHORITY;
      return result;
    },
    isConsentEnabled: () => analyticsConsentState === 'on',
    initialAccountId: readStoredAccountId(),
    onAccountIdentified: (accountId) => {
      storeAccountId(accountId);
      void groupAnalyticsByOrganization(accountId);
    },
    onIdentityCleared: clearStoredAccountId,
  });
}

async function applyIdentityState(state: DesktopAuthState): Promise<boolean> {
  try {
    return (await identityCoordinator?.applyAuthState(state)) ?? false;
  } catch (error) {
    if (error instanceof PreidentityDiagnosticCancelled) return false;
    throw error;
  }
}

async function startIdentitySync(): Promise<void> {
  if (!identityCoordinator) return;
  scheduleIdentityFallback();
  const applyCurrent = async (): Promise<void> => {
    const auth = getDesktopAuthSnapshot();
    if (!auth.hydrated) return;
    setIdentityReady(false);
    const accepted = await applyIdentityState(auth.state);
    if (accepted && analyticsConsentState === 'on') setIdentityReady(true);
  };

  if (!unsubscribeAuthStore) {
    unsubscribeAuthStore = subscribeDesktopAuthSnapshot((state, previous) => {
      if (state.hydrated !== previous.hydrated || state.state !== previous.state) {
        void applyCurrent();
      }
    });
  }
  await applyCurrent();
}

function setIdentityReady(ready: boolean): void {
  if (!ready) {
    nativeWorkflowIdentityNeedsSync = false;
    nativeOptionalOrigin = null;
    nativeOptionalIdentity = null;
    nativeOptionalPendingIdentity = null;
    nativeOptionalOriginEpoch += 1;
  }
  if (identityReady === ready) return;
  identityReady = ready;
  analyticsCaptureGeneration += 1;
  if (ready) clearIdentityFallback();
  if (ready) flushPendingPreIdentityEvents();
  for (const callback of readinessSubscribers) callback();
}

function scheduleIdentityFallback(): void {
  if (identityFallbackHandle !== undefined) return;
  identityFallbackHandle = setTimeout(() => {
    identityFallbackHandle = undefined;
    if (analyticsConsentState !== 'on' || identityReady || !identityCoordinator) return;
    const auth = getDesktopAuthSnapshot();
    if (auth.hydrated && auth.state.status === 'signed-in') {
      void applyIdentityState(auth.state).then((accepted) => {
        if (accepted && analyticsConsentState === 'on') setIdentityReady(true);
        else scheduleIdentityFallback();
      });
      return;
    }
    void applyIdentityState({ status: 'signed-out' }).then((accepted) => {
      if (accepted && analyticsConsentState === 'on') setIdentityReady(true);
    });
  }, 5_000);
}

function clearIdentityFallback(): void {
  if (identityFallbackHandle === undefined) return;
  clearTimeout(identityFallbackHandle);
  identityFallbackHandle = undefined;
}

function readStoredAccountId(): string | null {
  try {
    const value = localStorage.getItem(DESKTOP_IDENTIFIED_ACCOUNT_KEY);
    return UUID_RE.test(value ?? '') ? value : null;
  } catch {
    return null;
  }
}

function storeAccountId(accountId: string): void {
  try {
    localStorage.setItem(DESKTOP_IDENTIFIED_ACCOUNT_KEY, accountId);
  } catch {}
}

function clearStoredAccountId(): void {
  try {
    localStorage.removeItem(DESKTOP_IDENTIFIED_ACCOUNT_KEY);
  } catch {}
}

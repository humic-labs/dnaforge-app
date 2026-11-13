import {
  publishWorkspaceSyncRestoreTelemetry,
  purgeWorkspaceSyncRestoreTelemetry,
} from './workspace-sync-restore-telemetry';
import { createHash, randomUUID } from 'node:crypto';
import type { FeedbackReceipt, FeedbackTelemetryOrigin } from '../shared/feedback';
import { clearFeedbackTelemetryOrigins } from './feedback-queue';
import { APP_BUILD } from '../lib/app-build';
import {
  TABLE_NOTEBOOK_RECEIPT_PREFIX,
  isTableOperationObservation,
  tableObservationProperties,
  type TableNotebookReceiptMutation,
} from '../shared/table-notebook-observation';
import { handleGroup, mainIpc } from '../shared/ipc-contract';
import { analyticsContract } from '../shared/ipc/analytics.contract';
import { failLoudlyOnTelemetryContractViolation } from '../shared/telemetry-contract-violation';
import { PostHog, type PostHogOptions } from 'posthog-node';
import type Database from 'better-sqlite3';
import { app } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANALYTICS_CONSENT_VERSION,
  ANALYTICS_ORGANIZATION_GROUP,
  acceptIdentityContext,
  classifyInternalOperator,
  sanitizePostHogSdkEvent,
  type AnalyticsConsentBasis,
  type AnalyticsIdentityContext,
} from '@waypoint/analytics-policy';
import {
  isAllowedClosedBetaEvent,
  sanitizeClosedBetaProperties,
  type ClosedBetaEvent,
} from '../shared/analytics-allowlist';
import type {
  AnalyticsConsentState,
  AnalyticsIdentitySyncResult,
  AnalyticsRuntimeConfig,
  MeaningfulActivityAuthority,
  RendererWorkflowTelemetryRequest,
} from '../shared/analytics-types';
import type { DesktopAuthState } from '../shared/auth-types';
import { isWorkspaceSyncReceiptEvent } from '../shared/workspace-sync-telemetry';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../shared/analytics-registry.generated';
import {
  betaAttributionAnalyticsProperties,
  BETA_ATTRIBUTION_SETTING_KEY,
  parseBetaAttributionSetting,
} from '../shared/beta-attribution';
import { getAnalyticsConsentStateFromDb, getDb } from './ipc/database';
import {
  MainAnalyticsContextQueue,
  type MainAnalyticsQueuedEvent,
} from './analytics-context-queue';
import {
  ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
  drainAnalyticsOutbox,
  getAnalyticsOutboxEvent,
  putOriginBoundAnalyticsOutboxEvent,
  type AnalyticsOutboxAuthority,
  type AnalyticsOutboxEvent,
  type AnalyticsOutboxInput,
  type CommittedOptionalAnalyticsReceipt,
  type OptionalTelemetryOrigin,
} from './analytics-outbox';
import { captureAndConfirmAnalyticsBatch } from './analytics-outbox-sdk';
export type { OptionalTelemetryOrigin } from './analytics-outbox';
import {
  isTelemetryEgressSuppressed,
  resolveTelemetryRuntimeDimensions,
  telemetryRuntimeProperties,
} from './telemetry-runtime';
import { recordTelemetryConsentState, resolveDesktopConsentPolicy } from './telemetry-consent';
import {
  publishWorkspaceSyncUploadTelemetry,
  purgeWorkspaceSyncUploadTelemetry,
} from './workspace-sync-upload-telemetry';
import {
  publishWorkspaceSyncRecoveryTelemetry,
  purgeWorkspaceSyncRecoveryTelemetry,
} from './workspace-sync-recovery-telemetry';
import {
  publishWorkspaceSyncEnablementTelemetry,
  purgeWorkspaceSyncEnablementTelemetry,
} from './workspace-sync-enablement-telemetry';

let client: PostHog | null = null;
let normalShutdownClient: PostHog | null = null;
let runtimeConfig: AnalyticsRuntimeConfig | null = null;
let analyticsEnabled = false;
let mainExceptionCount = 0;
const capturedMainExceptions = new WeakSet<object>();
let analyticsOrganization: string | null = null;
const identifiedOrganizationGroups = new Set<string>();
let appSessionStartedAtMs: number | null = null;
let retainedAnalyticsConfig: Record<string, string> | undefined;
let outboxDrainPromise: Promise<void> | null = null;
let outboxDrainRequested = false;

const FEEDBACK_CONSENT_SCOPE = 'feedback_telemetry_consent_scope';
const FEEDBACK_PROCESS_ID = randomUUID();
const OPTIONAL_CONTEXT_KEY = 'analytics_optional_context_v1';
let publisherEpoch = 0;
let mayResumePersistedContext = true;
interface AcceptedOptionalContext {
  consentScope: string;
  contextId: string;
  identity: AnalyticsIdentityContext;
  liveIdentity: AnalyticsIdentityContext;
  classification: OptionalTelemetryOrigin['classification'];
  runtimeProperties: Readonly<Record<string, string | number | boolean>>;
}
let acceptedOptionalContext: AcceptedOptionalContext | null = null;
const FEEDBACK_SCOPE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APPROVED_POSTHOG_INGEST_ORIGINS = new Set([
  'https://us.i.posthog.com',
  'https://eu.i.posthog.com',
]);
const CANARY_PROXY_TOKEN_RE = /^[a-f0-9]{64}$/;
const CANARY_PROXY_TOKEN_HEADER = 'X-DNAForge-Canary-Token';

const contextQueue = new MainAnalyticsContextQueue({ emit: emitWithContext });

function defaultProperties(): Record<string, unknown> {
  const operator =
    runtimeConfig?.telemetryActor === 'maintainer'
      ? classifyInternalOperator(process.env.DNAFORGE_INTERNAL_OPERATOR)
      : undefined;
  return {
    ...(runtimeConfig ? telemetryRuntimeProperties(runtimeConfig) : {}),
    ...readBetaAttributionProperties(),
    ...(operator ? { internal_operator: operator } : {}),
  };
}

function readBetaAttributionProperties(): Record<string, unknown> {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(BETA_ATTRIBUTION_SETTING_KEY) as { value: string } | undefined;
    return betaAttributionAnalyticsProperties(parseBetaAttributionSetting(row?.value));
  } catch {
    return {};
  }
}

export function resolvePostHogRuntimeConfig(
  config?: Record<string, string>
): AnalyticsRuntimeConfig | null {
  if (app.isPackaged && isTelemetryEgressSuppressed(config)) {
    console.warn('[analytics] Telemetry egress suppressed for this packaged test launch.');
    return null;
  }
  const bakedKey = typeof __POSTHOG_API_KEY__ !== 'undefined' ? __POSTHOG_API_KEY__ : '';
  const runtimeKey = config?.POSTHOG_API_KEY || process.env.POSTHOG_API_KEY || '';
  const runtimeHost = config?.POSTHOG_HOST || process.env.POSTHOG_HOST || '';
  const runtimeOverrideRequested = Boolean(runtimeKey || runtimeHost);
  const runtimeAuthority = resolveRuntimePostHogAuthority(runtimeKey, runtimeHost);
  if (runtimeOverrideRequested && !runtimeAuthority) return null;
  const apiKey = runtimeAuthority?.apiKey || bakedKey;
  if (!isPublicPostHogKey(apiKey)) return null;

  const bakedHost = typeof __POSTHOG_HOST__ !== 'undefined' ? __POSTHOG_HOST__ : '';
  const rawHost = runtimeAuthority?.host || bakedHost || 'https://us.i.posthog.com';
  try {
    const host = new URL(rawHost);
    if (!isApprovedPostHogIngestOrigin(host.origin, runtimeAuthority !== null)) return null;
    const dimensions = resolveTelemetryRuntimeDimensions(config, undefined, {
      allowRuntimeCanary: !app.isPackaged || runtimeAuthority?.isLoopback === true,
    });
    const rawProxyToken =
      config?.DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN ||
      process.env.DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN ||
      '';
    const canaryProxyToken =
      runtimeAuthority?.isLoopback === true && CANARY_PROXY_TOKEN_RE.test(rawProxyToken)
        ? rawProxyToken
        : undefined;
    if (app.isPackaged && dimensions.isSynthetic && !canaryProxyToken) {
      console.warn('[analytics] Packaged telemetry canary is missing loopback proxy authority.');
      return null;
    }
    return {
      apiKey,
      host: host.origin,
      ...dimensions,
      ...(canaryProxyToken ? { canaryProxyToken } : {}),
    };
  } catch {
    return null;
  }
}

function resolveRuntimePostHogAuthority(
  apiKey: string,
  rawHost: string
): { apiKey: string; host: string; isLoopback: boolean } | null {
  if (!isPublicPostHogKey(apiKey)) return null;
  try {
    const host = new URL(rawHost || 'https://us.i.posthog.com');
    const loopback = isLoopbackOrigin(host);
    if (!isApprovedPostHogIngestOrigin(host.origin, true)) {
      console.warn(`[analytics] Ignoring unapproved runtime PostHog origin: ${host.origin}`);
      return null;
    }
    if (app.isPackaged && !loopback) {
      console.warn('[analytics] Ignoring packaged PostHog override outside the loopback boundary.');
      return null;
    }
    return { apiKey, host: host.origin, isLoopback: loopback };
  } catch {
    console.warn('[analytics] Ignoring malformed runtime PostHog host.');
    return null;
  }
}

function isApprovedPostHogIngestOrigin(origin: string, allowLoopback: boolean): boolean {
  if (APPROVED_POSTHOG_INGEST_ORIGINS.has(origin)) return true;
  if (!allowLoopback) return false;
  try {
    return isLoopbackOrigin(new URL(origin));
  } catch {
    return false;
  }
}

function isLoopbackOrigin(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  );
}

export function initAnalyticsMain(
  config?: Record<string, string>,
  consentState: AnalyticsConsentState = { consent: null, version: null, basis: null }
): void {
  retainedAnalyticsConfig = retainAnalyticsConfig(config);
  recordTelemetryConsentState(consentState);
  const decision = resolveDesktopConsentPolicy(consentState);
  if (!decision.enabled) {
    runtimeConfig = null;
    setMainAnalyticsConsent(false);
    return;
  }

  runtimeConfig = resolvePostHogRuntimeConfig(retainedAnalyticsConfig);
  if (!runtimeConfig) {
    setMainAnalyticsConsent(false);
    return;
  }

  startClient();
  analyticsEnabled = client !== null;
  contextQueue.setConsent(analyticsEnabled);
}

const UNKNOWN_MEANINGFUL_AUTHORITY: MeaningfulActivityAuthority = {
  actorKind: 'unknown',
  executionMode: 'interactive',
  impersonated: false,
};

export function resolveMeaningfulActivityAuthority(
  context: AnalyticsIdentityContext,
  authState: DesktopAuthState
): MeaningfulActivityAuthority {
  const actor = runtimeConfig?.telemetryActor;
  if (runtimeConfig?.isSynthetic || actor === 'canary') {
    return { actorKind: 'test', executionMode: 'synthetic', impersonated: false };
  }
  if (
    context.kind !== 'identified' ||
    authState.status !== 'signed-in' ||
    authState.session.accountId !== context.distinctId
  ) {
    return UNKNOWN_MEANINGFUL_AUTHORITY;
  }
  return authState.session.meaningfulActivityAuthority ?? UNKNOWN_MEANINGFUL_AUTHORITY;
}

export function registerAnalyticsHandlers(
  readAuthState: () => DesktopAuthState = () => ({ status: 'signed-out' }),
  onContextAccepted: () => void = () => {}
): void {
  handleGroup(analyticsContract, {
    getConsentPolicy: () => resolveDesktopConsentPolicy(getAnalyticsConsentStateFromDb()),
    writeTableNotebookReceipt: (_event, request) => mutateTableNotebookReceipt(request),
    enqueueWorkflowEvent: (_event, request) => enqueueRendererWorkflowEvent(request),
    getRuntimeConfig: () => runtimeConfig,
    getOptIn: () => analyticsEnabled,
    persistConsent: (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') throw new Error('Invalid analytics consent value');
      persistAnalyticsConsent(enabled);
    },
    grantConsent: async (_event, options: unknown) => {
      const explicit =
        typeof options === 'object' &&
        options !== null &&
        (options as { basis?: unknown }).basis === 'explicit';
      return grantMainAnalyticsConsent(explicit ? 'explicit' : 'default');
    },
    revokeConsent: async () => {
      await revokeMainAnalyticsConsent();
    },
    syncContext: (_event, context: AnalyticsIdentityContext) => {
      const accepted = syncAnalyticsIdentityContext(context);
      if (accepted) {
        try {
          onContextAccepted();
          recoverTableNotebookTelemetry();
        } catch {
          console.warn('[analytics] committed receipt recovery unavailable');
        }
      }
      return {
        accepted,
        optionalOrigin: accepted ? captureOptionalTelemetryOrigin() : null,
        authority: accepted
          ? resolveMeaningfulActivityAuthority(context, readAuthState())
          : UNKNOWN_MEANINGFUL_AUTHORITY,
      } satisfies AnalyticsIdentitySyncResult;
    },
    setConsent: async (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') return;
      await setMainAnalyticsConsentWithinPolicy(enabled);
    },
  });

  mainIpc.handle('analytics:setOptIn', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    await setMainAnalyticsConsentWithinPolicy(enabled);
  });
}

async function setMainAnalyticsConsentWithinPolicy(enabled: boolean): Promise<void> {
  if (enabled && !resolveDesktopConsentPolicy(getAnalyticsConsentStateFromDb()).enabled) {
    await setMainAnalyticsConsent(false);
    return;
  }
  await setMainAnalyticsConsent(enabled);
}

export function persistAnalyticsConsent(
  enabled: boolean,
  basis: AnalyticsConsentBasis = 'default'
): void {
  let committedBasis = basis;
  if (!enabled) {
    const retiring = closeMainAnalyticsGate();
    if (retiring)
      void discardQueuedAndShutdown(retiring).catch(() => {
        console.warn('[analytics] retired optional client shutdown unavailable');
      });
  }
  const database = getDb();
  database.transaction(() => {
    if (enabled) {
      const read = database.prepare('SELECT value, updated_at FROM settings WHERE key = ?');
      const consent = read.get('analytics_consent') as
        | { value: string; updated_at: number }
        | undefined;
      const version = read.get('analytics_consent_version') as { value: string } | undefined;
      const storedBasis = (read.get('analytics_consent_basis') as { value: string } | undefined)
        ?.value;
      if (
        consent?.value === 'true' &&
        version?.value === ANALYTICS_CONSENT_VERSION &&
        Number.isSafeInteger(consent.updated_at) &&
        consent.updated_at >= 0
      ) {
        committedBasis =
          storedBasis === 'explicit' || basis === 'explicit' ? 'explicit' : 'default';
        if (storedBasis !== committedBasis) {
          database
            .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
            .run('analytics_consent_basis', committedBasis, Date.now());
        }
        return;
      }
    }
    const statement = database.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
    );
    const updatedAt = Date.now();
    statement.run('analytics_consent', String(enabled), updatedAt);
    statement.run('analytics_consent_version', ANALYTICS_CONSENT_VERSION, updatedAt);
    statement.run('analytics_consent_basis', committedBasis, updatedAt);
    if (!enabled) {
      statement.run(FEEDBACK_CONSENT_SCOPE, randomUUID(), updatedAt);
      database.prepare('DELETE FROM settings WHERE key = ?').run(OPTIONAL_CONTEXT_KEY);

      database
        .prepare('DELETE FROM settings WHERE substr(key, 1, ?) = ?')
        .run(TABLE_NOTEBOOK_RECEIPT_PREFIX.length, TABLE_NOTEBOOK_RECEIPT_PREFIX);
      const cloudReceiptPrefix = '_cloud_backup_telemetry_receipt_v1:';
      purgeWorkspaceSyncUploadTelemetry(database);
      purgeWorkspaceSyncRecoveryTelemetry(database);
      purgeWorkspaceSyncEnablementTelemetry(database);
      purgeWorkspaceSyncRestoreTelemetry(database);
      database
        .prepare('DELETE FROM settings WHERE substr(key,1,?) = ?')
        .run(cloudReceiptPrefix.length, cloudReceiptPrefix);
      const updaterReceiptPrefix = '_update_install_telemetry_receipt_v1:';
      database
        .prepare('DELETE FROM settings WHERE substr(key,1,?) = ?')
        .run(updaterReceiptPrefix.length, updaterReceiptPrefix);
      for (const table of ['meaningful_activity_pending', 'analytics_event_outbox']) {
        try {
          database.prepare(`DELETE FROM ${table}`).run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes(`no such table: ${table}`)) throw error;
        }
      }
    }
  })();
  recordTelemetryConsentState({
    consent: String(enabled),
    version: ANALYTICS_CONSENT_VERSION,
    basis: committedBasis,
  });
  if (!enabled) {
    try {
      clearFeedbackTelemetryOrigins(app.getPath('userData'));
    } catch (ignoredError) {
      void ignoredError;
    }
  }
}

function sameIdentity(a: AnalyticsIdentityContext, b: AnalyticsIdentityContext): boolean {
  return (
    a.distinctId === b.distinctId &&
    a.sessionId === b.sessionId &&
    a.kind === b.kind &&
    a.generation === b.generation &&
    a.rendererInstanceId === b.rendererInstanceId
  );
}

function sameCanonicalIdentity(a: AnalyticsIdentityContext, b: AnalyticsIdentityContext): boolean {
  return a.distinctId === b.distinctId && a.sessionId === b.sessionId && a.kind === b.kind;
}

function sameRendererIdentity(a: AnalyticsIdentityContext, b: AnalyticsIdentityContext): boolean {
  return (
    a.rendererInstanceId !== undefined &&
    a.rendererInstanceId === b.rendererInstanceId &&
    sameCanonicalIdentity(a, b)
  );
}

function copyIdentity(value: AnalyticsIdentityContext): AnalyticsIdentityContext {
  return Object.freeze({
    distinctId: value.distinctId,
    sessionId: value.sessionId,
    kind: value.kind,
    generation: value.generation,
    ...(value.rendererInstanceId ? { rendererInstanceId: value.rendererInstanceId } : {}),
  });
}

function originalRuntimeProperties(): Readonly<Record<string, string | number | boolean>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(sanitizeClosedBetaProperties({}, defaultProperties())).filter(([, value]) =>
        ['string', 'number', 'boolean'].includes(typeof value)
      )
    ) as Record<string, string | number | boolean>
  );
}

function sameProperties(a: object, b: object): boolean {
  const sorted = (value: object) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)))
    );
  return sorted(a) === sorted(b);
}

function optionalClassification(): OptionalTelemetryOrigin['classification'] {
  return runtimeConfig?.isSynthetic ||
    ['canary', 'ci'].includes(runtimeConfig?.telemetryActor ?? '')
    ? 'synthetic'
    : runtimeConfig?.telemetryActor === 'maintainer' ||
        ['local', 'development', 'test'].includes(APP_BUILD.kind)
      ? 'private'
      : APP_BUILD.kind === 'release' &&
          runtimeConfig?.environment === 'production' &&
          runtimeConfig.telemetryActor === 'user'
        ? 'eligible_release'
        : 'unknown';
}

function bindAcceptedOptionalContext(identity: AnalyticsIdentityContext): void {
  const live = acceptedOptionalContext;
  acceptedOptionalContext = null;
  try {
    const db = getDb();
    acceptedOptionalContext = db.transaction(() => {
      const get = (key: string) =>
        (
          db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined
        )?.value;
      if (
        get('analytics_consent') !== 'true' ||
        get('analytics_consent_version') !== ANALYTICS_CONSENT_VERSION
      )
        return null;
      let consentScope = get(FEEDBACK_CONSENT_SCOPE);
      if (!consentScope || !FEEDBACK_SCOPE_RE.test(consentScope)) consentScope = randomUUID();
      const raw = get(OPTIONAL_CONTEXT_KEY);
      const previous = raw ? (JSON.parse(raw) as AcceptedOptionalContext) : null;
      const classification = optionalClassification();
      const runtimeProperties = originalRuntimeProperties();
      const canReuse = mayResumePersistedContext || (live !== null && raw === JSON.stringify(live));
      const resume =
        canReuse &&
        previous &&
        previous.consentScope === consentScope &&
        FEEDBACK_SCOPE_RE.test(previous.contextId) &&
        acceptIdentityContext(null, previous.identity) !== null &&
        (mayResumePersistedContext
          ? sameCanonicalIdentity(previous.identity, identity)
          : sameIdentity(previous.liveIdentity, identity) ||
            sameRendererIdentity(previous.liveIdentity, identity)) &&
        previous.classification === classification &&
        sameProperties(previous.runtimeProperties, runtimeProperties);
      if (previous && !resume) {
        purgeWorkspaceSyncUploadTelemetry(db);
        purgeWorkspaceSyncRecoveryTelemetry(db);
        purgeWorkspaceSyncEnablementTelemetry(db);
        purgeWorkspaceSyncRestoreTelemetry(db);
      }
      const value: AcceptedOptionalContext = {
        consentScope,
        contextId: resume ? previous.contextId : randomUUID(),
        identity: copyIdentity(resume ? previous.identity : identity),
        liveIdentity: copyIdentity(identity),
        classification,
        runtimeProperties: Object.freeze(
          resume ? { ...previous.runtimeProperties } : runtimeProperties
        ),
      };
      const write = db.prepare(
        'INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)'
      );
      write.run(FEEDBACK_CONSENT_SCOPE, consentScope, Date.now());
      write.run(OPTIONAL_CONTEXT_KEY, JSON.stringify(value), Date.now());
      return Object.freeze(value);
    })();
  } catch {
    acceptedOptionalContext = null;
  }
  mayResumePersistedContext = false;
}

function currentOptionalContext(): AcceptedOptionalContext | null {
  if (!analyticsEnabled || !client || !runtimeConfig || !acceptedOptionalContext) return null;
  try {
    const current = contextQueue.currentContext();
    const get = (key: string) =>
      (
        getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
          | { value: string }
          | undefined
      )?.value;
    if (
      !current ||
      !sameIdentity(current, acceptedOptionalContext.liveIdentity) ||
      get('analytics_consent') !== 'true' ||
      get('analytics_consent_version') !== ANALYTICS_CONSENT_VERSION ||
      get(FEEDBACK_CONSENT_SCOPE) !== acceptedOptionalContext.consentScope ||
      get(OPTIONAL_CONTEXT_KEY) !== JSON.stringify(acceptedOptionalContext) ||
      optionalClassification() !== acceptedOptionalContext.classification
    )
      return null;
    return acceptedOptionalContext;
  } catch {
    return null;
  }
}

export function captureOptionalTelemetryOrigin(
  expectedAccountId?: string
): OptionalTelemetryOrigin | null {
  const accepted = currentOptionalContext();
  const accountMatches =
    expectedAccountId === undefined ||
    (accepted?.identity.kind === 'identified' &&
      accepted.identity.distinctId === expectedAccountId &&
      accepted.liveIdentity.kind === 'identified' &&
      accepted.liveIdentity.distinctId === expectedAccountId);
  return accepted && accountMatches
    ? Object.freeze({
        consentScope: accepted.consentScope,
        contextId: accepted.contextId,
        processId: FEEDBACK_PROCESS_ID,
        classification: accepted.classification,
      })
    : null;
}

export function mutateTableNotebookReceipt(request: TableNotebookReceiptMutation): boolean {
  try {
    if (
      !request ||
      typeof request.key !== 'string' ||
      request.key.length > 32768 ||
      !request.key.startsWith(TABLE_NOTEBOOK_RECEIPT_PREFIX) ||
      (request.expectedValue !== null && typeof request.expectedValue !== 'string')
    )
      return false;
    const db = getDb();
    return db.transaction(() => {
      const previous =
        (
          db.prepare('SELECT value FROM settings WHERE key = ?').get(request.key) as
            | { value: string }
            | undefined
        )?.value ?? null;
      if (previous !== request.expectedValue) return false;
      if (request.kind === 'retire') {
        if (previous === null) return false;
        return (
          db.prepare('DELETE FROM settings WHERE key = ? AND value = ?').run(request.key, previous)
            .changes === 1
        );
      }
      if (
        request.kind !== 'write' ||
        typeof request.value !== 'string' ||
        request.value.length > 16384 ||
        !Number.isSafeInteger(request.updatedAtMs) ||
        request.updatedAtMs < 0 ||
        !request.origin ||
        !originCurrentlyAdmissible(request.origin)
      )
        return false;
      const next = JSON.parse(request.value) as Record<string, unknown>;
      const allowed = new Set([
        'version',
        'phase',
        'operationId',
        'revisionId',
        'acceptedAtMs',
        'observation',
        'origin',
        'path',
        'authorityFingerprint',
        'committedAtMs',
        'committedEventId',
        'reopenedAtMs',
        'reopenedEventId',
        'readbackMatch',
        'appSessionId',
        'episodeCorrelationId',
      ]);
      if (
        !next ||
        typeof next !== 'object' ||
        Object.keys(next).some((key) => !allowed.has(key)) ||
        next.version !== 1 ||
        !['accepted', 'committed', 'reopened'].includes(String(next.phase)) ||
        typeof next.operationId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(next.operationId) ||
        typeof next.revisionId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(next.revisionId) ||
        typeof next.appSessionId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(next.appSessionId) ||
        typeof next.episodeCorrelationId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(next.episodeCorrelationId) ||
        !Number.isSafeInteger(next.acceptedAtMs) ||
        (next.acceptedAtMs as number) < 0 ||
        !next.origin ||
        !originCurrentlyAdmissible(next.origin as OptionalTelemetryOrigin) ||
        (next.observation !== undefined && !isTableOperationObservation(next.observation))
      )
        return false;
      const origin = next.origin as OptionalTelemetryOrigin;
      if (
        Object.keys(origin).some(
          (key) => !['consentScope', 'contextId', 'processId', 'classification'].includes(key)
        )
      )
        return false;
      if (next.phase === 'accepted') {
        if (
          origin.processId !== request.origin.processId ||
          next.path !== undefined ||
          next.authorityFingerprint !== undefined ||
          next.committedAtMs !== undefined ||
          next.committedEventId !== undefined ||
          next.reopenedAtMs !== undefined ||
          next.reopenedEventId !== undefined ||
          next.readbackMatch !== undefined
        )
          return false;
      } else {
        if (
          !previous ||
          typeof next.path !== 'string' ||
          !next.path ||
          next.path.length > 8192 ||
          typeof next.authorityFingerprint !== 'string' ||
          !next.authorityFingerprint ||
          next.authorityFingerprint.length > 256 ||
          typeof next.committedEventId !== 'string' ||
          !FEEDBACK_SCOPE_RE.test(next.committedEventId) ||
          !Number.isSafeInteger(next.committedAtMs) ||
          (next.committedAtMs as number) < (next.acceptedAtMs as number)
        )
          return false;
        const prior = JSON.parse(previous) as Record<string, unknown>;
        if (
          JSON.stringify(prior.observation) !== JSON.stringify(next.observation) ||
          prior.operationId !== next.operationId ||
          prior.revisionId !== next.revisionId ||
          prior.acceptedAtMs !== next.acceptedAtMs ||
          JSON.stringify(prior.origin) !== JSON.stringify(next.origin) ||
          prior.appSessionId !== next.appSessionId ||
          prior.episodeCorrelationId !== next.episodeCorrelationId ||
          (next.phase === 'committed' && prior.phase !== 'accepted') ||
          (next.phase === 'reopened' &&
            (prior.phase !== 'committed' ||
              prior.path !== next.path ||
              prior.authorityFingerprint !== next.authorityFingerprint ||
              prior.committedAtMs !== next.committedAtMs ||
              prior.committedEventId !== next.committedEventId ||
              typeof next.readbackMatch !== 'boolean' ||
              typeof next.reopenedEventId !== 'string' ||
              !FEEDBACK_SCOPE_RE.test(next.reopenedEventId) ||
              !Number.isSafeInteger(next.reopenedAtMs) ||
              (next.reopenedAtMs as number) < (next.committedAtMs as number)))
        )
          return false;
        if (
          next.phase === 'committed' &&
          (next.reopenedEventId !== undefined ||
            next.reopenedAtMs !== undefined ||
            next.readbackMatch !== undefined)
        )
          return false;
      }
      db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        request.key,
        request.value,
        request.updatedAtMs
      );
      db.prepare('DELETE FROM settings WHERE substr(key, 1, ?) = ? AND updated_at < ?').run(
        TABLE_NOTEBOOK_RECEIPT_PREFIX.length,
        TABLE_NOTEBOOK_RECEIPT_PREFIX,
        Date.now() - 86_400_000
      );
      db.prepare(
        'DELETE FROM settings WHERE key IN (SELECT key FROM settings WHERE substr(key, 1, ?) = ? ORDER BY updated_at DESC, key DESC LIMIT -1 OFFSET 256)'
      ).run(TABLE_NOTEBOOK_RECEIPT_PREFIX.length, TABLE_NOTEBOOK_RECEIPT_PREFIX);
      const present =
        (
          db.prepare('SELECT value FROM settings WHERE key = ?').get(request.key) as
            | { value: string }
            | undefined
        )?.value === request.value;
      if (present && next.phase !== 'accepted') publishTableNotebookReceipt(request.key);
      return present;
    })();
  } catch {
    return false;
  }
}

function publishTableNotebookReceipt(key: string): void {
  for (const stage of ['committed', 'reopened'] as const) {
    enqueueOptionalAnalyticsEventFromReceipt(() => {
      const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) return null;
      const receipt = JSON.parse(row.value) as Record<string, unknown>;
      if (
        receipt.version !== 1 ||
        !['committed', 'reopened'].includes(String(receipt.phase)) ||
        (stage === 'reopened' && receipt.phase !== 'reopened')
      )
        return null;
      const id = stage === 'committed' ? receipt.committedEventId : receipt.reopenedEventId;
      const at = stage === 'committed' ? receipt.committedAtMs : receipt.reopenedAtMs;
      if (
        typeof id !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(id) ||
        !Number.isSafeInteger(at) ||
        typeof receipt.operationId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(receipt.operationId) ||
        typeof receipt.revisionId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(receipt.revisionId) ||
        typeof receipt.appSessionId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(receipt.appSessionId) ||
        typeof receipt.episodeCorrelationId !== 'string' ||
        !FEEDBACK_SCOPE_RE.test(receipt.episodeCorrelationId) ||
        !receipt.origin ||
        !isTableOperationObservation(receipt.observation)
      )
        return null;
      const match = stage === 'committed' || receipt.readbackMatch === true;
      return {
        origin: receipt.origin as OptionalTelemetryOrigin,
        event: {
          eventId: id,
          eventName: 'workflow_action_observed',
          payloadSchemaVersion: 1,
          referenceKind: 'table_notebook_revision',
          referenceId: receipt.revisionId,
          createdAtMs: at as number,
          properties: {
            $insert_id: id,
            feature_area: 'scientific_workflow',
            workflow: 'table',
            workflow_action: receipt.observation.operation === 'configure' ? 'create' : 'update',
            ...tableObservationProperties(receipt.observation),
            action_id: receipt.operationId,
            effect_id: id,
            artifact_correlation_id: receipt.revisionId,
            app_session_id: receipt.appSessionId,
            episode_correlation_id: receipt.episodeCorrelationId,
            action_phase: stage === 'committed' ? 'commit' : 'result',
            occurred_at_ms: at as number,
            workflow_origin: stage === 'committed' ? 'direct' : 'projection',
            workflow_status: stage === 'committed' ? 'saved' : match ? 'completed' : 'failed',
            success: match,
            outcome_kind:
              stage === 'committed'
                ? 'table_save_committed'
                : match
                  ? 'reopened_confirmed'
                  : 'table_reopen_mismatch',
          },
        },
      };
    });
  }
}

export function recoverTableNotebookTelemetry(): void {
  try {
    const rows = getDb()
      .prepare('SELECT key FROM settings WHERE substr(key, 1, ?) = ? LIMIT 256')
      .all(TABLE_NOTEBOOK_RECEIPT_PREFIX.length, TABLE_NOTEBOOK_RECEIPT_PREFIX) as {
      key: string;
    }[];
    for (const row of rows) publishTableNotebookReceipt(row.key);
  } catch (_error) {
    void _error;
  }
}

function originCurrentlyAdmissible(origin: OptionalTelemetryOrigin): boolean {
  const accepted = currentOptionalContext();
  return (
    accepted !== null &&
    [origin.consentScope, origin.contextId, origin.processId].every((id) =>
      FEEDBACK_SCOPE_RE.test(id)
    ) &&
    origin.consentScope === accepted.consentScope &&
    origin.contextId === accepted.contextId &&
    origin.classification === accepted.classification
  );
}

function authorityCurrentlyAdmissible(authority: AnalyticsOutboxAuthority): boolean {
  const accepted = currentOptionalContext();
  return (
    accepted !== null &&
    originCurrentlyAdmissible(authority.origin) &&
    sameIdentity(accepted.identity, authority.context)
  );
}

function enqueueOriginBound<Properties extends object>(
  origin: OptionalTelemetryOrigin,
  input: AnalyticsOutboxInput<Properties>,
  wireContext?: AnalyticsIdentityContext,
  committedReceiptStillExact?: () => boolean
): boolean {
  try {
    const properties = input.properties as Readonly<Record<string, unknown>>;
    if (committedReceiptStillExact && !committedReceiptStillExact()) return false;
    if (
      OPERATIONAL_AUTH_EVENTS.has(input.eventName) ||
      (isWorkspaceSyncReceiptEvent(input.eventName) && !committedReceiptStillExact) ||
      !originCurrentlyAdmissible(origin) ||
      'emitted_at_ms' in properties ||
      'workspace_origin_class' in properties
    )
      return false;
    if (
      input.eventName === 'feedback_stage' &&
      (!wireContext ||
        wireContext.kind !== 'fallback' ||
        wireContext.sessionId !== origin.processId)
    )
      return false;
    const safe = sanitizePostHogSdkEvent(
      { event: input.eventName, properties: sanitizeClosedBetaProperties(properties) },
      'desktop',
      'unknown',
      CLOSED_BETA_EVENT_PROPERTIES,
      undefined,
      CLOSED_BETA_EVENT_VERSIONS
    );
    if (
      !safe ||
      Object.entries(properties).some(
        ([key, value]) => key !== '$insert_id' && safe.properties[key] !== value
      ) ||
      (properties.$insert_id !== undefined && properties.$insert_id !== input.eventId)
    )
      return false;
    const db = getDb();
    const existing = getAnalyticsOutboxEvent(db, input.eventId);
    const accepted = currentOptionalContext();
    if (!accepted) return false;

    if (!existing && origin.processId !== FEEDBACK_PROCESS_ID && !committedReceiptStillExact)
      return false;
    const authority: AnalyticsOutboxAuthority | null =
      existing?.authority ??
      (existing
        ? null
        : {
            origin: Object.freeze({
              consentScope: origin.consentScope,
              contextId: origin.contextId,
              processId: origin.processId,
              classification: origin.classification,
            }),
            context: copyIdentity(accepted.identity),
            runtimeProperties: accepted.runtimeProperties,
            ...(wireContext ? { wireContext: copyIdentity(wireContext) } : {}),
          });
    if (
      !authority ||
      JSON.stringify(authority.origin) !==
        JSON.stringify({
          consentScope: origin.consentScope,
          contextId: origin.contextId,
          processId: origin.processId,
          classification: origin.classification,
        }) ||
      (wireContext && (!authority.wireContext || !sameIdentity(wireContext, authority.wireContext)))
    )
      return false;
    return putOriginBoundAnalyticsOutboxEvent(
      db,
      {
        ...input,
        properties: {
          ...properties,
          ...(isWorkspaceSyncReceiptEvent(input.eventName)
            ? { workspace_origin_class: origin.classification }
            : {}),
          $insert_id: input.eventId,
        } as Record<string, string | number | boolean>,
      },
      authority,
      (candidate) =>
        authorityCurrentlyAdmissible(candidate) &&
        (!committedReceiptStillExact || committedReceiptStillExact())
    );
  } catch {
    return false;
  }
}

export function enqueueRendererWorkflowEvent(request: RendererWorkflowTelemetryRequest): boolean {
  try {
    if (
      !request ||
      !['workflow_action_observed', 'meaningful_activity_completed'].includes(request.eventName) ||
      !request.properties ||
      typeof request.properties !== 'object' ||
      Array.isArray(request.properties) ||
      (request.properties.$insert_id !== undefined &&
        request.properties.$insert_id !== request.eventId)
    )
      return false;
    const accepted = currentOptionalContext();
    if (!accepted || !sameIdentity(accepted.liveIdentity, request.context)) return false;
    const present = enqueueOriginBound(
      request.origin,
      {
        eventId: request.eventId,
        eventName: request.eventName,
        payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
        referenceKind: 'renderer_workflow',
        referenceId: request.eventId,
        properties: request.properties,
        createdAtMs: request.capturedAtMs,
      },
      request.context
    );
    if (present) void drainMainAnalyticsOutbox();
    return present;
  } catch {
    return false;
  }
}

export function enqueueOptionalAnalyticsEvent<Properties extends object>(
  origin: OptionalTelemetryOrigin,
  input: AnalyticsOutboxInput<Properties>
): boolean {
  const present = enqueueOriginBound(origin, input);
  if (present) void drainMainAnalyticsOutbox();
  return present;
}

export function enqueueOptionalAnalyticsEventFromReceipt<Properties extends object>(
  readCommittedReceipt: () => CommittedOptionalAnalyticsReceipt<Properties> | null
): boolean {
  try {
    const receipt = readCommittedReceipt();
    if (!receipt) return false;
    const fingerprint = (value: CommittedOptionalAnalyticsReceipt<Properties>) =>
      JSON.stringify({
        origin: {
          consentScope: value.origin.consentScope,
          contextId: value.origin.contextId,
          processId: value.origin.processId,
          classification: value.origin.classification,
        },
        eventId: value.event.eventId,
        eventName: value.event.eventName,
        payloadSchemaVersion: value.event.payloadSchemaVersion,
        referenceKind: value.event.referenceKind,
        referenceId: value.event.referenceId,
        createdAtMs: value.event.createdAtMs,
        properties: Object.fromEntries(
          Object.entries(value.event.properties).sort(([a], [b]) => a.localeCompare(b))
        ),
      });
    const original = fingerprint(receipt);
    const stillExact = () => {
      const current = readCommittedReceipt();
      return current !== null && fingerprint(current) === original;
    };
    const present = enqueueOriginBound(receipt.origin, receipt.event, undefined, stillExact);
    if (present) void drainMainAnalyticsOutbox();
    return present;
  } catch {
    return false;
  }
}

type AnalyticsIdentityListener = (identity: { distinctId: string; sessionId: string }) => void;
const identityListeners = new Set<AnalyticsIdentityListener>();

export function onAnalyticsIdentity(listener: AnalyticsIdentityListener): () => void {
  identityListeners.add(listener);
  return () => identityListeners.delete(listener);
}

function retireContextClient(): void {
  publisherEpoch++;
  const retiring = client;
  client = null;
  if (retiring)
    void discardQueuedAndShutdown(retiring).catch(() => {
      console.warn('[analytics] prior-context client shutdown unavailable');
    });
}

export function syncAnalyticsIdentityContext(context: AnalyticsIdentityContext): boolean {
  const previous = contextQueue.currentContext();
  if (!acceptIdentityContext(previous, context)) return false;
  const retainedContext =
    previous && sameRendererIdentity(previous, context) ? currentOptionalContext() : null;
  if (previous && !retainedContext) {
    acceptedOptionalContext = null;
    mayResumePersistedContext = false;
    retireContextClient();
  }
  const accepted = contextQueue.syncContext(context);
  if (accepted) {
    for (const listener of identityListeners) {
      listener({ distinctId: context.distinctId, sessionId: context.sessionId });
    }
    bindAcceptedOptionalContext(context);
    if (retainedContext && acceptedOptionalContext?.contextId !== retainedContext.contextId)
      retireContextClient();
    try {
      startClient();
    } catch {
      analyticsEnabled = false;
    }
    void drainMainAnalyticsOutbox();
    try {
      publishWorkspaceSyncUploadTelemetry(getDb());
      publishWorkspaceSyncRecoveryTelemetry(getDb());
      publishWorkspaceSyncEnablementTelemetry(getDb());
      publishWorkspaceSyncRestoreTelemetry(getDb());
    } catch {}
  }
  return accepted;
}

function closeMainAnalyticsGate(): PostHog | null {
  analyticsEnabled = false;
  appSessionStartedAtMs = null;
  acceptedOptionalContext = null;
  mayResumePersistedContext = false;
  publisherEpoch++;
  contextQueue.setConsent(false);
  const retiring = client ?? normalShutdownClient;
  client = null;
  normalShutdownClient = null;
  return retiring;
}

export async function setMainAnalyticsConsent(enabled: boolean): Promise<void> {
  if (!enabled) {
    const retiringClient = closeMainAnalyticsGate();
    if (retiringClient) await discardQueuedAndShutdown(retiringClient);
    return;
  }

  if (normalShutdownClient) {
    const retiring = normalShutdownClient;
    normalShutdownClient = null;
    publisherEpoch++;
    void discardQueuedAndShutdown(retiring).catch(() => {
      console.warn('[analytics] prior shutdown client unavailable');
    });
  }

  if (!runtimeConfig) runtimeConfig = resolvePostHogRuntimeConfig(retainedAnalyticsConfig);
  if (!runtimeConfig) return;
  startClient();
  analyticsEnabled = client !== null;
  contextQueue.setConsent(analyticsEnabled);
}

function retainAnalyticsConfig(
  config: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!config) return undefined;
  const retained: Record<string, string> = {};
  for (const key of [
    'POSTHOG_API_KEY',
    'POSTHOG_HOST',
    'DNAFORGE_RELEASE_CHANNEL',
    'RELEASE_CHANNEL',
    'DNAFORGE_TELEMETRY_CANARY_ID',
    'DNAFORGE_TELEMETRY_ENVIRONMENT',
    'DNAFORGE_TELEMETRY_CANARY_PROXY_TOKEN',
    'DNAFORGE_TELEMETRY_ACTOR',
    'DNAFORGE_TELEMETRY_ACTOR_ASSERTION',
    'DNAFORGE_TELEMETRY_CI_RUN_ID',
    'GITHUB_ACTIONS',
    'GITHUB_RUN_ID',
    'CI',
    'NODE_ENV',
  ]) {
    if (config[key]) retained[key] = config[key];
  }
  return Object.keys(retained).length > 0 ? retained : undefined;
}

export async function grantMainAnalyticsConsent(
  requestedBasis: AnalyticsConsentBasis = 'default'
): Promise<boolean> {
  const stored = getAnalyticsConsentStateFromDb();
  const basis: AnalyticsConsentBasis =
    requestedBasis === 'explicit' || (stored.consent === 'true' && stored.basis === 'explicit')
      ? 'explicit'
      : 'default';
  const decision = resolveDesktopConsentPolicy({
    consent: 'true',
    version: ANALYTICS_CONSENT_VERSION,
    basis,
  });
  if (!decision.enabled) {
    await setMainAnalyticsConsent(false);
    return false;
  }
  persistAnalyticsConsent(true, basis);
  await setMainAnalyticsConsent(true);
  const accepted = contextQueue.currentContext();
  if (accepted && !acceptedOptionalContext) bindAcceptedOptionalContext(accepted);
  trackAppSessionStarted();
  drainMainAnalyticsOutbox();
  try {
    publishWorkspaceSyncUploadTelemetry(getDb());
    publishWorkspaceSyncRecoveryTelemetry(getDb());
    publishWorkspaceSyncEnablementTelemetry(getDb());
    publishWorkspaceSyncRestoreTelemetry(getDb());
  } catch {}
  return true;
}

export function drainMainAnalyticsOutbox(database?: Database.Database): Promise<void> {
  if (!contextQueue.currentContext() || !analyticsEnabled || !client) return Promise.resolve();
  const currentOrigin = captureOptionalTelemetryOrigin();
  if (!currentOrigin) return Promise.resolve();
  if (outboxDrainPromise) {
    outboxDrainRequested = true;
    return outboxDrainPromise;
  }
  let outboxDatabase: Database.Database;
  try {
    outboxDatabase = database ?? getDb();
  } catch (error) {
    reportOutboxDrainFailure(error);
    return Promise.resolve();
  }
  const activeClient = client;
  const epoch = publisherEpoch;
  const admissible = (event: AnalyticsOutboxEvent) =>
    activeClient === client &&
    epoch === publisherEpoch &&
    event.authority !== null &&
    authorityCurrentlyAdmissible(event.authority);
  outboxDrainPromise = drainAnalyticsOutbox(outboxDatabase, {
    origin: currentOrigin,
    admissible,
    deliver: (events, beginAttempt) =>
      captureAndConfirmAnalyticsBatch(
        activeClient,
        events,
        admissible,
        (event, atMs) =>
          event.authority
            ? prepareSdkCapture(
                {
                  event: event.eventName,
                  properties: {
                    ...event.properties,
                    $insert_id: event.eventId,
                    emitted_at_ms: atMs,
                    ...(event.eventName === 'feedback_stage'
                      ? {
                          feedback_origin:
                            event.authority.origin.processId === FEEDBACK_PROCESS_ID
                              ? 'current'
                              : 'restored',
                        }
                      : {}),
                  },
                  capturedAt: new Date(event.createdAtMs),
                },
                event.authority.wireContext ?? event.authority.context,
                event.authority.runtimeProperties,
                event.eventId
              )
            : null,
        beginAttempt
      ),
  })
    .then(({ sent, pending }) => {
      if (sent > 0 && pending > 0) outboxDrainRequested = true;
    })
    .catch(reportOutboxDrainFailure)
    .finally(() => {
      outboxDrainPromise = null;
      if (outboxDrainRequested) {
        outboxDrainRequested = false;
        return drainMainAnalyticsOutbox(outboxDatabase);
      }
    });
  return outboxDrainPromise;
}

function reportOutboxDrainFailure(error: unknown): void {
  let schemaUnavailable = false;
  try {
    schemaUnavailable =
      error instanceof Error && error.message.includes('no such table: analytics_event_outbox');
  } catch (_error) {
    void _error;
  }
  if (!schemaUnavailable) {
    try {
      console.warn('[analytics] durable outbox drain failed', { stage: 'optional_delivery' });
    } catch (_error) {
      void _error;
    }
  }
}

export async function revokeMainAnalyticsConsent(): Promise<void> {
  const retiringClient = closeMainAnalyticsGate();
  let primaryPresent = false;
  let primary: unknown;
  try {
    persistAnalyticsConsent(false, 'explicit');
  } catch (error) {
    primaryPresent = true;
    primary = error;
  }
  if (retiringClient) {
    try {
      await discardQueuedAndShutdown(retiringClient);
    } catch (error) {
      if (!primaryPresent) {
        primaryPresent = true;
        primary = error;
      } else {
        try {
          console.warn('[analytics] secondary revoked-client shutdown unavailable');
        } catch (_error) {
          void _error;
        }
      }
    }
  }
  if (primaryPresent) throw primary;
}

export function trackAllowedEvent(
  event: ClosedBetaEvent,
  properties?: Record<string, unknown>
): boolean {
  if (event === 'feedback_stage' || isWorkspaceSyncReceiptEvent(event)) return false;
  assertMainTelemetryContract(event, properties);
  if (!analyticsEnabled || !isAllowedClosedBetaEvent(event)) return false;
  const globallySanitized = sanitizeClosedBetaProperties(properties);
  const safeEvent = sanitizePostHogSdkEvent(
    { event, properties: globallySanitized },
    'desktop',
    'unknown',
    CLOSED_BETA_EVENT_PROPERTIES,
    undefined,
    CLOSED_BETA_EVENT_VERSIONS
  );
  if (!safeEvent) return false;
  const sanitized = safeEvent.properties;
  const queued = { event, properties: sanitized, capturedAt: new Date() };
  contextQueue.offer(queued);
  if (event !== 'telemetry_payload_rejected' && properties) {
    const allowedKeys = new Set<string>(CLOSED_BETA_EVENT_PROPERTIES[event]);
    const unknownKeys = Object.keys(properties).filter(
      (key) => key !== '$insert_id' && !allowedKeys.has(key)
    );
    const invalidKeys = Object.keys(properties).filter(
      (key) => allowedKeys.has(key) && !(key in sanitized)
    );
    const rejectedKeys = [...unknownKeys, ...invalidKeys];
    const rejectionReason =
      unknownKeys.length > 0 && invalidKeys.length > 0
        ? 'mixed_property'
        : unknownKeys.length > 0
          ? 'unknown_property'
          : 'invalid_property';
    trackMainPayloadRejection(event, rejectedKeys, rejectionReason);
  }
  return true;
}

export function captureFeedbackTelemetryOrigin(): FeedbackTelemetryOrigin | null {
  const origin = captureOptionalTelemetryOrigin();
  return origin ? Object.freeze({ ...origin, metricId: randomUUID() }) : null;
}

export function recordFeedbackTelemetry(
  receipt: FeedbackReceipt,
  readCommittedReceipt?: () => FeedbackReceipt | null
): boolean {
  const { origin } = receipt;
  if (
    !origin.contextId ||
    ![receipt.operationId, origin.metricId].every((id) => FEEDBACK_SCOPE_RE.test(id))
  )
    return false;
  const terminal = ['accepted_intent', 'durable_queue', 'backend_accepted', 'cancelled'].includes(
    receipt.stage
  );
  const digest = createHash('sha256')
    .update(`${receipt.operationId}:${receipt.stage}:${terminal ? 0 : receipt.attempt}`)
    .digest();
  digest[6] = (digest[6]! & 15) | 128;
  digest[8] = (digest[8]! & 63) | 128;
  const hex = digest.subarray(0, 16).toString('hex');
  const insertId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const fingerprint = (value: FeedbackReceipt) =>
    JSON.stringify({
      origin: {
        consentScope: value.origin.consentScope,
        contextId: value.origin.contextId,
        processId: value.origin.processId,
        metricId: value.origin.metricId,
        classification: value.origin.classification,
      },
      operationId: value.operationId,
      stage: value.stage,
      reason: value.reason,
      originalAtMs: value.originalAtMs,
      occurredAtMs: value.occurredAtMs,
      attempt: value.attempt,
    });
  const original = fingerprint(receipt);
  const committedStillExact = readCommittedReceipt
    ? () => {
        const current = readCommittedReceipt();
        return current !== null && fingerprint(current) === original;
      }
    : undefined;
  const present = enqueueOriginBound(
    {
      consentScope: origin.consentScope,
      contextId: origin.contextId,
      processId: origin.processId,
      classification: origin.classification,
    },
    {
      eventId: insertId,
      eventName: 'feedback_stage',
      payloadSchemaVersion: ANALYTICS_OUTBOX_PAYLOAD_SCHEMA_VERSION,
      referenceKind: 'feedback_stage',
      referenceId: receipt.operationId,
      createdAtMs: receipt.occurredAtMs,
      properties: {
        feature_area: 'settings',
        operation_id: receipt.operationId,
        feedback_stage: receipt.stage,
        feedback_reason: receipt.reason ?? 'none',
        feedback_origin_class: origin.classification,
        feedback_attempt_bucket:
          receipt.attempt <= 1 ? 'first' : receipt.attempt < 5 ? 'retry' : 'many',
        origin_started_at_ms: receipt.originalAtMs,
        occurred_at_ms: receipt.occurredAtMs,
        $insert_id: insertId,
      },
    },
    { distinctId: origin.metricId, sessionId: origin.processId, kind: 'fallback', generation: 0 },
    committedStillExact
  );
  if (present) void drainMainAnalyticsOutbox();
  return present;
}

const OPERATIONAL_AUTH_EVENTS = new Set(['auth_started', 'auth_completed', 'auth_failed']);

function assertMainTelemetryContract(event: string, properties?: Record<string, unknown>): void {
  if (process.env.VITEST) return;
  if (app?.isPackaged !== false) return;
  const devServer = Boolean(process.env['ELECTRON_RENDERER_URL']);
  if (!isAllowedClosedBetaEvent(event)) {
    failLoudlyOnTelemetryContractViolation(
      { process: 'main', event, reason: 'unknown_event', keys: Object.keys(properties ?? {}) },
      devServer
    );
    return;
  }
  if (event === 'telemetry_payload_rejected' || !properties) return;
  const sanitized = sanitizeClosedBetaProperties(properties);
  const allowedKeys = new Set<string>(CLOSED_BETA_EVENT_PROPERTIES[event]);
  const keys = Object.keys(properties).filter(
    (key) => key !== '$insert_id' && (!allowedKeys.has(key) || !(key in sanitized))
  );
  if (keys.length > 0) {
    failLoudlyOnTelemetryContractViolation(
      { process: 'main', event, reason: 'rejected_property', keys },
      devServer
    );
  }
}

export function trackEvent(event: string, properties?: Record<string, unknown>): boolean {
  if (OPERATIONAL_AUTH_EVENTS.has(event)) return false;
  if (!isAllowedClosedBetaEvent(event)) {
    assertMainTelemetryContract(event, properties);
    trackMainPayloadRejection(event, Object.keys(properties ?? {}), 'unknown_event');
    return false;
  }
  return trackAllowedEvent(event, properties);
}

function trackMainPayloadRejection(
  rejectedEvent: string,
  rejectedPropertyKeys: string[],
  rejectionReason: 'unknown_event' | 'unknown_property' | 'invalid_property' | 'mixed_property'
): void {
  if (
    !analyticsEnabled ||
    (rejectedPropertyKeys.length === 0 && rejectionReason !== 'unknown_event')
  ) {
    return;
  }
  contextQueue.offer({
    event: 'telemetry_payload_rejected',
    properties: sanitizeClosedBetaProperties({
      feature_area: 'telemetry',
      rejected_event: rejectedEvent,
      rejected_property_keys: rejectedPropertyKeys.sort().join(','),
      rejected_property_count: rejectedPropertyKeys.length,
      rejection_reason: rejectionReason,
      occurred_at_ms: Date.now(),
    }),
    capturedAt: new Date(),
  });
}

interface SessionMarker {
  startedAtMs: number;
  lastSeenAtMs: number;
  appVersion: string;
}

function sessionMarkerPath(): string {
  return join(app.getPath('userData'), '.analytics-session-marker');
}

function writeSessionMarker(marker: SessionMarker): void {
  try {
    writeFileSync(sessionMarkerPath(), JSON.stringify(marker));
  } catch {
    return;
  }
}

function removeSessionMarker(): void {
  try {
    rmSync(sessionMarkerPath(), { force: true });
  } catch {
    return;
  }
}

function takePreviousSessionMarker(): SessionMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionMarkerPath(), 'utf8'));
    removeSessionMarker();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isSafeInteger((parsed as SessionMarker).startedAtMs) &&
      Number.isSafeInteger((parsed as SessionMarker).lastSeenAtMs) &&
      typeof (parsed as SessionMarker).appVersion === 'string'
    ) {
      return parsed as SessionMarker;
    }
  } catch {
    removeSessionMarker();
  }
  return null;
}

export function trackAppSessionStarted(): void {
  if (!analyticsEnabled || appSessionStartedAtMs !== null) return;
  appSessionStartedAtMs = Date.now();
  const firstOpenPath = join(app.getPath('userData'), '.analytics-first-opened');
  if (!existsSync(firstOpenPath)) {
    try {
      writeFileSync(firstOpenPath, new Date().toISOString(), { flag: 'wx' });
      trackAllowedEvent('app_first_opened', {
        feature_area: 'lifecycle',
        lifecycle_scope: 'local_profile',
      });
    } catch {}
  }
  const previous = takePreviousSessionMarker();
  if (previous) {
    trackAllowedEvent('app_session_ended', {
      feature_area: 'lifecycle',
      session_duration_ms: Math.max(0, previous.lastSeenAtMs - previous.startedAtMs),
      close_reason: 'unclean_exit',
      clean_exit: false,
      previous_app_version: previous.appVersion,
    });
  }
  trackAllowedEvent('app_session_started', {
    feature_area: 'lifecycle',
    lifecycle_scope: 'process_session',
  });
  writeSessionMarker({
    startedAtMs: appSessionStartedAtMs,
    lastSeenAtMs: appSessionStartedAtMs,
    appVersion: app.getVersion(),
  });
}

export function touchAppSessionMarker(): void {
  if (appSessionStartedAtMs === null) return;
  writeSessionMarker({
    startedAtMs: appSessionStartedAtMs,
    lastSeenAtMs: Date.now(),
    appVersion: app.getVersion(),
  });
}

export function trackAppClosed(): void {
  if (!analyticsEnabled || appSessionStartedAtMs === null) return;
  trackAllowedEvent('app_session_ended', {
    feature_area: 'lifecycle',
    session_duration_ms: Math.max(0, Date.now() - appSessionStartedAtMs),
    close_reason: 'app_quit',
    clean_exit: true,
  });
  appSessionStartedAtMs = null;
  removeSessionMarker();
}

export type HangSource = 'heartbeat' | 'chromium';
export type HangResolution = 'recovered' | 'reloaded' | 'crashed' | 'window_closed' | 'app_quit';

export function trackAppHang(
  input:
    | { phase: 'detected'; source: HangSource }
    | { phase: 'resolved'; source: HangSource; resolution: HangResolution; durationMs: number }
): void {
  trackAllowedEvent('app_hang_observed', {
    feature_area: 'reliability',
    hang_phase: input.phase,
    hang_source: input.source,
    ...(input.phase === 'resolved'
      ? {
          hang_resolution: input.resolution,
          duration_ms: Math.min(86_400_000, Math.max(0, Math.round(input.durationMs))),
        }
      : {}),
  });
}

export function trackChildProcessGone(input: {
  process_memory?: number | null;
  uptime_ms?: number | null;
  processType: string;
  reason: string;
  exitCode: number;
}): void {
  trackAllowedEvent('child_process_gone', {
    feature_area: 'reliability',
    process_type: normalizeChildProcessType(input.processType),
    gone_reason: normalizeErrorClass(input.reason),
    reason: normalizeErrorClass(input.reason),
    ...(input.process_memory !== undefined
      ? { process_memory: input.process_memory ?? 'unavailable' }
      : {}),
    ...(input.uptime_ms !== undefined ? { uptime_ms: input.uptime_ms ?? 'unavailable' } : {}),
    exit_code: input.exitCode,
    fatal: false,
    handled: true,
  });
}

function normalizeChildProcessType(value: string): string {
  const normalized = normalizeErrorClass(value);
  return new Set([
    'renderer',
    'gpu',
    'utility',
    'zygote',
    'sandbox_helper',
    'pepper_plugin',
    'pepper_plugin_broker',
  ]).has(normalized)
    ? normalized
    : 'unknown';
}

export function trackActivityHeartbeat(input: {
  intervalMinutes: number;
  activeMinutes: number;
  focusedMinutes: number;
  mainHeapMb: number;
  appMemoryMb: number;
  rendererMemoryMb: number;
  gpuMemoryMb: number;
}): void {
  trackAllowedEvent('app_activity_heartbeat', {
    feature_area: 'lifecycle',
    interval_minutes: input.intervalMinutes,
    active_minutes: input.activeMinutes,
    focused_minutes: input.focusedMinutes,
    main_heap_mb: input.mainHeapMb,
    app_memory_mb: input.appMemoryMb,
    renderer_memory_mb: input.rendererMemoryMb,
    gpu_memory_mb: input.gpuMemoryMb,
  });
}

export function trackStartupTimed(input: {
  readyMs: number;
  windowMs: number;
  shellReadyMs: number;
}): void {
  trackAllowedEvent('app_startup_timed', {
    feature_area: 'lifecycle',
    ready_ms: Math.max(0, Math.round(input.readyMs)),
    window_ms: Math.max(0, Math.round(input.windowMs)),
    shell_ready_ms: Math.max(0, Math.round(input.shellReadyMs)),
  });
}

export function trackComputeJobObserved(record: {
  provider: string;
  toolId: string;
  state: string;
  pollCount: number;
  createdAt: string;
  updatedAt: string;
}): void {
  const phase = record.state === 'canceled' ? 'canceled' : record.state;
  const started = Date.parse(record.createdAt);
  const ended = Date.parse(record.updatedAt);
  trackAllowedEvent('compute_job_observed', {
    feature_area: 'tool_usage',
    job_phase: phase,
    compute_provider: normalizeErrorClass(record.provider),
    compute_tool: normalizeErrorClass(record.toolId),
    poll_count: record.pollCount,
    ...(Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? { compute_duration_ms: ended - started }
      : {}),
  });
}

export function trackMainProcessError(
  errorType: 'uncaught_exception' | 'unhandled_rejection'
): void {
  trackAllowedEvent('desktop_main_error_captured', {
    feature_area: 'reliability',
    error_class: errorType,
    fatal: true,
    handled: false,
  });
}

export function trackRenderProcessCrashed(
  reason: string,
  details: Record<string, unknown> = {}
): void {
  trackAllowedEvent('desktop_main_error_captured', {
    feature_area: 'reliability',
    error_class: normalizeRendererCrashClass(reason),
    ...details,
    fatal: true,
    handled: false,
  });
}

function normalizeRendererCrashClass(value: string): string {
  const normalized = normalizeErrorClass(value);
  return new Set([
    'clean_exit',
    'abnormal_exit',
    'killed',
    'crashed',
    'oom',
    'launch_failed',
    'integrity_failure',
  ]).has(normalized)
    ? normalized
    : 'unknown';
}

export function trackSidecarLifecycleEvent(
  eventClass: string,
  opts: {
    fatal?: boolean;
    handled?: boolean;
    success?: boolean;
    manual?: boolean;
    retryAttempt?: number;
    exitCode?: number | null;
    signal?: string | null;
    elapsedMs?: number;
    reason?: string;
    process_memory?: number | null;
    uptime_ms?: number | null;
  } = {}
): void {
  trackAllowedEvent('sidecar_lifecycle', {
    feature_area: 'reliability',
    error_class: normalizeErrorClass(`sidecar_${eventClass}`),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.process_memory !== undefined
      ? { process_memory: opts.process_memory ?? 'unavailable' }
      : {}),
    ...(opts.uptime_ms !== undefined ? { uptime_ms: opts.uptime_ms ?? 'unavailable' } : {}),
    fatal: Boolean(opts.fatal),
    handled: opts.handled ?? true,
    success: opts.success ?? !opts.fatal,
    manual: Boolean(opts.manual),
    retry_count_bucket: bucketRetryCount(opts.retryAttempt ?? 0),
    ...(opts.exitCode !== undefined ? { exit_code: opts.exitCode ?? 'unavailable' } : {}),
    ...(opts.signal ? { exit_signal: normalizeExitSignal(opts.signal) } : {}),
    ...(opts.elapsedMs !== undefined
      ? { elapsed_ms: Math.max(0, Math.round(opts.elapsedMs)) }
      : {}),
  });
}

function normalizeExitSignal(value: string): string {
  const normalized = value.trim().toLowerCase();
  return new Set([
    'sigabrt',
    'sigbus',
    'sigfpe',
    'sighup',
    'sigill',
    'sigint',
    'sigkill',
    'sigpipe',
    'sigsegv',
    'sigterm',
    'sigtrap',
  ]).has(normalized)
    ? normalized
    : 'other';
}

export async function shutdownAnalytics(): Promise<void> {
  analyticsEnabled = false;
  acceptedOptionalContext = null;
  mayResumePersistedContext = false;
  contextQueue.setConsent(false);
  const retiring = client;
  client = null;
  if (!retiring) return;
  const epoch = publisherEpoch;
  normalShutdownClient = retiring;
  try {
    await boundedShutdown(retiring);
  } finally {
    if (normalShutdownClient === retiring) normalShutdownClient = null;
    if (publisherEpoch === epoch) publisherEpoch++;
  }
}

export async function flushAnalyticsForFatalStartup(): Promise<void> {
  try {
    contextQueue.flushPendingWithFallback();
    await shutdownAnalytics();
  } catch (error) {
    console.warn('[analytics] Fatal-startup flush failed:', error);
  }
}

function startClient(): void {
  if (client || !runtimeConfig) return;
  const options: PostHogOptions = {
    host: runtimeConfig.host,
    disableGeoip: true,
    enableExceptionAutocapture: false,
    before_send: (message) => {
      if (!message) return null;
      if (message.event !== '$exception') return message;
      const safe = sanitizePostHogSdkEvent(
        { event: message.event, properties: message.properties ?? {} },
        'desktop'
      );
      return safe
        ? {
            ...message,
            properties: {
              ...safe.properties,
              ...sanitizeClosedBetaProperties({}, defaultProperties()),
            },
          }
        : null;
    },
  };
  const epoch = publisherEpoch;
  const proxyToken = runtimeConfig.canaryProxyToken;
  const instance: { current?: PostHog } = {};
  options.fetch = (url, fetchOptions) => {
    if (
      epoch !== publisherEpoch ||
      !(
        (analyticsEnabled && client === instance.current) ||
        normalShutdownClient === instance.current
      ) ||
      (acceptedOptionalContext !== null && currentOptionalContext() === null)
    ) {
      return Promise.reject(new Error('Optional analytics authority closed'));
    }
    return fetch(url, {
      ...fetchOptions,
      headers: {
        ...fetchOptions.headers,
        ...(proxyToken ? { [CANARY_PROXY_TOKEN_HEADER]: proxyToken } : {}),
      },
    });
  };
  instance.current = new PostHog(runtimeConfig.apiKey, options);
  client = instance.current;
}

export async function captureMainException(error: unknown): Promise<void> {
  const activeClient = client;
  if (!activeClient || !analyticsEnabled || mainExceptionCount >= 25) return;
  if (error !== null && typeof error === 'object') {
    if (capturedMainExceptions.has(error)) return;
    capturedMainExceptions.add(error);
  }
  mainExceptionCount += 1;
  const context = contextQueue.currentContext();
  try {
    await activeClient.captureExceptionImmediate(error, context?.distinctId, {
      ...sanitizeClosedBetaProperties({}, defaultProperties()),
      ...(context ? { $session_id: context.sessionId, identity_kind: context.kind } : {}),
    });
  } catch {
    console.warn('[analytics] Exception delivery failed');
  }
}

export function setAnalyticsOrganization(organizationId: string | null): void {
  analyticsOrganization = organizationId;
  if (!organizationId || !client || !analyticsEnabled) return;
  if (identifiedOrganizationGroups.has(organizationId)) return;
  identifiedOrganizationGroups.add(organizationId);
  client.groupIdentify({ groupType: ANALYTICS_ORGANIZATION_GROUP, groupKey: organizationId });
}

function prepareSdkCapture(
  queued: MainAnalyticsQueuedEvent,
  context: AnalyticsIdentityContext,
  defaults: Record<string, unknown> = defaultProperties(),
  uuid?: string
): Parameters<PostHog['capture']>[0] | null {
  const safeEvent = sanitizePostHogSdkEvent(
    { event: queued.event, properties: sanitizeClosedBetaProperties(queued.properties, defaults) },
    'desktop',
    'unknown',
    CLOSED_BETA_EVENT_PROPERTIES,
    undefined,
    CLOSED_BETA_EVENT_VERSIONS
  );
  if (!safeEvent) return null;
  return {
    distinctId: context.distinctId,
    event: queued.event,
    properties: {
      ...safeEvent.properties,
      identity_kind: context.kind === 'identified' ? 'identified' : 'anonymous',
      $session_id: context.sessionId,
    },
    ...(analyticsOrganization && context.kind === 'identified'
      ? { groups: { [ANALYTICS_ORGANIZATION_GROUP]: analyticsOrganization } }
      : {}),
    timestamp: queued.capturedAt,
    ...(uuid ? { uuid } : {}),
  };
}

function emitWithContext(
  queued: MainAnalyticsQueuedEvent,
  context: AnalyticsIdentityContext
): void {
  if (!client || !analyticsEnabled) return;
  const capture = prepareSdkCapture(queued, context);
  if (capture) client.capture(capture);
}

async function boundedShutdown(posthog: PostHog): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 2_000);
    timer.unref();
  });
  try {
    await Promise.race([posthog.shutdown(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function discardQueuedAndShutdown(posthog: PostHog): Promise<void> {
  let primaryPresent = false;
  let primary: unknown;
  const remember = (error: unknown) => {
    if (!primaryPresent) {
      primaryPresent = true;
      primary = error;
    }
  };
  try {
    await posthog.optOut();
  } catch (error) {
    remember(error);
  }
  const queueKey = 'queue' as Parameters<PostHog['setPersistedProperty']>[0];
  try {
    posthog.setPersistedProperty(queueKey, []);
  } catch (error) {
    remember(error);
  }
  try {
    await boundedShutdown(posthog);
  } catch (error) {
    remember(error);
  }
  if (primaryPresent) throw primary;
}

function isPublicPostHogKey(value: unknown): value is string {
  return typeof value === 'string' && /^phc_[A-Za-z0-9_-]{4,256}$/.test(value);
}

function normalizeErrorClass(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'unknown';
}

function bucketRetryCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  return '21_100';
}

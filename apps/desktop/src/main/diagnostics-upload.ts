import { app } from 'electron';
import { isCommunityBuild } from './distribution';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { getWebBaseUrl } from './auth/auth-config';
import { getInstallId } from './ipc/feedback';
import { redactTelemetryText } from '../shared/redact-telemetry';
import { getTelemetryConsent, onTelemetryConsentChange } from './telemetry-consent';
import {
  normalizeTelemetryActor,
  sanitizeCiRunId,
  type TelemetryActor,
} from '@waypoint/analytics-policy';
import { isTelemetryActorAssertionToken } from '@waypoint/analytics-policy/telemetry-actor-assertion';
import {
  appendBootLog,
  copyInstallLogIntoUserData,
  getBootLogPath,
  initBootLog,
  readLogTail,
  resolveWindowsInstallLogPath,
} from './boot-log';
import {
  isTelemetryEgressSuppressed,
  resolveTelemetryRuntimeDimensions,
} from './telemetry-runtime';

const QUEUE_FILE = 'pending-diagnostics.json';
const INFLIGHT_QUEUE_FILE = 'pending-diagnostics.inflight.json';
const QUEUE_MAX = 20;
const MAX_FILE_CHARS = 80_000;
const APP_BOOT_BEACON_MAX_ATTEMPTS = 3;
const WEBSITE_DIAGNOSTICS_ORIGIN = 'https://dnaforge.com';
const DESKTOP_RELEASE_CHANNELS = new Set(['closed_beta', 'dev', 'preview', 'prod', 'unknown']);

export type DiagnosticsKind =
  | 'crash'
  | 'boot_failure'
  | 'log_bundle'
  | 'boot_ok'
  | 'renderer_error';

export interface DiagnosticsUploadPayload {
  schema: 1;
  event_id: string;
  kind: DiagnosticsKind;
  app_version: string;
  platform_info: string;
  install_id: string;
  attempt_id?: string;
  download_id?: string;
  telemetry_actor: TelemetryActor;
  is_synthetic?: boolean;
  telemetry_actor_assertion?: string;
  ci_run_id?: string;
  desktop_build_tag?: string;
  desktop_release_channel: string;
  error_class?: string;
  summary?: string;
  files?: { name: string; content: string }[];
  user_agent?: string;
  timestamp: string;
}

declare const installerRunIdBrand: unique symbol;
declare const downloadIdBrand: unique symbol;

export type InstallerRunId = string & { readonly [installerRunIdBrand]: true };
export type DownloadId = string & { readonly [downloadIdBrand]: true };

export interface InstallIdentitySnapshot {
  attemptId?: InstallerRunId;
  downloadId?: DownloadId;
}

const DOWNLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'event_id')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeForHash(child)])
    );
  }
  return value;
}

function legacyDiagnosticsEventId(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalizeForHash(payload));
  const bytes = createHash('sha256')
    .update(`dnaforge:diagnostics:legacy-queue:v1:${canonical}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function installIdentityPaths(userDataPath: string): string[] {
  return [
    join(userDataPath, 'logs', 'install-attempt.id'),
    resolveWindowsInstallLogPath()?.replace(/install\.log$/i, 'install-attempt.id') ?? '',
  ].filter((candidate, index, paths) => Boolean(candidate) && paths.indexOf(candidate) === index);
}

function latestInstallerInitAttemptId(userDataPath: string): string | undefined {
  const candidates = [
    resolveWindowsInstallLogPath() ?? '',
    join(userDataPath, 'logs', 'install.log'),
  ].filter((candidate, index, paths) => Boolean(candidate) && paths.indexOf(candidate) === index);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const content = readFileSync(candidate, 'utf-8');
      const pattern = /\bevent=init\b[^\r\n]*\battempt=([A-Za-z0-9-]{1,128})(?:\s|$)/g;
      let latest: string | undefined;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) latest = match[1];
      if (latest) return latest;
    } catch {
      continue;
    }
  }
  return undefined;
}

function isDiagnosticsLoopbackUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  );
}

function packagedDiagnosticsBaseUrl(): string {
  try {
    const authority = new URL(getWebBaseUrl());
    return isDiagnosticsLoopbackUrl(authority) ? authority.origin : WEBSITE_DIAGNOSTICS_ORIGIN;
  } catch {
    return WEBSITE_DIAGNOSTICS_ORIGIN;
  }
}

function diagnosticsBaseUrl(): string {
  const fallback = app.isPackaged ? packagedDiagnosticsBaseUrl() : getWebBaseUrl();
  const override = process.env.DIAGNOSTICS_URL?.trim();
  if (!override) return fallback;
  if (!app.isPackaged) return override;
  try {
    const parsed = new URL(override);
    if (isDiagnosticsLoopbackUrl(parsed)) {
      return override.replace(/\/$/, '');
    }
  } catch {
    return fallback;
  }
  return fallback;
}

export function normalizeErrorClass(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalized || 'unknown';
}

export function readInstallIdentitySnapshot(userDataPath: string): InstallIdentitySnapshot {
  const currentAttemptId = latestInstallerInitAttemptId(userDataPath);
  if (!currentAttemptId) return {};
  for (const candidate of installIdentityPaths(userDataPath)) {
    try {
      if (!existsSync(candidate)) continue;
      const lines = readFileSync(candidate, 'utf-8').split(/\r?\n/);
      const attemptId = lines[0]?.trim().slice(0, 128);
      if (!attemptId || attemptId !== currentAttemptId) continue;
      const downloadCandidate = lines[1]?.trim();
      const downloadId =
        downloadCandidate && DOWNLOAD_ID_RE.test(downloadCandidate)
          ? (downloadCandidate as DownloadId)
          : undefined;
      return {
        attemptId: attemptId as InstallerRunId,
        ...(downloadId ? { downloadId } : {}),
      };
    } catch {
      void 0;
    }
  }
  return {};
}

export function consumeInstallIdentitySnapshot(
  userDataPath: string,
  snapshot: InstallIdentitySnapshot
): void {
  if (!snapshot.attemptId) return;
  for (const candidate of installIdentityPaths(userDataPath)) {
    try {
      if (!existsSync(candidate)) continue;
      const lines = readFileSync(candidate, 'utf-8').split(/\r?\n/);
      if (lines[0]?.trim() !== snapshot.attemptId) continue;
      const storedDownloadId = lines[1]?.trim().toLowerCase();
      if (snapshot.downloadId && storedDownloadId !== snapshot.downloadId.toLowerCase()) continue;
      unlinkSync(candidate);
    } catch {
      void 0;
    }
  }
}

function uploadUrl(): string {
  return `${diagnosticsBaseUrl()}/api/diagnostics/upload`;
}

function beaconUrl(): string {
  return `${diagnosticsBaseUrl()}/api/diagnostics/install-beacon`;
}

type QueueReadResult =
  | { status: 'ok'; items: unknown[] }
  | { status: 'unavailable'; reason: 'read_failed' | 'invalid_shape' };

type QueueClaimResult =
  | { status: 'empty' }
  | { status: 'unavailable' }
  | { status: 'claimed'; items: unknown[] };

const queueMutationTails = new Map<string, Promise<unknown>>();
const queueFlushTails = new Map<string, Promise<unknown>>();

function serializePerPath<T>(
  tails: Map<string, Promise<unknown>>,
  path: string,
  operation: () => T | Promise<T>
): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => operation());
  tails.set(path, current);
  return current.finally(() => {
    if (tails.get(path) === current) tails.delete(path);
  });
}

function serializeQueueMutation<T>(appDataPath: string, operation: () => T): Promise<T> {
  return serializePerPath(queueMutationTails, join(appDataPath, QUEUE_FILE), operation);
}

function readQueueFile(queuePath: string): QueueReadResult {
  try {
    if (!existsSync(queuePath)) return { status: 'ok', items: [] };
    const parsed: unknown = JSON.parse(readFileSync(queuePath, 'utf-8'));
    return Array.isArray(parsed)
      ? { status: 'ok', items: parsed }
      : { status: 'unavailable', reason: 'invalid_shape' };
  } catch {
    return { status: 'unavailable', reason: 'read_failed' };
  }
}

function writeQueueFile(queuePath: string, queue: DiagnosticsUploadPayload[]): boolean {
  const temporaryPath = `${queuePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(queue, null, 2), 'utf-8');
    renameSync(temporaryPath, queuePath);
    return true;
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      void 0;
    }
    return false;
  }
}

function enqueue(appDataPath: string, payload: DiagnosticsUploadPayload): Promise<boolean> {
  return serializeQueueMutation(appDataPath, () => {
    const queuePath = join(appDataPath, QUEUE_FILE);
    const queueRead = readQueueFile(queuePath);
    if (queueRead.status !== 'ok') return false;
    const capped =
      queueRead.items.length >= QUEUE_MAX
        ? queueRead.items.slice(-(QUEUE_MAX - 1))
        : queueRead.items;
    const safePayload = sanitizeDiagnosticsUploadForEgress(payload, appDataPath);
    if (!safePayload) return false;
    const existing = queueRead.items
      .flatMap((item) => {
        const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
        return safeItem ? [safeItem] : [];
      })
      .find((item) => item.event_id === safePayload.event_id);
    if (existing) {
      return (
        JSON.stringify(canonicalizeForHash(existing)) ===
        JSON.stringify(canonicalizeForHash(safePayload))
      );
    }
    capped.push(safePayload);
    return writeQueueFile(
      queuePath,
      capped.flatMap((item) => {
        const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
        return safeItem ? [safeItem] : [];
      })
    );
  });
}

function removePendingDiagnostic(appDataPath: string, eventId: string): Promise<boolean> {
  return serializeQueueMutation(appDataPath, () => {
    const path = join(appDataPath, QUEUE_FILE);
    const queue = readQueueFile(path);
    if (queue.status !== 'ok') return false;
    return writeQueueFile(
      path,
      queue.items.flatMap((item) => {
        const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
        return safeItem && safeItem.event_id !== eventId ? [safeItem] : [];
      })
    );
  });
}

function claimPendingQueue(
  appDataPath: string,
  includeActiveWithRecoveredClaim: boolean
): Promise<QueueClaimResult> {
  return serializeQueueMutation(appDataPath, () => {
    const activePath = join(appDataPath, QUEUE_FILE);
    const inflightPath = join(appDataPath, INFLIGHT_QUEUE_FILE);

    if (existsSync(inflightPath)) {
      const staleClaim = readQueueFile(inflightPath);
      if (staleClaim.status !== 'ok') return { status: 'unavailable' };
      if (staleClaim.items.length > 0) {
        if (!includeActiveWithRecoveredClaim) {
          return { status: 'claimed', items: staleClaim.items };
        }
        const activeQueue = readQueueFile(activePath);
        if (activeQueue.status !== 'ok') return { status: 'unavailable' };
        const seen = new Set<string>();
        const merged = [...staleClaim.items, ...activeQueue.items].flatMap((item) => {
          const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
          if (!safeItem || seen.has(safeItem.event_id)) return [];
          seen.add(safeItem.event_id);
          return [safeItem];
        });
        if (!writeQueueFile(inflightPath, merged)) return { status: 'unavailable' };
        return { status: 'claimed', items: merged };
      }
      try {
        unlinkSync(inflightPath);
      } catch {
        return { status: 'unavailable' };
      }
    }

    const activeQueue = readQueueFile(activePath);
    if (activeQueue.status !== 'ok') return { status: 'unavailable' };
    if (activeQueue.items.length === 0) return { status: 'empty' };

    try {
      renameSync(activePath, inflightPath);
      return { status: 'claimed', items: activeQueue.items };
    } catch {
      return { status: 'unavailable' };
    }
  });
}

function discardPendingQueue(appDataPath: string): Promise<void> {
  return serializeQueueMutation(appDataPath, () => {
    for (const file of [QUEUE_FILE, INFLIGHT_QUEUE_FILE]) {
      rmSync(join(appDataPath, file), { force: true });
    }
  });
}

function persistClaimRemainder(
  appDataPath: string,
  claimed: unknown[],
  remaining: DiagnosticsUploadPayload[]
): Promise<boolean> {
  return serializeQueueMutation(appDataPath, () => {
    const activePath = join(appDataPath, QUEUE_FILE);
    const inflightPath = join(appDataPath, INFLIGHT_QUEUE_FILE);
    const activeQueue = readQueueFile(activePath);
    if (activeQueue.status !== 'ok') return false;

    const claimedEventIds = new Set(
      claimed.flatMap((item) => {
        const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
        return safeItem ? [safeItem.event_id] : [];
      })
    );
    const seenEventIds = new Set<string>();
    const merged = [
      ...remaining,
      ...activeQueue.items.filter((item) => {
        const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
        return !safeItem || !claimedEventIds.has(safeItem.event_id);
      }),
    ].flatMap((item) => {
      const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
      if (!safeItem || seenEventIds.has(safeItem.event_id)) return [];
      seenEventIds.add(safeItem.event_id);
      return [safeItem];
    });

    if (!writeQueueFile(activePath, merged)) return false;
    try {
      if (existsSync(inflightPath)) unlinkSync(inflightPath);
      return true;
    } catch {
      return false;
    }
  });
}

function sanitizeDiagnosticsUploadForEgress(
  payload: unknown,
  appDataPath: string = app.getPath('userData')
): DiagnosticsUploadPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  const kind = isDiagnosticsKind(candidate.kind) ? candidate.kind : null;
  const appVersion = boundedString(candidate.app_version, 64);
  const platformInfo = boundedRedactedString(candidate.platform_info, 256);
  const installId = boundedString(candidate.install_id, 128);
  const needsRuntimeFallback =
    candidate.telemetry_actor === undefined || candidate.desktop_release_channel === undefined;
  const runtimeFallback = needsRuntimeFallback
    ? diagnosticsTelemetryProperties(appDataPath)
    : undefined;
  const telemetryActor =
    candidate.telemetry_actor === undefined
      ? runtimeFallback?.telemetry_actor
      : normalizeTelemetryActor(candidate.telemetry_actor);
  const releaseChannelCandidate =
    candidate.desktop_release_channel === undefined
      ? runtimeFallback?.desktop_release_channel
      : boundedString(candidate.desktop_release_channel, 32);
  const desktopReleaseChannel =
    releaseChannelCandidate && DESKTOP_RELEASE_CHANNELS.has(releaseChannelCandidate)
      ? releaseChannelCandidate
      : undefined;
  const timestamp = boundedString(candidate.timestamp, 64);
  if (
    candidate.schema !== 1 ||
    !kind ||
    !appVersion ||
    !platformInfo ||
    !installId ||
    !telemetryActor ||
    !desktopReleaseChannel ||
    !timestamp
  ) {
    return null;
  }

  const files = Array.isArray(candidate.files)
    ? candidate.files.slice(0, 8).flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const file = value as Record<string, unknown>;
        const name = boundedRedactedString(file.name, 128);
        const content = boundedRedactedString(file.content, MAX_FILE_CHARS, true);
        return name !== undefined && content !== undefined ? [{ name, content }] : [];
      })
    : undefined;

  const attemptId = boundedString(candidate.attempt_id, 128);
  const downloadId = boundedString(candidate.download_id, 64);
  const ciRunId = telemetryActor === 'ci' ? sanitizeCiRunId(candidate.ci_run_id) : undefined;
  const telemetryActorAssertion = boundedString(candidate.telemetry_actor_assertion, 2_048);
  const desktopBuildTag = boundedString(candidate.desktop_build_tag, 64);
  const errorClass = boundedString(candidate.error_class, 256);
  const summary = boundedRedactedString(candidate.summary, 2_000);
  const userAgent = boundedRedactedString(candidate.user_agent, 256);
  const eventIdCandidate = boundedString(candidate.event_id, 64)?.toLowerCase();
  if (eventIdCandidate && !EVENT_ID_RE.test(eventIdCandidate)) return null;
  const eventId = eventIdCandidate ?? legacyDiagnosticsEventId(candidate);

  return {
    schema: 1,
    event_id: eventId,
    kind,
    app_version: appVersion,
    platform_info: platformInfo,
    install_id: installId,
    telemetry_actor: telemetryActor,
    ...(typeof candidate.is_synthetic === 'boolean'
      ? { is_synthetic: candidate.is_synthetic }
      : {}),
    ...(telemetryActorAssertion && isTelemetryActorAssertionToken(telemetryActorAssertion)
      ? { telemetry_actor_assertion: telemetryActorAssertion }
      : {}),
    desktop_release_channel: desktopReleaseChannel,
    timestamp,
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...(downloadId && DOWNLOAD_ID_RE.test(downloadId) ? { download_id: downloadId } : {}),
    ...(ciRunId ? { ci_run_id: ciRunId } : {}),
    ...(desktopBuildTag ? { desktop_build_tag: desktopBuildTag } : {}),
    ...(errorClass ? { error_class: normalizeErrorClass(errorClass) } : {}),
    ...(summary ? { summary } : {}),
    ...(files ? { files } : {}),
    ...(userAgent ? { user_agent: userAgent } : {}),
  };
}

function isDiagnosticsKind(value: unknown): value is DiagnosticsKind {
  return (
    value === 'crash' ||
    value === 'boot_failure' ||
    value === 'log_bundle' ||
    value === 'boot_ok' ||
    value === 'renderer_error'
  );
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function boundedRedactedString(
  value: unknown,
  maxLength: number,
  keepTail: boolean = false
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const redacted = redactTelemetryText(value);
  return keepTail ? redacted.slice(-maxLength) : redacted.slice(0, maxLength);
}

function isRetriableDiagnosticsStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function diagnosticsTelemetryProperties(appDataPath: string): {
  telemetry_actor: TelemetryActor;
  is_synthetic?: boolean;
  telemetry_actor_assertion?: string;
  ci_run_id?: string;
  desktop_build_tag?: string;
  desktop_release_channel: string;
} {
  const dimensions = resolveTelemetryRuntimeDimensions({}, appDataPath);
  const assertion = boundedString(process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION, 2_048);
  return {
    telemetry_actor: dimensions.telemetryActor,
    is_synthetic: dimensions.isSynthetic,
    ...(assertion && isTelemetryActorAssertionToken(assertion)
      ? { telemetry_actor_assertion: assertion }
      : {}),
    ...(dimensions.ciRunId ? { ci_run_id: dimensions.ciRunId } : {}),
    ...(dimensions.buildTag ? { desktop_build_tag: dimensions.buildTag } : {}),
    desktop_release_channel: dimensions.releaseChannel,
  };
}

function collectLogFiles(
  userDataPath: string,
  kind?: DiagnosticsKind
): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = [];
  const bootPath = getBootLogPath() || join(userDataPath, 'logs', 'main-boot.log');
  const bootTail = readLogTail(bootPath, MAX_FILE_CHARS);
  if (bootTail) files.push({ name: 'main-boot.log', content: bootTail });

  const installInUserData = join(userDataPath, 'logs', 'install.log');
  const installSource = existsSync(installInUserData)
    ? installInUserData
    : resolveWindowsInstallLogPath();
  if (installSource) {
    const installTail = readLogTail(installSource, MAX_FILE_CHARS);
    if (installTail) files.push({ name: 'install.log', content: installTail });
  }

  const clientLog = join(userDataPath, 'logs', 'client.log');
  const clientTail = readLogTail(clientLog, MAX_FILE_CHARS);
  if (clientTail) files.push({ name: 'client.log', content: clientTail });

  if (kind === 'crash' || kind === 'boot_failure') {
    const breadcrumbsLog = join(userDataPath, 'logs', 'renderer-breadcrumbs.log');
    const breadcrumbsTail = readLogTail(breadcrumbsLog, MAX_FILE_CHARS);
    if (breadcrumbsTail) files.push({ name: 'renderer-breadcrumbs.log', content: breadcrumbsTail });
  }

  return files.map((file) => ({ name: file.name, content: redactTelemetryText(file.content) }));
}

type DiagnosticsUploadInput = Omit<
  DiagnosticsUploadPayload,
  | 'timestamp'
  | 'event_id'
  | 'install_id'
  | 'app_version'
  | 'platform_info'
  | 'schema'
  | 'user_agent'
  | 'telemetry_actor'
  | 'is_synthetic'
  | 'telemetry_actor_assertion'
  | 'ci_run_id'
  | 'desktop_build_tag'
  | 'desktop_release_channel'
> &
  Partial<Pick<DiagnosticsUploadPayload, 'install_id' | 'app_version' | 'platform_info'>>;

function prepareDiagnosticsUpload(
  payload: DiagnosticsUploadInput,
  appDataPath: string,
  installIdentity: InstallIdentitySnapshot
) {
  if (isCommunityBuild()) return null;
  if (app.isPackaged && isTelemetryEgressSuppressed({}, appDataPath)) {
    return null;
  }
  const consent = payload.kind === 'log_bundle' ? 'allowed' : getTelemetryConsent();
  if (consent === 'denied') return null;
  try {
    mkdirSync(appDataPath, { recursive: true });
  } catch {
    return null;
  }
  const full = sanitizeDiagnosticsUploadForEgress(
    {
      schema: 1,
      event_id: randomUUID(),
      kind: payload.kind,
      app_version: payload.app_version ?? app.getVersion(),
      platform_info: payload.platform_info ?? `${process.platform} ${process.arch}`,
      install_id: payload.install_id ?? getInstallId(appDataPath),
      attempt_id: payload.attempt_id ?? installIdentity.attemptId,
      download_id: payload.download_id ?? installIdentity.downloadId,
      ...diagnosticsTelemetryProperties(appDataPath),
      error_class: payload.error_class ? normalizeErrorClass(payload.error_class) : undefined,
      summary: payload.summary,
      files:
        payload.files ??
        (payload.kind === 'boot_ok' ? [] : collectLogFiles(appDataPath, payload.kind)),
      user_agent: `DNAForge/${app.getVersion()} Electron`,
      timestamp: new Date().toISOString(),
    },
    appDataPath
  );
  return full ? { payload: full, consent } : null;
}

async function postDiagnosticUpload(
  full: DiagnosticsUploadPayload
): Promise<'accepted' | 'retry' | 'rejected'> {
  try {
    const res = await fetch(uploadUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(full),
    });
    if (res.ok) return 'accepted';
    return isRetriableDiagnosticsStatus(res.status) ? 'retry' : 'rejected';
  } catch {
    return 'retry';
  }
}

export async function sendDiagnosticsUpload(
  payload: DiagnosticsUploadInput,
  appDataPath: string = app.getPath('userData'),
  installIdentity: InstallIdentitySnapshot = readInstallIdentitySnapshot(appDataPath)
): Promise<{ success: boolean; queued?: boolean }> {
  const prepared = prepareDiagnosticsUpload(payload, appDataPath, installIdentity);
  if (!prepared) return { success: false };
  if (prepared.consent === 'unknown') {
    return (await enqueue(appDataPath, prepared.payload))
      ? { success: false, queued: true }
      : { success: false };
  }
  const result = await postDiagnosticUpload(prepared.payload);
  if (result === 'accepted') return { success: true };
  if (result === 'retry') {
    return (await enqueue(appDataPath, prepared.payload))
      ? { success: false, queued: true }
      : { success: false };
  }
  return { success: false };
}

export async function persistStartupFailure(
  errorClass: 'bootstrap_error' | 'startup_error' | 'forced_boot_failure'
): Promise<boolean> {
  if (!app.isPackaged) return false;
  const appDataPath = app.getPath('userData');
  const prepared = prepareDiagnosticsUpload(
    {
      kind: 'boot_failure',
      error_class: errorClass,
      summary:
        errorClass === 'forced_boot_failure'
          ? 'ci_forced_boot_failure'
          : 'bootstrap_startup_failed',
      files: [],
    },
    appDataPath,
    readInstallIdentitySnapshot(appDataPath)
  );
  if (!prepared) return false;
  const persisted = await enqueue(appDataPath, prepared.payload);
  if (persisted) void flushPendingDiagnosticsBatch(appDataPath, true).catch(() => undefined);
  return persisted;
}

export async function flushPendingDiagnostics(
  appDataPath: string = app.getPath('userData')
): Promise<void> {
  await flushPendingDiagnosticsBatch(appDataPath, false);
}

async function flushPendingDiagnosticsBatch(
  appDataPath: string,
  includeActiveWithRecoveredClaim: boolean
): Promise<void> {
  if (isCommunityBuild()) return;
  if (app.isPackaged && isTelemetryEgressSuppressed({}, appDataPath)) return;
  const consent = getTelemetryConsent();
  if (consent === 'unknown') return;
  if (consent === 'denied') {
    await discardPendingQueue(appDataPath);
    return;
  }
  const queuePath = join(appDataPath, QUEUE_FILE);
  await serializePerPath(queueFlushTails, queuePath, async () => {
    const claim = await claimPendingQueue(appDataPath, includeActiveWithRecoveredClaim);
    if (claim.status !== 'claimed') return;

    const remaining: DiagnosticsUploadPayload[] = [];
    for (const item of claim.items) {
      const safeItem = sanitizeDiagnosticsUploadForEgress(item, appDataPath);
      if (!safeItem) continue;
      try {
        const res = await fetch(uploadUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(safeItem),
        });
        if (!res.ok && isRetriableDiagnosticsStatus(res.status)) remaining.push(safeItem);
      } catch {
        remaining.push(safeItem);
      }
    }
    await persistClaimRemainder(appDataPath, claim.items, remaining);
  });
}

export async function sendAppBootBeacon(
  appDataPath: string = app.getPath('userData'),
  installIdentity: InstallIdentitySnapshot = readInstallIdentitySnapshot(appDataPath)
): Promise<void> {
  if (isCommunityBuild()) return;
  if (app.isPackaged && isTelemetryEgressSuppressed({}, appDataPath)) return;
  if (getTelemetryConsent() !== 'allowed') return;
  const installId = getInstallId(appDataPath);
  const body = JSON.stringify({
    schema: 1,
    event_id: randomUUID(),
    event: 'app_boot',
    app_version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    install_id: installId,
    attempt_id: installIdentity.attemptId,
    download_id: installIdentity.downloadId,
    ...diagnosticsTelemetryProperties(appDataPath),
  });

  for (let attempt = 1; attempt <= APP_BOOT_BEACON_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(beaconUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (response.ok || !isRetriableDiagnosticsStatus(response.status)) return;
    } catch {
      void 0;
    }
    if (attempt < APP_BOOT_BEACON_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}

export function startDiagnosticsPhoneHome(): void {
  try {
    const userData = app.getPath('userData');
    mkdirSync(join(userData, 'logs'), { recursive: true });
    initBootLog(userData);
    appendBootLog(app.isPackaged ? 'packaged_boot_start' : 'dev_boot_start');
    const copied = copyInstallLogIntoUserData(userData);
    if (copied) appendBootLog(`install_log_copied`);
    else appendBootLog('install_log_absent');

    if (!app.isPackaged) {
      appendBootLog('diagnostics_phone_home_skipped_dev');
      return;
    }

    onTelemetryConsentChange((consent) => {
      if (consent !== 'unknown') void flushPendingDiagnostics(userData).catch(() => {});
    });
    void flushPendingDiagnostics(userData).catch(() => {});
  } catch (err) {
    try {
      appendBootLog(
        `startDiagnosticsPhoneHome_failed ${err instanceof Error ? err.message : 'unknown'}`
      );
    } catch {
      void 0;
    }
  }
}

export function notifyBootSucceeded(
  outcome: 'shell_usable' | 'recovery_window' = 'shell_usable'
): void {
  if (!app.isPackaged) return;
  const userData = app.getPath('userData');
  if (getTelemetryConsent() === 'denied') {
    appendBootLog('boot_phone_home_skipped_consent');
    const stopObserving = onTelemetryConsentChange((consent) => {
      if (consent !== 'allowed') return;
      stopObserving();
      notifyBootSucceeded(outcome);
    });
    return;
  }
  void (async () => {
    const installIdentity = readInstallIdentitySnapshot(userData);
    let consentRevoked = false;
    const stopObserving = onTelemetryConsentChange((consent) => {
      if (consent === 'denied') consentRevoked = true;
    });
    try {
      const prepared = prepareDiagnosticsUpload(
        {
          kind: 'boot_ok',
          summary:
            outcome === 'shell_usable' ? 'packaged_shell_usable' : 'packaged_recovery_window_ready',
        },
        userData,
        installIdentity
      );
      if (!prepared || !(await enqueue(userData, prepared.payload))) {
        appendBootLog('boot_ok_delivery_failed');
        await sendAppBootBeacon(userData, installIdentity);
        return;
      }
      appendBootLog('boot_beacon_send');
      await sendAppBootBeacon(userData, installIdentity);
      if (consentRevoked || getTelemetryConsent() === 'denied') {
        await removePendingDiagnostic(userData, prepared.payload.event_id);
        appendBootLog('boot_phone_home_skipped_consent');
        return;
      }
      let result: { success: boolean; queued?: boolean };
      if (getTelemetryConsent() === 'unknown' || isTelemetryEgressSuppressed({}, userData)) {
        result = { success: false, queued: await enqueue(userData, prepared.payload) };
      } else {
        const delivery = await postDiagnosticUpload(prepared.payload);
        if (consentRevoked || getTelemetryConsent() === 'denied') {
          await removePendingDiagnostic(userData, prepared.payload.event_id);
          appendBootLog('boot_phone_home_skipped_consent');
          return;
        }
        if (delivery === 'retry') {
          result = { success: false, queued: await enqueue(userData, prepared.payload) };
        } else {
          await removePendingDiagnostic(userData, prepared.payload.event_id);
          result = { success: delivery === 'accepted' };
        }
      }
      if (result.success || result.queued) {
        consumeInstallIdentitySnapshot(userData, installIdentity);
        appendBootLog(result.success ? 'boot_ok_sent' : 'boot_ok_queued');
      } else {
        appendBootLog('boot_ok_delivery_failed');
      }
    } finally {
      stopObserving();
    }
  })().catch((err) => {
    appendBootLog(`boot_phone_home_error ${err instanceof Error ? err.message : 'unknown'}`);
  });
}

export function reportBootOrCrashFailure(
  errorClass: string,
  kind: 'crash' | 'boot_failure' = 'crash',
  summary?: string
): void {
  void reportBootOrCrashFailureAsync(errorClass, kind, summary);
}

export async function reportBootOrCrashFailureAsync(
  errorClass: string,
  kind: 'crash' | 'boot_failure' = 'crash',
  summary?: string
): Promise<void> {
  try {
    appendBootLog(`failure kind=${kind} error_class=${errorClass}`);
  } catch {
    void 0;
  }
  if (!app.isPackaged) return;
  await sendDiagnosticsUpload({
    kind,
    error_class: normalizeErrorClass(errorClass),
    summary: summary ?? errorClass,
  });
}

export function reportRendererErrorSignal(errorClass: string, summary: string): void {
  if (!app.isPackaged) return;
  void sendDiagnosticsUpload({
    kind: 'renderer_error',
    error_class: normalizeErrorClass(errorClass),
    summary,
    files: [],
  });
}

export async function maybeForceBootFailureAndExit(): Promise<boolean> {
  if (!app.isPackaged) return false;
  if (process.env.DNAFORGE_DIAGNOSTICS_FORCE_BOOT_FAILURE !== '1') return false;
  appendBootLog('forced_boot_failure_inject');
  await persistStartupFailure('forced_boot_failure');
  const pendingFlush =
    queueFlushTails.get(join(app.getPath('userData'), QUEUE_FILE)) ?? Promise.resolve();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pendingFlush.catch(() => undefined),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 500);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  app.exit(42);
  return true;
}

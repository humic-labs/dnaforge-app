export { readBetaUpdatesSetting } from './update-preferences';
import { updateContract } from '../shared/ipc/update.contract';
import {
  handleGroup,
  mainIpc,
  sendRendererIpc,
  type MainSendArguments,
  type MainSendChannel,
} from '../shared/ipc-contract';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { BrowserWindow, app, net, powerMonitor, autoUpdater as nativeMacUpdater } from 'electron';
import type Database from 'better-sqlite3';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as nextMainTurn } from 'node:timers/promises';
import { trackEvent } from './analytics';
import { readCurrentDirtyState } from './dirty-state-cache';
import { getInstallId } from './ipc/feedback';
import { setQuitConsentGranted, showUnsavedWorkDialog } from './quit-consent';
import type { CheckErrorReason } from '../shared/update-types';
import type { UpdateInstallResult } from '../shared/update-ipc';
import type { VerifyUpdateSupport } from 'electron-updater';
import {
  isUpdateOriginFailoverEligible,
  isMacTeamIdCutoverBuild,
  isValidationAppIdentity,
  resolveUpdateFeedUrls,
} from './update-authority';
import { resolveExactCiRolloutDecision } from './update-rollout';
import { checkAndDownloadStartupUpdate } from './startup-update-downloader';
import { runSchemaUpdateRecovery, type SchemaUpdateRecoveryResult } from './schema-update-recovery';
import type { SchemaVersionTooNewError } from './native-module-error';
import { appendBootLog } from './boot-log';
import { isCommunityBuild } from './distribution';
import { redactSensitive } from '../shared/redact-sensitive';
import { randomUUID } from 'node:crypto';
import { UpdateDownloadEpisodes } from './update-download-episode';
import {
  UPDATE_BOOT_ID,
  createUpdateInstallMeasurement,
  parseUpdateInstallMeasurement,
  isUpdateInstallMeasurementPermitted,
  isUpdateDownloadMeasurementPermitted,
  recordUpdateDownloadMeasurement,
  recordUpdateInstallMeasurement,
  type UpdateInstallMeasurement,
} from './update-install-telemetry';

export {
  isUpdateOriginFailoverEligible,
  isMacTeamIdCutoverBuild,
  isValidationAppIdentity,
  shouldDisableAutoUpdaterForMacTeamIdCutover,
  resolveUpdateFeedUrl,
  resolveUpdateFeedUrls,
} from './update-authority';
export { resolveExactCiRolloutDecision } from './update-rollout';

export type { CheckErrorReason };

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 30 * 1000;
const MAX_CHECK_BACKOFF_MS = 6 * 60 * 60 * 1000;
const STALE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;
const AUTO_RESTART_IDLE_SECONDS = 30 * 60;

const FORCE_UPDATER = process.env.WAYPOINT_FORCE_UPDATER === '1';
const TEST_INITIAL_DELAY_MS = 3_000;

let updateDownloaded = false;
let downloadedAtMs: number | null = null;
let automaticRestartVersion: string | null = null;
let downloadedVersion = '';
let downloadedCandidateFingerprint = '';
let activeUpdateVersion = '';
let latestDownloadProgress: { percent: number; bytesPerSecond: number } | null = null;
let downloadStartedAt = 0;
let downloadEpisodes = new UpdateDownloadEpisodes();
let updaterDatabase: Database.Database | undefined;

function downloadTelemetryProperties<T extends { operation_id: string }>(
  properties: T | null
): T | Record<string, never> {
  return properties &&
    isUpdateDownloadMeasurementPermitted(updaterDatabase, properties.operation_id)
    ? properties
    : {};
}

function downloadTelemetryParent(operationId: string | undefined): {
  download_operation_id?: string;
} {
  return isUpdateDownloadMeasurementPermitted(updaterDatabase, operationId)
    ? { download_operation_id: operationId }
    : {};
}
type DownloadedUpdateCandidate = Readonly<{ version: string; fingerprint: string }>;
let acceptedInstallIntent: UpdateInstallIntent | null = null;
let installCandidate: DownloadedUpdateCandidate | null = null;
let restartRequestId: string | undefined;
let previousInstallAttempt:
  | { measurement: UpdateInstallMeasurement; targetVersion: string }
  | undefined;
type UpdaterPhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'installing' | 'failed';
let updaterPhase: UpdaterPhase = 'idle';
let mainWindowRef: BrowserWindow | null = null;
let quitAndInstallCalled = false;
let manualCheckInProgress = false;
let manualCheckTimer: ReturnType<typeof setTimeout> | null = null;
let cancelNativePreparation: (() => void) | null = null;
let nativePreparationCandidate = '';
let nativePreparedCandidate = '';
let macNativePreparationStarted = false;
interface CheckAttemptState {
  terminalRecorded: boolean;
  deferredError: unknown | null;
  operationId: string;
  startedAtMs: number;
}
const checkRetryState = { networkFailures: 0, backgroundFailures: 0 };
let scheduleBackgroundCheck: ((delay: number) => void) | null = null;

function resetCheckRetryState(): void {
  checkRetryState.networkFailures = 0;
  checkRetryState.backgroundFailures = 0;
}

function nextBackgroundCheckDelay(): number {
  return Math.min(
    CHECK_INTERVAL_MS * 2 ** Math.min(Math.max(0, checkRetryState.networkFailures - 1), 6),
    MAX_CHECK_BACKOFF_MS
  );
}

let activeCheckAttempt: CheckAttemptState | null = null;
let inFlightCheck: { attempt: CheckAttemptState; promise: Promise<void> } | null = null;
let configuredUpdateFeedUrls: string[] = [];
let selectedUpdateFeedIndex = -1;
let expectedDownloadedCandidate = '';
interface FallbackDownloadAttempt {
  generation: number;
  expectedCandidate: string;
  deferredError: unknown | null;
  terminalRecorded: boolean;
}
let fallbackDownloadAttempt: FallbackDownloadAttempt | null = null;
let fallbackDownloadGeneration = 0;
const MANUAL_CHECK_TIMEOUT_MS = 60_000;
const LAST_APP_VERSION_SETTING = '_last_app_version';
const DOWNLOADED_UPDATE_TARGET_SETTING = '_downloaded_update_target';
const LEGACY_UNMARKED_UPDATE_BRIDGE_SETTING = '_legacy_unmarked_update_bridge_consumed';
const INSTALL_INTENT_FILENAME = 'update-install-intent.json';
const INSTALL_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INSTALL_INTENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SCHEMA_UPDATE_RECOVERY_RECEIPT_ENV = 'DNAFORGE_E2E_SCHEMA_UPDATE_RECOVERY_PATH';
const SCHEMA_UPDATE_E2E_TARGET_VERSION = '999999.0.0';

interface UpdateInstallIntent {
  fromVersion: string;
  targetVersion: string;
  attemptedAt: number;
  measurement?: UpdateInstallMeasurement;
}

export interface StartSchemaUpdateRecoveryInput {
  error: SchemaVersionTooNewError;
  closeDatabase: () => void;
  flushFatalDiagnostics: () => Promise<void>;
  openCurrentInstaller: () => void;
}

let pendingInstallRecovery: UpdateInstallIntent | null = null;

interface UpdateErrorPayload {
  message: string;
  stage: 'check' | 'download' | 'install';
  operation?: 'native-preparation';
  isManual: boolean;
  reason?: CheckErrorReason;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function installIntentPath(): string {
  return join(app.getPath('userData'), INSTALL_INTENT_FILENAME);
}

function parseInstallIntent(serialized: string): UpdateInstallIntent | null {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object') return null;
  if (
    !('fromVersion' in value) ||
    typeof value.fromVersion !== 'string' ||
    !value.fromVersion ||
    !('targetVersion' in value) ||
    typeof value.targetVersion !== 'string' ||
    !value.targetVersion ||
    !('attemptedAt' in value) ||
    typeof value.attemptedAt !== 'number' ||
    !Number.isFinite(value.attemptedAt) ||
    value.attemptedAt <= 0
  ) {
    return null;
  }
  return {
    fromVersion: value.fromVersion,
    targetVersion: value.targetVersion,
    attemptedAt: value.attemptedAt,
    ...('measurement' in value
      ? { measurement: parseUpdateInstallMeasurement(value.measurement) }
      : {}),
  };
}

function readInstallIntent(): UpdateInstallIntent | null {
  try {
    const intent = parseInstallIntent(readFileSync(installIntentPath(), 'utf8'));
    const now = Date.now();
    if (
      !intent ||
      intent.attemptedAt > now + INSTALL_INTENT_CLOCK_SKEW_MS ||
      now - intent.attemptedAt > INSTALL_INTENT_MAX_AGE_MS
    ) {
      clearInstallIntent();
      return null;
    }
    return intent;
  } catch {
    try {
      clearInstallIntent();
    } catch {}
    return null;
  }
}

function readInstallTelemetryReceipt(): UpdateInstallIntent | null {
  try {
    const intent = parseInstallIntent(readFileSync(installIntentPath(), 'utf8'));
    const now = Date.now();
    return intent &&
      intent.attemptedAt <= now + INSTALL_INTENT_CLOCK_SKEW_MS &&
      now - intent.attemptedAt <= INSTALL_INTENT_MAX_AGE_MS
      ? intent
      : null;
  } catch {
    return null;
  }
}

function persistInstallIntent(intent: UpdateInstallIntent): void {
  const destination = installIntentPath();
  const temporary = `${destination}.tmp-${process.pid}`;
  let temporaryFd: number | null = null;
  try {
    temporaryFd = openSync(temporary, 'w', 0o600);
    writeFileSync(temporaryFd, `${JSON.stringify(intent)}\n`, { encoding: 'utf8' });
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = null;
    renameSync(temporary, destination);

    if (process.platform !== 'win32') {
      const directoryFd = openSync(dirname(destination), fsConstants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  } catch (error) {
    if (temporaryFd !== null) {
      try {
        closeSync(temporaryFd);
      } catch {}
    }
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function clearInstallIntent(): void {
  try {
    unlinkSync(installIntentPath());
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function consumeNestedDownloadRejection(
  result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
): void {
  if (!result?.downloadPromise) return;
  void result.downloadPromise.catch(() => undefined);
}

function updateCandidateFingerprint(info: unknown): string {
  if (!info || typeof info !== 'object') return '';
  const record = info as Record<string, unknown>;
  if (typeof record.version !== 'string' || !Array.isArray(record.files)) return '';
  const digests = record.files.map((file) => {
    if (!file || typeof file !== 'object') return '';
    const descriptor = file as Record<string, unknown>;
    if (typeof descriptor.sha512 !== 'string' || !descriptor.sha512) return '';
    const size = typeof descriptor.size === 'number' ? descriptor.size : 0;
    return `${descriptor.sha512}:${size}`;
  });
  if (digests.length === 0 || digests.some((digest) => !digest)) return '';
  return JSON.stringify({ version: record.version, digests: digests.sort() });
}

function reportTerminalDownloadFailure(
  error: unknown,
  operation: 'download' | 'native-preparation' = 'download'
): void {
  const payload = buildUpdateErrorPayload(error, 'download', false, operation);
  console.error(
    '[AutoUpdater] download error after exhausting sealed authorities:',
    payload.message
  );
  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    sendRendererIpc(win.webContents, 'update:error', payload);
  }
  trackEvent('app_update_error', {
    feature_area: 'reliability',
    error_class: 'update_download_failed',
    ...downloadTelemetryProperties(downloadEpisodes.fail(Date.now())),
    error_code: 'unknown',
    stage: 'download',
    reason: 'unknown',
    manual: false,
    ...(activeUpdateVersion ? { version: activeUpdateVersion } : {}),
  });
  updaterPhase = 'failed';
}

function reportTerminalInstallFailure(error: unknown): void {
  recordUpdateInstallOutcome('failed', 'native_install_failed');
  const payload = buildUpdateErrorPayload(error, 'install', false);
  console.error('[AutoUpdater] native install error:', payload.message);
  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    sendRendererIpc(win.webContents, 'update:error', payload);
  }
  trackEvent('app_update_error', {
    feature_area: 'reliability',
    error_class: 'update_install_failed',
    error_code: 'unknown',
    stage: 'install',
    reason: 'unknown',
    manual: false,
    ...(downloadedVersion ? { version: downloadedVersion } : {}),
  });
  quitAndInstallCalled = false;
  updaterPhase = 'failed';
}

async function runFallbackDownload(
  startOriginIndex: number,
  expectedGeneration: number
): Promise<void> {
  const attempt = fallbackDownloadAttempt;
  if (!attempt || attempt.generation !== expectedGeneration || attempt.terminalRecorded) {
    return;
  }
  const previousAutoDownload = autoUpdater.autoDownload;
  autoUpdater.autoDownload = false;
  try {
    for (
      let originIndex = startOriginIndex;
      originIndex < configuredUpdateFeedUrls.length;
      originIndex += 1
    ) {
      if (
        fallbackDownloadAttempt !== attempt ||
        attempt.terminalRecorded ||
        attempt.generation !== expectedGeneration
      ) {
        return;
      }
      selectUpdateFeed(originIndex);
      attempt.deferredError = null;
      updaterPhase = 'checking';
      try {
        const result = await autoUpdater.checkForUpdates();
        if (
          fallbackDownloadAttempt !== attempt ||
          attempt.terminalRecorded ||
          attempt.generation !== expectedGeneration
        ) {
          return;
        }
        consumeNestedDownloadRejection(result);
        const actualCandidate = updateCandidateFingerprint(result?.updateInfo);
        if (!actualCandidate || actualCandidate !== attempt.expectedCandidate) {
          throw new Error(
            `Fallback update authority ${originIndex + 1} disagrees with the original version and SHA-512 identity`
          );
        }
        updaterPhase = 'downloading';
        await autoUpdater.downloadUpdate();
        return;
      } catch (error: unknown) {
        if (
          fallbackDownloadAttempt !== attempt ||
          attempt.terminalRecorded ||
          attempt.generation !== expectedGeneration
        ) {
          return;
        }
        const failure = attempt.deferredError ?? error;
        const hasFallback = originIndex + 1 < configuredUpdateFeedUrls.length;
        if (hasFallback && isUpdateOriginFailoverEligible(failure)) {
          trackEvent('app_update_origin_failed', {
            feature_area: 'reliability',
            origin_index: originIndex,
            stage: 'download',
          });
          continue;
        }
        reportTerminalDownloadFailure(failure);
        return;
      }
    }
  } finally {
    autoUpdater.autoDownload = previousAutoDownload;
    if (fallbackDownloadAttempt === attempt) {
      fallbackDownloadAttempt = null;
    }
  }
}

export function classifyCheckErrorReason(message: string): CheckErrorReason {
  if (/ENOENT|app-update\.ya?ml|dev-app-update\.ya?ml|no such file or directory/i.test(message)) {
    return 'no-manifest';
  }
  if (
    /ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo|fetch|network|timeout|timed out|socket hang up|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED/i.test(
      message
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

function buildUpdateErrorPayload(
  err: unknown,
  stage: 'check' | 'download' | 'install',
  isManual: boolean,
  operation: 'check' | 'download' | 'install' | 'native-preparation' = stage
): UpdateErrorPayload {
  const message = getErrorMessage(err);
  appendBootLog(
    `update_failure ${JSON.stringify({
      stage,
      operation,
      targetVersion: activeUpdateVersion || downloadedVersion || null,
      authorityIndex: selectedUpdateFeedIndex,
      phase: updaterPhase,
      percent: latestDownloadProgress?.percent ?? null,
      message: redactSensitive(message.replace(/https?:\/\/[^\s"'<>]+/g, '[update-url]')).slice(
        0,
        2048
      ),
    })}`
  );
  return {
    message,
    stage,
    isManual,
    ...(operation === 'native-preparation' ? { operation } : {}),
    ...(stage === 'check' ? { reason: classifyCheckErrorReason(message) } : {}),
  };
}

function consumeManualCheckFlag(): boolean {
  const wasManual = manualCheckInProgress;
  manualCheckInProgress = false;
  if (manualCheckTimer) {
    clearTimeout(manualCheckTimer);
    manualCheckTimer = null;
  }
  return wasManual;
}

function beginManualCheck(): void {
  manualCheckInProgress = true;
  if (manualCheckTimer) clearTimeout(manualCheckTimer);
  manualCheckTimer = setTimeout(() => {
    manualCheckInProgress = false;
    manualCheckTimer = null;
  }, MANUAL_CHECK_TIMEOUT_MS);
}

function beginTrackedCheckAttempt(manual: boolean): CheckAttemptState {
  const attempt = {
    terminalRecorded: false,
    deferredError: null,
    operationId: randomUUID(),
    startedAtMs: Date.now(),
  };
  activeCheckAttempt = attempt;
  trackEvent('app_update_check_started', {
    feature_area: 'reliability',
    operation_id: attempt.operationId,
    occurred_at_ms: attempt.startedAtMs,
    manual,
  });
  return attempt;
}

function updateWaitingMinutes(): number | undefined {
  if (!updateDownloaded || downloadedAtMs === null) return undefined;
  return Math.max(0, Math.floor((Date.now() - downloadedAtMs) / 60_000));
}

function isOnline(): boolean | undefined {
  try {
    return typeof net.isOnline === 'function' ? net.isOnline() : undefined;
  } catch {
    return undefined;
  }
}

function updateStateProperties(): Record<string, boolean | number> {
  const online = isOnline();
  const waiting = updateWaitingMinutes();
  return {
    ...(online === undefined ? {} : { online }),
    ...(waiting === undefined ? {} : { update_waiting_minutes: waiting }),
  };
}

function checkAttemptProperties(): Record<string, string | number> {
  return activeCheckAttempt
    ? {
        operation_id: activeCheckAttempt.operationId,
        origin_started_at_ms: activeCheckAttempt.startedAtMs,
        occurred_at_ms: Date.now(),
      }
    : {};
}

function selectUpdateFeed(index: number): void {
  const url = configuredUpdateFeedUrls[index];
  if (!url) throw new Error(`Desktop update authority index ${index} is unavailable`);
  if (selectedUpdateFeedIndex === index) return;
  selectedUpdateFeedIndex = index;
  console.log(`[AutoUpdater] Feed ${index + 1}/${configuredUpdateFeedUrls.length}:`, url);
  autoUpdater.setFeedURL({ provider: 'generic', url });
}

function claimCheckTerminal(attempt: CheckAttemptState | null): boolean {
  if (!attempt) return true;
  if (attempt.terminalRecorded) return false;
  attempt.terminalRecorded = true;
  return true;
}

function recordCheckFailureTelemetry(err: unknown, isManual: boolean): UpdateErrorPayload {
  const payload = buildUpdateErrorPayload(err, 'check', isManual);
  const reason = payload.reason ?? 'unknown';
  const errorCode = reason === 'no-manifest' ? 'no_manifest' : reason;
  if (!isManual) {
    checkRetryState.networkFailures =
      reason === 'network' ? checkRetryState.networkFailures + 1 : 0;
    checkRetryState.backgroundFailures += 1;
  }
  if (isManual || checkRetryState.backgroundFailures === 1) {
    trackEvent('app_update_error', {
      feature_area: 'reliability',
      error_class: 'update_check_failed',
      error_code: errorCode,
      stage: 'check',
      reason,
      manual: isManual,
      streak_count: isManual ? 1 : checkRetryState.backgroundFailures,
      ...checkAttemptProperties(),
      ...updateStateProperties(),
    });
  }
  trackEvent('app_update_check_completed', {
    feature_area: 'reliability',
    success: false,
    manual: isManual,
    error_class: 'update_check_failed',
    error_code: errorCode,
    ...checkAttemptProperties(),
    ...updateStateProperties(),
  });
  return payload;
}

function runTrackedCheck(options: { manual: boolean; failureLabel: string }): Promise<void> {
  if (updaterPhase === 'downloading') {
    const win = mainWindowRef;
    if (options.manual && activeUpdateVersion && win && !win.isDestroyed()) {
      sendUpdateRendererIpc(win, 'update:available', {
        version: activeUpdateVersion,
        isManual: true,
      });
      if (latestDownloadProgress)
        sendUpdateRendererIpc(win, 'update:progress', latestDownloadProgress);
    }
    return Promise.resolve();
  }
  if (updaterPhase === 'installing') return Promise.resolve();
  if (updaterPhase === 'downloaded') {
    const win = mainWindowRef;
    if (options.manual && win && !win.isDestroyed()) {
      sendUpdateRendererIpc(win, 'update:downloaded', { version: downloadedVersion });
    }
    return Promise.resolve();
  }
  if (options.manual) beginManualCheck();
  if (inFlightCheck) return inFlightCheck.promise;

  const attempt = beginTrackedCheckAttempt(options.manual);
  const promise = Promise.resolve()
    .then(async () => {
      for (let originIndex = 0; originIndex < configuredUpdateFeedUrls.length; originIndex += 1) {
        selectUpdateFeed(originIndex);
        attempt.deferredError = null;
        updaterPhase = 'checking';
        try {
          const result = await autoUpdater.checkForUpdates();
          consumeNestedDownloadRejection(result);
          resetCheckRetryState();
          return;
        } catch (err: unknown) {
          const failure = attempt.deferredError ?? err;
          const hasFallback = originIndex + 1 < configuredUpdateFeedUrls.length;
          if (!attempt.terminalRecorded && hasFallback && isUpdateOriginFailoverEligible(failure)) {
            trackEvent('app_update_origin_failed', {
              feature_area: 'reliability',
              origin_index: originIndex,
              stage: 'check',
              manual: options.manual || manualCheckInProgress,
              ...checkAttemptProperties(),
            });
            console.warn(
              `[AutoUpdater] Authority ${originIndex + 1} failed; trying ${originIndex + 2}/${configuredUpdateFeedUrls.length}`
            );
            continue;
          }
          if (claimCheckTerminal(attempt)) {
            const isManual = consumeManualCheckFlag();
            const payload = recordCheckFailureTelemetry(failure, isManual);
            const win = mainWindowRef;
            if (isManual && win && !win.isDestroyed()) {
              sendRendererIpc(win.webContents, 'update:error', payload);
            }
          }
          console.error(`[AutoUpdater] ${options.failureLabel}:`, getErrorMessage(failure));
          return;
        }
      }
    })
    .finally(() => {
      if (inFlightCheck?.attempt === attempt) inFlightCheck = null;
    });
  inFlightCheck = { attempt, promise };
  return promise;
}

function runManualCheck(): Promise<void> {
  resetCheckRetryState();
  return runTrackedCheck({ manual: true, failureLabel: 'Manual check failed' }).finally(() => {
    scheduleBackgroundCheck?.(nextBackgroundCheckDelay());
  });
}

function runBackgroundCheck(failureLabel: string): Promise<void> {
  if (updaterPhase === 'downloaded') return maintainDownloadedUpdate();
  if (isOnline() === false) return Promise.resolve();
  return runTrackedCheck({ manual: false, failureLabel });
}

async function maintainDownloadedUpdate(): Promise<void> {
  if (downloadedAtMs === null || Date.now() - downloadedAtMs <= STALE_DOWNLOAD_MS) return;
  const version = downloadedVersion;
  const downloadedAt = downloadedAtMs;
  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    sendUpdateRendererIpc(win, 'update:downloaded', { version, restartRequired: true });
  }
  if (automaticRestartVersion === version) return;
  try {
    if (powerMonitor.getSystemIdleTime() <= AUTO_RESTART_IDLE_SECONDS) return;
    const dirty = await readCurrentDirtyState();
    if (
      dirty.hasDirtyWork ||
      updaterPhase !== 'downloaded' ||
      downloadedVersion !== version ||
      downloadedAtMs !== downloadedAt ||
      automaticRestartVersion === version ||
      powerMonitor.getSystemIdleTime() <= AUTO_RESTART_IDLE_SECONDS
    )
      return;
    automaticRestartVersion = version;
    app.quit();
  } catch (error) {
    console.error('[AutoUpdater] Deferred idle restart:', error);
  }
}

type UpdateRendererChannel = Extract<
  MainSendChannel,
  'update:available' | 'update:downloaded' | 'update:error' | 'update:no-update' | 'update:progress'
>;

function sendUpdateRendererIpc<C extends UpdateRendererChannel>(
  win: BrowserWindow,
  channel: C,
  ...args: MainSendArguments<C>
): void {
  if (!win.isDestroyed()) {
    sendRendererIpc(win.webContents, channel, ...args);
  }
}

function sendSimulatedUpdateRendererIpc(
  win: BrowserWindow,
  channel: string,
  payload: unknown
): void {
  switch (channel) {
    case 'update:available':
      return sendUpdateRendererIpc(
        win,
        channel,
        payload as MainSendArguments<'update:available'>[0]
      );
    case 'update:downloaded':
      return sendUpdateRendererIpc(
        win,
        channel,
        payload as MainSendArguments<'update:downloaded'>[0]
      );
    case 'update:error':
      return sendUpdateRendererIpc(win, channel, payload as MainSendArguments<'update:error'>[0]);
    case 'update:no-update':
      return sendUpdateRendererIpc(
        win,
        channel,
        payload as MainSendArguments<'update:no-update'>[0]
      );
    case 'update:progress':
      return sendUpdateRendererIpc(
        win,
        channel,
        payload as MainSendArguments<'update:progress'>[0]
      );
    default:
      return;
  }
}

export interface InitAutoUpdaterOptions {
  allowPrerelease?: boolean;
  database?: Database.Database;
}

let libraryRolloutDecision: VerifyUpdateSupport | null = null;

function configureExactCiRolloutDecision(): void {
  if (!libraryRolloutDecision) {
    const currentDecision = autoUpdater.isUserWithinRollout;
    if (typeof currentDecision !== 'function') {
      throw new Error('electron-updater rollout decision is unavailable');
    }
    libraryRolloutDecision = currentDecision;
  }
  const delegate = libraryRolloutDecision;
  autoUpdater.isUserWithinRollout = async (updateInfo) => {
    const decision = resolveExactCiRolloutDecision({
      updateInfo,
      rolloutId: getInstallId(app.getPath('userData')),
    });
    switch (decision.kind) {
      case 'delegate':
        return delegate(updateInfo);
      case 'admit':
        console.log('[AutoUpdater] Exact CI rollout profile admitted.');
        return true;
      case 'reject':
        console.warn(`[AutoUpdater] Exact CI rollout profile rejected: ${decision.reason}.`);
        return false;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };
}

function configureSchemaRecoveryRolloutDecision(): void {
  autoUpdater.isUserWithinRollout = async (updateInfo) => {
    const decision = resolveExactCiRolloutDecision({
      updateInfo,
      rolloutId: getInstallId(app.getPath('userData')),
    });
    if (decision.kind === 'reject') {
      console.warn(`[AutoUpdater] Schema recovery candidate rejected: ${decision.reason}.`);
      return false;
    }
    return true;
  };
}

export function openInstallerDownloadPage(open: (url: string) => void): void {
  if (!isCommunityBuild()) open('https://dnaforge.com/download');
}

export async function startSchemaUpdateRecovery(
  input: StartSchemaUpdateRecoveryInput
): Promise<SchemaUpdateRecoveryResult> {
  if (isCommunityBuild()) {
    return { kind: 'fallback-required', reason: 'no-update' };
  }
  const receiptPath = process.env[SCHEMA_UPDATE_RECOVERY_RECEIPT_ENV];
  const e2eReceiptEnabled =
    !app.isPackaged && process.env.WAYPOINT_TEST === '1' && Boolean(receiptPath);

  if (e2eReceiptEnabled) {
    return runSchemaUpdateRecovery({
      runningVersion: app.getVersion(),
      closeDatabase: input.closeDatabase,
      flushFatalDiagnostics: input.flushFatalDiagnostics,
      checkAndDownload: async () => ({
        kind: 'downloaded',
        targetVersion: SCHEMA_UPDATE_E2E_TARGET_VERSION,
      }),
      beginInstall: () => {
        writeFileSync(
          receiptPath!,
          `${JSON.stringify({
            kind: 'schema-update-recovery',
            dbVersion: input.error.dbVersion,
            supportedVersion: input.error.supportedVersion,
            appVersion: input.error.appVersion,
          })}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        app.exit(0);
      },
      reportDiagnosticFailure: (stage, error) => {
        console.error(`[AutoUpdater] E2E schema recovery ${stage} failure:`, error);
      },
    });
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  configureSchemaRecoveryRolloutDecision();

  let nativeInstallStarted = false;
  let installerFallbackOpened = false;
  const openInstallerFallbackOnce = (): void => {
    if (installerFallbackOpened) return;
    installerFallbackOpened = true;
    input.openCurrentInstaller();
  };
  const onUpdaterError = (error: Error): void => {
    if (!nativeInstallStarted) return;
    nativeInstallStarted = false;
    console.error('[AutoUpdater] Schema recovery native install failed:', error);
    openInstallerFallbackOnce();
    app.quit();
  };
  autoUpdater.on('error', onUpdaterError);

  const result = await runSchemaUpdateRecovery({
    runningVersion: app.getVersion(),
    closeDatabase: input.closeDatabase,
    flushFatalDiagnostics: input.flushFatalDiagnostics,
    checkAndDownload: async () => {
      downloadStartedAt = Date.now();
      updaterPhase = 'checking';
      const update = await checkAndDownloadStartupUpdate({
        updater: autoUpdater,
        feedUrls: resolveUpdateFeedUrls(),
        onAuthorityAttempt: (authorityIndex) =>
          console.log(`[AutoUpdater] Schema recovery checking authority ${authorityIndex + 1}.`),
      });
      if (update.kind === 'no-update') return { kind: 'no-update' };
      return { kind: 'downloaded', targetVersion: update.updateInfo.version };
    },
    beginInstall: (targetVersion) => {
      downloadedVersion = targetVersion;
      downloadedCandidateFingerprint = '';
      updateDownloaded = true;
      updaterPhase = 'downloaded';
      setQuitConsentGranted();
      nativeInstallStarted = true;
      const install = quitAndInstall();
      if (install.status === 'failed') {
        nativeInstallStarted = false;
        throw new Error(install.message);
      }
    },
    reportDiagnosticFailure: (stage, error) => {
      console.error(`[AutoUpdater] Schema recovery ${stage} failure:`, error);
      trackEvent('app_update_error', {
        feature_area: 'reliability',
        error_class: 'schema_update_recovery_failed',
        error_code: 'unknown',
        stage,
        reason: 'unknown',
        manual: false,
      });
    },
  });

  if (result.kind === 'fallback-required') {
    autoUpdater.removeListener('error', onUpdaterError);
  }
  return result;
}

export function initAutoUpdater(
  mainWindow: BrowserWindow,
  opts: InitAutoUpdaterOptions = {}
): void {
  mainWindowRef = mainWindow;
  updaterDatabase = opts.database;
  downloadEpisodes = new UpdateDownloadEpisodes(opts.database);

  if (
    isValidationAppIdentity({
      isPackaged: app.isPackaged,
      appName: app.isPackaged ? app.getName() : '',
    })
  ) {
    console.log('[AutoUpdater] Disabled for the signed validation application identity.');
    registerInertHandlers('The signed validation application cannot install production updates.');
    return;
  }

  if (isCommunityBuild()) {
    console.log('[AutoUpdater] Disabled in community builds.');
    registerInertHandlers(
      'Community builds do not install updates. Build the new version from source.'
    );
    return;
  }

  if (isMacTeamIdCutoverBuild()) {
    console.log(
      '[AutoUpdater] Squirrel.Mac disabled for the one-time Team ID cutover bridge release.'
    );
    return;
  }

  const testMode = !app.isPackaged && FORCE_UPDATER;

  if (!app.isPackaged && !testMode) {
    console.log('[AutoUpdater] Skipping in dev mode');
    registerRetryHandler();
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = Boolean(opts.allowPrerelease);
  autoUpdater.disableWebInstaller = true;
  configureExactCiRolloutDecision();

  if (testMode) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;
    autoUpdater.logger = console;
  }

  configuredUpdateFeedUrls = resolveUpdateFeedUrls();
  selectedUpdateFeedIndex = -1;
  updaterPhase = 'idle';
  selectUpdateFeed(0);

  autoUpdater.on('update-available', (info) => {
    const shouldRecordCheckCompletion = claimCheckTerminal(activeCheckAttempt);
    if (shouldRecordCheckCompletion) resetCheckRetryState();
    console.log('[AutoUpdater] Update available:', info.version);
    updaterPhase = 'downloading';
    downloadStartedAt = Date.now();
    const fingerprint = updateCandidateFingerprint(info);
    if (
      updateDownloaded &&
      (info.version !== downloadedVersion ||
        (fingerprint && fingerprint !== downloadedCandidateFingerprint))
    ) {
      updateDownloaded = false;
      downloadedAtMs = null;
    }
    const newDownloadEpisode = downloadEpisodes.begin(
      fingerprint,
      app.getVersion(),
      downloadStartedAt,
      shouldRecordCheckCompletion ? activeCheckAttempt?.operationId : undefined
    );
    let recordedAvailable = false;
    if (newDownloadEpisode && fingerprint) {
      const properties = {
        operation_id: downloadEpisodes.operationId!,
        occurred_at_ms: downloadStartedAt,
        version: info.version,
        ...(shouldRecordCheckCompletion && activeCheckAttempt
          ? { parent_action_id: activeCheckAttempt.operationId }
          : {}),
      };
      if (autoUpdater.autoDownload) {
        if (
          !recordUpdateDownloadMeasurement(
            updaterDatabase,
            'app_update_download_started',
            properties
          )
        )
          trackEvent('app_update_download_started', properties);
      } else {
        recordedAvailable = recordUpdateDownloadMeasurement(
          updaterDatabase,
          'app_update_available',
          properties
        );
      }
    }
    downloadedVersion = info.version;
    activeUpdateVersion = info.version;
    latestDownloadProgress = null;
    if (!fallbackDownloadAttempt) {
      expectedDownloadedCandidate = fingerprint;
    }
    const isManual = consumeManualCheckFlag();
    sendUpdateRendererIpc(mainWindow, 'update:available', { version: info.version, isManual });
    if (newDownloadEpisode && !recordedAvailable)
      trackEvent('app_update_available', { version: info.version });
    if (shouldRecordCheckCompletion) {
      trackEvent('app_update_check_completed', {
        feature_area: 'reliability',
        success: true,
        manual: isManual,
        ...checkAttemptProperties(),
        ...updateStateProperties(),
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    const shouldRecordCheckCompletion = claimCheckTerminal(activeCheckAttempt);
    if (shouldRecordCheckCompletion) resetCheckRetryState();
    const isManual = consumeManualCheckFlag();
    updaterPhase = 'idle';
    if (isManual) {
      console.log('[AutoUpdater] Manual check: up to date at', info.version);
      sendUpdateRendererIpc(mainWindow, 'update:no-update', { version: info.version });
    }
    if (shouldRecordCheckCompletion) {
      trackEvent('app_update_check_completed', {
        feature_area: 'reliability',
        success: true,
        manual: isManual,
        ...checkAttemptProperties(),
        ...updateStateProperties(),
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    const fingerprint = updateCandidateFingerprint(info);
    const publishRestartReady = (): void => {
      const recovery = pendingInstallRecovery;
      if (recovery) {
        pendingInstallRecovery = null;
        if (info.version !== recovery.targetVersion) {
          try {
            clearInstallIntent();
          } catch (error) {
            console.error('[AutoUpdater] Could not clear superseded install intent:', error);
          }
        }
      }
      updaterPhase = 'downloaded';
      updateDownloaded = true;
      downloadedVersion = info.version;
      downloadedCandidateFingerprint = fingerprint;
      downloadedAtMs = Date.now();
      if (opts.database) {
        try {
          opts.database
            .prepare(
              'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET updated_at = CASE WHEN settings.value = excluded.value ' +
                'THEN settings.updated_at ELSE excluded.updated_at END, value = excluded.value'
            )
            .run(DOWNLOADED_UPDATE_TARGET_SETTING, info.version, Date.now());
          const row = opts.database
            .prepare('SELECT updated_at FROM settings WHERE key = ?')
            .get(DOWNLOADED_UPDATE_TARGET_SETTING) as { updated_at?: unknown } | undefined;
          downloadedAtMs = typeof row?.updated_at === 'number' ? row.updated_at : Date.now();
        } catch (error) {
          console.error('[AutoUpdater] Could not persist downloaded update target:', error);
        }
      }
      sendUpdateRendererIpc(mainWindow, 'update:downloaded', { version: info.version });
      const episode = downloadEpisodes.complete(fingerprint, app.getVersion(), Date.now());
      if (episode) {
        const { newEpisode, ...properties } = episode;

        if (
          !fingerprint ||
          !recordUpdateDownloadMeasurement(
            updaterDatabase,
            'app_update_downloaded',
            { version: info.version, ...properties },
            { requireExistingAuthority: !newEpisode }
          )
        ) {
          trackEvent('app_update_downloaded', {
            version: info.version,
            ...downloadTelemetryProperties(properties),
          });
        }
      }
    };

    if (process.platform !== 'darwin' || !app.isPackaged) {
      publishRestartReady();
      return;
    }

    const candidate = fingerprint || `version:${info.version}`;
    if (cancelNativePreparation && nativePreparationCandidate === candidate) return;
    if (updateDownloaded && nativePreparedCandidate === candidate) {
      publishRestartReady();
      return;
    }

    cancelNativePreparation?.();
    nativePreparationCandidate = candidate;
    nativePreparedCandidate = '';
    updateDownloaded = false;
    downloadedVersion = '';
    updaterPhase = 'downloading';
    activeUpdateVersion = info.version;
    const startedAt = Date.now();
    appendBootLog('update_native_preparation_started');
    latestDownloadProgress = { percent: 100, bytesPerSecond: 0 };
    sendUpdateRendererIpc(mainWindow, 'update:progress', latestDownloadProgress);
    let settled = false;
    const cancel = (): void => {
      settled = true;
      clearTimeout(timer);
      nativeMacUpdater.removeListener('update-downloaded', prepared);
      if (cancelNativePreparation === cancel) {
        cancelNativePreparation = null;
        nativePreparationCandidate = '';
      }
    };
    const prepared = (): void => {
      if (settled) return;
      cancel();
      nativePreparedCandidate = candidate;
      appendBootLog(`update_native_preparation_ready duration_ms=${Date.now() - startedAt}`);
      publishRestartReady();
    };
    const timer = setTimeout(() => {
      cancel();
      reportTerminalDownloadFailure(
        new Error('Native update preparation timed out.'),
        'native-preparation'
      );
    }, 120_000);
    timer.unref();
    cancelNativePreparation = cancel;
    nativeMacUpdater.on('update-downloaded', prepared);
    try {
      macNativePreparationStarted = true;
      nativeMacUpdater.checkForUpdates();
    } catch (error) {
      cancel();
      reportTerminalDownloadFailure(error, 'native-preparation');
    }
  });

  autoUpdater.on('error', (err) => {
    const nativePreparationFailed = Boolean(cancelNativePreparation);
    cancelNativePreparation?.();
    const stage: 'check' | 'download' | 'install' =
      updaterPhase === 'installing'
        ? 'install'
        : updaterPhase === 'downloading'
          ? 'download'
          : 'check';
    if (fallbackDownloadAttempt) {
      const attempt = fallbackDownloadAttempt;
      if (!isUpdateOriginFailoverEligible(err)) {
        attempt.terminalRecorded = true;
        attempt.deferredError = err;
        fallbackDownloadAttempt = null;
        reportTerminalDownloadFailure(err);
        return;
      }
      if (!attempt.terminalRecorded) {
        attempt.deferredError = err;
      }
      return;
    }
    if (stage === 'install') {
      reportTerminalInstallFailure(err);
      app.relaunch();
      app.quit();
      return;
    }
    if (
      stage === 'check' &&
      activeCheckAttempt &&
      inFlightCheck?.attempt === activeCheckAttempt &&
      !activeCheckAttempt.terminalRecorded
    ) {
      activeCheckAttempt.deferredError = err;
      return;
    }
    if (
      stage === 'download' &&
      expectedDownloadedCandidate &&
      selectedUpdateFeedIndex + 1 < configuredUpdateFeedUrls.length &&
      isUpdateOriginFailoverEligible(err)
    ) {
      const nextOriginIndex = selectedUpdateFeedIndex + 1;
      const attempt: FallbackDownloadAttempt = {
        generation: (fallbackDownloadGeneration += 1),
        expectedCandidate: expectedDownloadedCandidate,
        deferredError: null,
        terminalRecorded: false,
      };
      fallbackDownloadAttempt = attempt;
      trackEvent('app_update_origin_failed', {
        feature_area: 'reliability',
        origin_index: selectedUpdateFeedIndex,
        stage: 'download',
      });
      setTimeout(() => void runFallbackDownload(nextOriginIndex, attempt.generation), 0);
      return;
    }
    const isManual = consumeManualCheckFlag();
    if (stage === 'check' && !claimCheckTerminal(activeCheckAttempt)) {
      console.error('[AutoUpdater] Ignoring duplicate check error after terminal rejection:', err);
      return;
    }
    const payload =
      stage === 'check'
        ? recordCheckFailureTelemetry(err, isManual)
        : buildUpdateErrorPayload(
            err,
            stage,
            isManual,
            nativePreparationFailed ? 'native-preparation' : stage
          );
    console.error(`[AutoUpdater] ${stage} error (manual=${isManual}):`, payload.message);
    if (isManual || stage !== 'check') {
      sendUpdateRendererIpc(mainWindow, 'update:error', payload);
    }
    const reason = payload.reason ?? 'unknown';
    const errorCode = reason === 'no-manifest' ? 'no_manifest' : reason;
    const errorClass = stage === 'download' ? 'update_download_failed' : 'update_check_failed';
    if (stage !== 'check') {
      trackEvent('app_update_error', {
        feature_area: 'reliability',
        error_class: errorClass,
        ...downloadTelemetryProperties(downloadEpisodes.fail(Date.now())),
        error_code: errorCode,
        stage,
        reason,
        manual: isManual,
        ...(activeUpdateVersion ? { version: activeUpdateVersion } : {}),
      });
    }
    updaterPhase = 'failed';
  });

  autoUpdater.on('download-progress', (progress) => {
    latestDownloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
    };
    sendUpdateRendererIpc(mainWindow, 'update:progress', latestDownloadProgress);
  });

  if (pendingInstallRecovery) {
    void runBackgroundCheck('Install recovery check failed');
  }

  const initialDelay = testMode ? TEST_INITIAL_DELAY_MS : INITIAL_CHECK_DELAY_MS;
  let stopped = false;
  let checkHandle: ReturnType<typeof setTimeout> | null = null;
  scheduleBackgroundCheck = (delay) => {
    if (stopped) return;
    if (checkHandle) clearTimeout(checkHandle);
    checkHandle = setTimeout(() => {
      checkHandle = null;
      void runBackgroundCheck('Periodic check failed').finally(() => {
        scheduleBackgroundCheck?.(nextBackgroundCheckDelay());
      });
    }, delay);
  };
  scheduleBackgroundCheck(initialDelay);

  app.on('will-quit', () => {
    stopped = true;
    scheduleBackgroundCheck = null;
    if (checkHandle) {
      clearTimeout(checkHandle);
      checkHandle = null;
    }
    if (manualCheckTimer) {
      clearTimeout(manualCheckTimer);
      manualCheckTimer = null;
      manualCheckInProgress = false;
    }
  });

  registerRetryHandler();
}

let disposeUpdateHandlers: (() => void) | null = null;

function registerInertHandlers(message: string): void {
  disposeUpdateHandlers?.();
  disposeUpdateHandlers = handleGroup(updateContract, {
    retry: () => undefined,
    checkManual: () => undefined,
    install: (): UpdateInstallResult => ({ status: 'failed', message }),
  });
  mainIpc.removeHandler?.('update:simulate');
  mainIpc.handle('update:simulate', () => undefined);
}

function registerRetryHandler(): void {
  disposeUpdateHandlers?.();
  disposeUpdateHandlers = handleGroup(updateContract, {
    retry: () => runManualCheck(),
    install: (_event, expectedVersion) => installUpdate(expectedVersion),
    checkManual: async () => {
      if (!app.isPackaged && !FORCE_UPDATER) {
        const win = mainWindowRef;
        if (win && !win.isDestroyed()) {
          sendRendererIpc(win.webContents, 'update:no-update', {
            version: app.getVersion(),
            isDevMode: true,
          });
        }
        return;
      }
      await runManualCheck();
    },
  });

  mainIpc.removeHandler?.('update:simulate');
  mainIpc.handle('update:simulate', (_event, channel: unknown, payload: unknown) => {
    if (app.isPackaged) return;
    if (typeof channel !== 'string') return;
    const win = mainWindowRef;
    if (win && !win.isDestroyed()) {
      sendSimulatedUpdateRendererIpc(win, channel, payload ?? {});
    }
  });
}

function currentReadyUpdateCandidate(): DownloadedUpdateCandidate | null {
  return updateDownloaded && downloadedVersion
    ? { version: downloadedVersion, fingerprint: downloadedCandidateFingerprint }
    : null;
}

export function readUpdateInstallCandidate(): DownloadedUpdateCandidate | null {
  return installCandidate ?? currentReadyUpdateCandidate();
}

function isCurrentInstallCandidate(candidate: DownloadedUpdateCandidate): boolean {
  return (
    updateDownloaded &&
    candidate.version === downloadedVersion &&
    candidate.fingerprint === downloadedCandidateFingerprint
  );
}

function supersededInstallRequest(): UpdateInstallResult {
  return {
    status: 'failed',
    message: 'The downloaded update changed before restart.',
    readyVersion: currentReadyUpdateCandidate()?.version ?? null,
  };
}

export async function installUpdate(expectedVersion?: string): Promise<UpdateInstallResult> {
  const candidate = currentReadyUpdateCandidate();
  if (expectedVersion !== undefined && expectedVersion !== candidate?.version)
    return supersededInstallRequest();
  if (!candidate) return { status: 'failed', message: 'No downloaded update is ready to install.' };
  const requestId = randomUUID();
  const requestedAt = Date.now();
  const parentDownload = downloadEpisodes.operationId;
  const requestState = updateStateProperties();
  const dirty = await readCurrentDirtyState();
  if (!isCurrentInstallCandidate(candidate)) return supersededInstallRequest();
  const win = mainWindowRef;

  if (dirty.hasDirtyWork) {
    const decision = await showUnsavedWorkDialog(win, {
      staged: true,
      details: dirty.details,
    });
    if (decision === 'cancel') {
      trackEvent('app_update_restart_decided', {
        operation_id: requestId,
        version: candidate.version,
        outcome: 'cancelled',
        ...downloadTelemetryParent(parentDownload),
        occurred_at_ms: Date.now(),
        origin_started_at_ms: requestedAt,
        ...requestState,
      });
      if (!isCurrentInstallCandidate(candidate)) return supersededInstallRequest();
      return { status: 'cancelled' };
    }
    if (!isCurrentInstallCandidate(candidate)) return supersededInstallRequest();
    setQuitConsentGranted();
  }
  appendBootLog('update_restart_requested');
  restartRequestId = requestId;
  installCandidate = candidate;
  trackEvent('app_update_restart_decided', {
    operation_id: requestId,
    version: candidate.version,
    outcome: 'started',
    ...downloadTelemetryParent(parentDownload),
    occurred_at_ms: Date.now(),
    origin_started_at_ms: requestedAt,
    ...requestState,
  });
  app.quit();
  return { status: 'started' };
}

export function requestSaveAll(win: BrowserWindow, timeoutMs = 10_000): Promise<void> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    type Phase = 'pending' | 'acknowledged' | 'timed-out' | 'renderer-gone';
    let phase: Phase = 'pending';
    const finish = (outcome: Exclude<Phase, 'pending'>): void => {
      if (phase !== 'pending') return;
      phase = outcome;
      clearTimeout(timer);
      mainIpc.removeListener('app:saveAllDone', onDone);
      resolve();
    };
    const onDone = (event: Electron.IpcMainEvent, acknowledgedRequestId: string): void => {
      if (event.sender !== win.webContents || acknowledgedRequestId !== requestId) return;
      finish('acknowledged');
    };
    const timer = setTimeout(() => {
      if (phase !== 'pending') return;
      console.warn('[AutoUpdater] Save-all request timed out');
      finish('timed-out');
    }, timeoutMs);
    mainIpc.on('app:saveAllDone', onDone);
    if (!win.isDestroyed()) {
      sendRendererIpc(win.webContents, 'app:saveAll', requestId);
    } else {
      finish('renderer-gone');
    }
  });
}

export function isUpdateDownloaded(): boolean {
  return updateDownloaded;
}

export function getDownloadedVersion(): string {
  return downloadedVersion;
}

export function hasStartedMacUpdatePreparation(): boolean {
  return process.platform === 'darwin' && app.isPackaged && macNativePreparationStarted;
}

export function refuseUpdateRestartAfterShutdownFailure(error: unknown): void {
  recordUpdateInstallOutcome('failed', 'shutdown_failed');
  reportTerminalInstallFailure(error);
  restoreDownloadedUpdateAfterQuitCancellation();
}

export function restoreDownloadedUpdateAfterQuitCancellation(): void {
  const ready = currentReadyUpdateCandidate();
  if (!ready && !installCandidate) return;
  quitAndInstallCalled = false;
  if (ready) updaterPhase = 'downloaded';
  recordUpdateInstallOutcome('cancelled', 'quit_cancelled');
  acceptedInstallIntent = null;
  installCandidate = null;
  restartRequestId = undefined;
  try {
    clearInstallIntent();
  } catch (error) {
    console.error('[AutoUpdater] Could not clear cancelled install intent:', error);
  }
  const win = mainWindowRef;
  if (ready && win && !win.isDestroyed()) {
    sendUpdateRendererIpc(win, 'update:downloaded', { version: ready.version });
  }
}

export function prepareUpdateInstallIntent(
  candidate = readUpdateInstallCandidate()
): UpdateInstallResult {
  if (!candidate) return { status: 'failed', message: 'No downloaded update is ready to install.' };
  if (!isCurrentInstallCandidate(candidate)) return supersededInstallRequest();
  if (
    acceptedInstallIntent?.targetVersion === candidate.version &&
    !acceptedInstallIntent.measurement?.terminal
  )
    return { status: 'started' };
  const priorIntent = readInstallIntent();
  const parentMeasurement =
    priorIntent?.targetVersion === candidate.version
      ? priorIntent.measurement
      : previousInstallAttempt?.targetVersion === candidate.version
        ? previousInstallAttempt.measurement
        : undefined;

  const parentAttemptId = isUpdateInstallMeasurementPermitted(updaterDatabase, parentMeasurement)
    ? parentMeasurement?.operationId
    : undefined;
  const intent: UpdateInstallIntent = {
    fromVersion: app.getVersion(),
    targetVersion: candidate.version,
    attemptedAt: Date.now(),
    measurement: createUpdateInstallMeasurement(
      updaterDatabase,
      restartRequestId,
      parentAttemptId,
      downloadEpisodes.operationId
    ),
  };
  try {
    persistInstallIntent(intent);
    acceptedInstallIntent = intent;
    installCandidate = candidate;
    recordUpdateInstallMeasurement(updaterDatabase, intent, true, readInstallTelemetryReceipt);
    return { status: 'started' };
  } catch (error) {
    reportTerminalInstallFailure(error);
    return { status: 'failed', message: getErrorMessage(error) };
  }
}

export function recordUpdateInstallOutcome(
  outcome: 'succeeded' | 'failed' | 'cancelled',
  code:
    | 'version_advanced'
    | 'same_version_relaunch'
    | 'shutdown_failed'
    | 'native_install_failed'
    | 'quit_cancelled'
): void {
  const intent = acceptedInstallIntent;
  if (!intent?.measurement || intent.measurement.terminal) return;
  previousInstallAttempt = {
    measurement: intent.measurement,
    targetVersion: intent.targetVersion,
  };
  intent.measurement.terminal = { outcome, code, occurredAtMs: Date.now(), bootId: UPDATE_BOOT_ID };
  try {
    persistInstallIntent(intent);
  } catch {
    console.warn('[AutoUpdater] Install outcome persistence unavailable.');
  }
  recordUpdateInstallMeasurement(updaterDatabase, intent, false, readInstallTelemetryReceipt);
}

export function quitAndInstall(): UpdateInstallResult {
  if (quitAndInstallCalled) {
    app.quit();
    return { status: 'started' };
  }
  const prepared = prepareUpdateInstallIntent();
  if (prepared.status === 'failed') {
    if (installCandidate) restoreDownloadedUpdateAfterQuitCancellation();
    return prepared;
  }
  quitAndInstallCalled = true;
  updaterPhase = 'installing';
  try {
    appendBootLog('update_native_install_started');
    autoUpdater.quitAndInstall(true, true);
    return { status: 'started' };
  } catch (error: unknown) {
    quitAndInstallCalled = false;
    reportTerminalInstallFailure(error);
    return { status: 'failed', message: getErrorMessage(error) };
  }
}

export function checkForVersionUpgrade(db: Database.Database): void {
  const currentVersion = app.getVersion();
  const installIntent = readInstallIntent();
  updaterDatabase = db;
  let lastVersion: string | null = null;
  let downloadedUpdateTarget: string | null = null;
  let legacyBridgeConsumed = false;
  try {
    const selectSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
    const lastVersionRow = selectSetting.get(LAST_APP_VERSION_SETTING) as
      | { value: string }
      | undefined;
    const downloadedTargetRow = selectSetting.get(DOWNLOADED_UPDATE_TARGET_SETTING) as
      | { value: string }
      | undefined;
    const legacyBridgeRow = selectSetting.get(LEGACY_UNMARKED_UPDATE_BRIDGE_SETTING) as
      | { value: string }
      | undefined;
    lastVersion = lastVersionRow?.value ?? null;
    downloadedUpdateTarget = downloadedTargetRow?.value ?? null;
    legacyBridgeConsumed = legacyBridgeRow?.value === 'true';
  } catch {
    return;
  }

  const permittedInstallMeasurement = isUpdateInstallMeasurementPermitted(
    db,
    installIntent?.measurement
  )
    ? installIntent?.measurement
    : undefined;
  const versionChanged = Boolean(lastVersion && lastVersion !== currentVersion);
  const exactDownloadedTransition = downloadedUpdateTarget === currentVersion;
  const exactIntentTransition = Boolean(
    installIntent &&
    lastVersion === installIntent.fromVersion &&
    currentVersion === installIntent.targetVersion &&
    currentVersion !== installIntent.fromVersion
  );
  const legacyUnmarkedTransition =
    versionChanged && downloadedUpdateTarget === null && !legacyBridgeConsumed;
  if (
    lastVersion &&
    versionChanged &&
    (exactDownloadedTransition || exactIntentTransition || legacyUnmarkedTransition)
  ) {
    trackEvent('app_update_installed', {
      $insert_id: permittedInstallMeasurement?.launchEventId ?? UPDATE_BOOT_ID,
      from_version: lastVersion,
      to_version: currentVersion,
      update_qualification: exactIntentTransition
        ? installIntent?.measurement?.terminal &&
          installIntent.measurement.terminal.outcome !== 'succeeded'
          ? 'late_intent_transition'
          : 'exact_install_intent'
        : exactDownloadedTransition
          ? 'exact_download_marker'
          : 'legacy_bridge',
      update_boot_id: UPDATE_BOOT_ID,
      ...(exactIntentTransition && permittedInstallMeasurement
        ? { operation_id: permittedInstallMeasurement.operationId }
        : {}),
    });
  }

  if (installIntent?.measurement) {
    acceptedInstallIntent = installIntent;
    if (exactIntentTransition) recordUpdateInstallOutcome('succeeded', 'version_advanced');
    else if (lastVersion === currentVersion && currentVersion === installIntent.fromVersion)
      recordUpdateInstallOutcome('failed', 'same_version_relaunch');
    recordUpdateInstallMeasurement(db, installIntent, false, readInstallTelemetryReceipt);
    acceptedInstallIntent = null;
  }

  const sameVersionAfterInstallAttempt = Boolean(
    installIntent &&
    lastVersion === currentVersion &&
    currentVersion === installIntent.fromVersion &&
    installIntent.targetVersion !== currentVersion
  );
  if (installIntent && sameVersionAfterInstallAttempt) {
    pendingInstallRecovery = installIntent;
    updateDownloaded = false;
    downloadedVersion = '';
    updaterPhase = 'idle';
    trackEvent('app_update_error', {
      feature_area: 'reliability',
      error_class: 'update_install_did_not_advance',
      error_code: 'same_version_relaunch',
      stage: 'install',
      reason: 'unknown',
      manual: false,
      version: installIntent.targetVersion,
      ...(permittedInstallMeasurement
        ? {
            operation_id: permittedInstallMeasurement.operationId,
            origin_boot_id: permittedInstallMeasurement.originBootId,
            origin_started_at_ms: installIntent.attemptedAt,
            occurred_at_ms: Date.now(),
            update_boot_id: UPDATE_BOOT_ID,
          }
        : {}),
    });
  } else {
    pendingInstallRecovery = null;
  }

  try {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(LAST_APP_VERSION_SETTING, currentVersion, Date.now());
    if (!legacyBridgeConsumed) {
      db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).run(LEGACY_UNMARKED_UPDATE_BRIDGE_SETTING, 'true', Date.now());
    }
    if (versionChanged) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(DOWNLOADED_UPDATE_TARGET_SETTING);
    }
    if (exactIntentTransition) {
      clearInstallIntent();
    }
  } catch {}
}

export async function _emitUpdateDownloadedForTest(
  info: import('electron-updater').UpdateDownloadedEvent
): Promise<void> {
  await nextMainTurn();
  autoUpdater.emit('update-downloaded', info);
}
export async function _cancelUpdateInstallIntentForTest(): Promise<void> {
  await nextMainTurn();
  restoreDownloadedUpdateAfterQuitCancellation();
}

export function _setUpdateDownloadedForTest(value: boolean, version?: string): void {
  updateDownloaded = value;
  if (value) downloadedVersion = version ?? (downloadedVersion || app.getVersion());
  else {
    downloadedVersion = '';
    downloadedCandidateFingerprint = '';
    installCandidate = null;
  }
}
export function _setMainWindowForTest(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

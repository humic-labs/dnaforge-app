import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { sanitizeFeedbackText } from '../shared/feedback';
import { sendFeedbackTransport } from '../shared/feedback-transport';
import type {
  FeedbackError,
  FeedbackPayload,
  FeedbackResult,
  FeedbackReceipt,
  FeedbackTelemetryOrigin,
  FeedbackStage,
} from '../shared/feedback';

export { FEEDBACK_TIMEOUT_MS, FEEDBACK_PROTOCOL } from '../shared/feedback-transport';
const QUEUE_FILE = 'pending-feedback.json';
const QUEUE_MAX = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QueueState = 'pending' | 'refused' | 'held';
type StoredReceipt = Pick<FeedbackReceipt, 'stage' | 'reason' | 'occurredAtMs' | 'attempt'>;
export interface QueuedFeedback extends FeedbackPayload {
  submission_id: string;
  timestamp: string;
  install_id?: string;
  user_agent?: string;
  queue_state: QueueState;
  telemetry?: FeedbackTelemetryOrigin | null;
  attempt_count?: number;
  backend_accepted_at_ms?: number;
  payload_digest?: string;
  telemetry_receipts?: StoredReceipt[];
}
interface FeedbackTelemetry {
  captureOrigin(): FeedbackTelemetryOrigin | null;
  record(receipt: FeedbackReceipt, readCommitted?: () => FeedbackReceipt | null): boolean | void;
}
let telemetry: FeedbackTelemetry | null = null;
export function configureFeedbackTelemetry(adapter: FeedbackTelemetry | null): void {
  telemetry = adapter;
}
function validOrigin(value: unknown): value is FeedbackTelemetryOrigin {
  return (
    record(value) &&
    ['consentScope', 'metricId', 'processId'].every(
      (key) => typeof value[key] === 'string' && UUID.test(String(value[key]))
    ) &&
    (value.contextId === undefined ||
      (typeof value.contextId === 'string' && UUID.test(value.contextId))) &&
    ['synthetic', 'private', 'unknown', 'eligible_release'].includes(String(value.classification))
  );
}
const STAGES: readonly FeedbackStage[] = [
  'accepted_intent',
  'durable_queue',
  'backend_accepted',
  'retry',
  'deferred',
  'refused',
  'cancelled',
];
const REASONS: readonly FeedbackError[] = [
  'invalid_payload',
  'submission_conflict',
  'queue_corrupt',
  'queue_full',
  'storage_unavailable',
  'service_unavailable',
  'transport_unavailable',
  'timeout',
  'permanent_refusal',
  'delivery_unconfirmed',
  'cancelled',
];
const TERMINAL_STAGES = new Set<FeedbackStage>([
  'accepted_intent',
  'durable_queue',
  'backend_accepted',
  'cancelled',
]);
function copyOrigin(value: unknown): FeedbackTelemetryOrigin | null {
  if (!validOrigin(value)) return null;
  return {
    consentScope: value.consentScope,
    ...(value.contextId ? { contextId: value.contextId } : {}),
    metricId: value.metricId,
    processId: value.processId,
    classification: value.classification,
  };
}
function validReceipt(value: unknown): value is StoredReceipt {
  return (
    record(value) &&
    typeof value.stage === 'string' &&
    STAGES.includes(value.stage as FeedbackStage) &&
    (value.reason === undefined ||
      (typeof value.reason === 'string' && REASONS.includes(value.reason as FeedbackError))) &&
    typeof value.occurredAtMs === 'number' &&
    Number.isSafeInteger(value.occurredAtMs) &&
    value.occurredAtMs >= 0 &&
    typeof value.attempt === 'number' &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 0 &&
    value.attempt <= 1000
  );
}
function withReceipt(
  item: QueuedFeedback,
  stage: FeedbackStage,
  at: number,
  reason?: FeedbackError
): QueuedFeedback {
  if (!validOrigin(item.telemetry)) return item;
  const previous = item.telemetry_receipts ?? [];
  if (TERMINAL_STAGES.has(stage) && previous.some((entry) => entry.stage === stage)) return item;
  return {
    ...item,
    telemetry_receipts: [
      ...previous.filter((entry) => entry.stage !== stage),
      { stage, ...(reason ? { reason } : {}), occurredAtMs: at, attempt: item.attempt_count ?? 0 },
    ],
  };
}
function completed(item: QueuedFeedback): boolean {
  return (
    item.queue_state === 'held' &&
    item.message === '' &&
    typeof item.backend_accepted_at_ms === 'number' &&
    Number.isSafeInteger(item.backend_accepted_at_ms) &&
    item.backend_accepted_at_ms >= 0 &&
    typeof item.payload_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(item.payload_digest)
  );
}
function payloadDigest(item: FeedbackPayload): string {
  return createHash('sha256')
    .update(JSON.stringify([item.message, item.app_version ?? null, item.platform_info ?? null]))
    .digest('hex');
}
function receiptFor(item: QueuedFeedback, entry: StoredReceipt): FeedbackReceipt | null {
  const origin = copyOrigin(item.telemetry);
  return origin
    ? {
        origin,
        operationId: item.submission_id,
        originalAtMs: Date.parse(item.timestamp),
        stage: entry.stage,
        ...(entry.reason ? { reason: entry.reason } : {}),
        occurredAtMs: entry.occurredAtMs,
        attempt: entry.attempt,
      }
    : null;
}
function replayReceipts(profile: string, id: string, onlyStage?: FeedbackStage): void {
  try {
    const item = readQueue(profile).find((row) => row.submission_id === id);
    if (!item) return;
    for (const entry of item.telemetry_receipts ?? []) {
      if (onlyStage && entry.stage !== onlyStage) continue;
      const receipt = receiptFor(item, entry);
      if (!receipt) continue;
      const encoded = JSON.stringify(receipt);
      const readCommitted = () => {
        const current = readQueue(profile).find((row) => row.submission_id === id);
        const exact = current?.telemetry_receipts?.find(
          (candidate) =>
            candidate.stage === entry.stage &&
            candidate.attempt === entry.attempt &&
            candidate.occurredAtMs === entry.occurredAtMs &&
            candidate.reason === entry.reason
        );
        return current && exact ? receiptFor(current, exact) : null;
      };
      if (telemetry?.record(receipt, readCommitted) !== true) continue;
      const current = readQueue(profile);
      writeQueue(
        profile,
        current.map((row) =>
          row.submission_id !== id
            ? row
            : {
                ...row,
                telemetry_receipts: row.telemetry_receipts?.filter(
                  (candidate) => JSON.stringify(receiptFor(row, candidate)) !== encoded
                ),
              }
        )
      );
    }
  } catch (_error) {
    void _error;
  }
}
function report(
  profile: string,
  id: string,
  stage: FeedbackStage,
  at: number,
  reason?: FeedbackError
): void {
  try {
    const current = readQueue(profile);
    const next = current.map((item) =>
      item.submission_id === id ? withReceipt(item, stage, at, reason) : item
    );
    if (next.every((item, index) => item === current[index])) return;
    writeQueue(profile, next);
    replayReceipts(profile, id, stage);
  } catch (_error) {
    void _error;
  }
}

function captureOrigin(): FeedbackTelemetryOrigin | null {
  try {
    const origin = telemetry?.captureOrigin();
    return copyOrigin(origin);
  } catch {
    return null;
  }
}
function reportRefusal(id: string, reason: FeedbackError): void {
  const origin = captureOrigin();
  if (!origin) return;
  const now = Date.now();
  try {
    telemetry?.record({
      origin,
      operationId: id,
      stage: 'refused',
      reason,
      originalAtMs: now,
      occurredAtMs: now,
      attempt: 0,
    });
  } catch (_error) {
    void _error;
  }
}
class QueueFailure extends Error {
  constructor(readonly reason: FeedbackError) {
    super(reason);
  }
}
const active = new Map<string, { controller: AbortController; promise: Promise<FeedbackResult> }>();
const drains = new Map<string, Promise<void>>();

function queuePath(profile: string): string {
  return join(profile, QUEUE_FILE);
}
function key(profile: string, id: string): string {
  return `${queuePath(profile)}:${id}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeQueue(profile: string, items: QueuedFeedback[]): void {
  const destination = queuePath(profile);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const live = items.filter((item) => !completed(item));
  const terminal = items
    .filter(
      (item) =>
        completed(item) &&
        validOrigin(item.telemetry) &&
        item.telemetry.contextId &&
        item.telemetry_receipts?.length
    )
    .slice(-QUEUE_MAX);
  const bytes = JSON.stringify([...terminal, ...live]);
  let file: number | undefined;
  try {
    file = openSync(temporary, 'wx', 0o600);
    writeFileSync(file, bytes, 'utf8');
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, destination);
    if (process.platform !== 'win32') {
      const directory = openSync(profile, 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    if (readFileSync(destination, 'utf8') !== bytes) throw new QueueFailure('storage_unavailable');
  } catch {
    throw new QueueFailure('storage_unavailable');
  } finally {
    if (file !== undefined) closeSync(file);
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch (_error) {
        void _error;
      }
    }
  }
}

function readQueue(profile: string): QueuedFeedback[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(queuePath(profile), 'utf8'));
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return [];
    throw new QueueFailure(error instanceof SyntaxError ? 'queue_corrupt' : 'storage_unavailable');
  }
  if (!Array.isArray(parsed) || parsed.length > QUEUE_MAX * 2)
    throw new QueueFailure('queue_corrupt');
  const ids = new Set<string>();
  let migrated = false;
  const items = parsed.map((value: unknown): QueuedFeedback => {
    if (
      !record(value) ||
      typeof value.message !== 'string' ||
      value.message.length > 10_000 ||
      typeof value.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(value.timestamp))
    ) {
      throw new QueueFailure('queue_corrupt');
    }
    for (const name of ['app_version', 'platform_info', 'install_id', 'user_agent']) {
      if (value[name] !== undefined && typeof value[name] !== 'string')
        throw new QueueFailure('queue_corrupt');
    }
    if (
      value.attempt_count !== undefined &&
      (!Number.isSafeInteger(value.attempt_count) ||
        Number(value.attempt_count) < 0 ||
        Number(value.attempt_count) > 1000)
    )
      throw new QueueFailure('queue_corrupt');
    const id = value.submission_id === undefined ? randomUUID() : value.submission_id;
    if (typeof id !== 'string' || !UUID.test(id) || ids.has(id))
      throw new QueueFailure('queue_corrupt');
    ids.add(id);
    const state =
      value.queue_state ??
      (value.message.trim() && value.message.length <= 2000 ? 'pending' : 'refused');
    if (!['pending', 'refused', 'held'].includes(String(state)))
      throw new QueueFailure('queue_corrupt');
    if (value.submission_id === undefined || value.queue_state === undefined) migrated = true;
    return {
      ...value,
      submission_id: id,
      queue_state: state,
      telemetry: copyOrigin(value.telemetry),
      telemetry_receipts: Array.isArray(value.telemetry_receipts)
        ? value.telemetry_receipts.filter(validReceipt).slice(-STAGES.length)
        : [],
    } as QueuedFeedback;
  });
  if (items.filter((item) => !completed(item)).length > QUEUE_MAX)
    throw new QueueFailure('queue_corrupt');
  if (migrated) writeQueue(profile, items);
  return items;
}

function failure(error: unknown, id?: string): FeedbackResult {
  return {
    success: false,
    queued: false,
    submission_id: id,
    error: error instanceof QueueFailure ? error.reason : 'storage_unavailable',
  };
}
function samePayload(a: QueuedFeedback, b: QueuedFeedback): boolean {
  return completed(a)
    ? a.payload_digest === payloadDigest(b)
    : a.message === b.message &&
        a.app_version === b.app_version &&
        a.platform_info === b.platform_info;
}
function update(
  profile: string,
  id: string,
  state: QueueState | 'accepted',
  stage?: FeedbackStage,
  at = Date.now(),
  reason?: FeedbackError
): void {
  const current = readQueue(profile);
  const next = current.map((item): QueuedFeedback => {
    if (item.submission_id !== id) return item;
    const changed = stage ? withReceipt(item, stage, at, reason) : item;
    if (state !== 'accepted') return { ...changed, queue_state: state };
    return {
      submission_id: item.submission_id,
      timestamp: item.timestamp,
      message: '',
      queue_state: 'held',
      backend_accepted_at_ms: at,
      payload_digest: payloadDigest(item),
      attempt_count: item.attempt_count,
      telemetry: item.telemetry,
      telemetry_receipts: changed.telemetry_receipts,
    };
  });
  writeQueue(profile, next);
}

function deliver(profile: string, item: QueuedFeedback, url: string): Promise<FeedbackResult> {
  const operation = key(profile, item.submission_id);
  const existing = active.get(operation);
  if (existing) return existing.promise;
  let attempted: QueuedFeedback;
  try {
    const current = readQueue(profile);
    const latest = current.find((row) => row.submission_id === item.submission_id);
    if (!latest)
      return Promise.resolve({
        success: false,
        queued: false,
        submission_id: item.submission_id,
        error: 'cancelled',
      });
    if (completed(latest))
      return Promise.resolve({ success: true, submission_id: item.submission_id });
    attempted = { ...latest, attempt_count: Math.min(1000, (latest.attempt_count ?? 0) + 1) };
    if (attempted.attempt_count! > 1) attempted = withReceipt(attempted, 'retry', Date.now());
    writeQueue(
      profile,
      current.map((row) => (row.submission_id === item.submission_id ? attempted : row))
    );
  } catch (error) {
    return Promise.resolve(failure(error, item.submission_id));
  }
  if ((attempted.attempt_count ?? 0) > 1) replayReceipts(profile, item.submission_id, 'retry');
  const controller = new AbortController();
  const promise = (async (): Promise<FeedbackResult> => {
    const outcome = await sendFeedbackTransport(attempted, url, controller);
    const observedAtMs = Date.now();
    try {
      const current = readQueue(profile).find((row) => row.submission_id === item.submission_id);
      if (!current || current.queue_state === 'held')
        return {
          success: false,
          queued: false,
          submission_id: item.submission_id,
          error: 'cancelled',
        };
      if (outcome === 'accepted') {
        update(profile, item.submission_id, 'accepted', 'backend_accepted', observedAtMs);
        replayReceipts(profile, item.submission_id);
        return { success: true, submission_id: item.submission_id };
      }
      if (['permanent_refusal', 'delivery_unconfirmed', 'cancelled'].includes(outcome)) {
        update(
          profile,
          item.submission_id,
          outcome === 'permanent_refusal' ? 'refused' : 'held',
          outcome === 'cancelled' ? 'cancelled' : 'refused',
          observedAtMs,
          outcome
        );
        replayReceipts(profile, item.submission_id);
        return { success: false, queued: false, submission_id: item.submission_id, error: outcome };
      }
      report(profile, item.submission_id, 'deferred', observedAtMs, outcome);
      return { success: false, queued: true, submission_id: item.submission_id, error: outcome };
    } catch (error) {
      return failure(error, item.submission_id);
    }
  })().finally(() => {
    active.delete(operation);
  });
  active.set(operation, { controller, promise });
  return promise;
}

export async function submitFeedback(
  payload: FeedbackPayload,
  url: string,
  profile: string,
  installId: () => string
): Promise<FeedbackResult> {
  if (typeof payload?.message !== 'string') {
    reportRefusal(randomUUID(), 'invalid_payload');
    return failure(new QueueFailure('invalid_payload'));
  }
  const message = sanitizeFeedbackText(payload.message).trim();
  if (
    !message ||
    message.length > 2000 ||
    (payload.submission_id !== undefined && !UUID.test(payload.submission_id)) ||
    (payload.app_version !== undefined &&
      (typeof payload.app_version !== 'string' || payload.app_version.length > 100)) ||
    (payload.platform_info !== undefined &&
      (typeof payload.platform_info !== 'string' || payload.platform_info.length > 1000))
  ) {
    reportRefusal(randomUUID(), 'invalid_payload');
    return failure(new QueueFailure('invalid_payload'));
  }
  const id = payload.submission_id ?? randomUUID();
  let item: QueuedFeedback;
  try {
    const queue = readQueue(profile);
    const previous = queue.find((row) => row.submission_id === id);
    const proposed: QueuedFeedback = {
      message,
      app_version: payload.app_version,
      platform_info: payload.platform_info,
      submission_id: id,
      timestamp: new Date().toISOString(),
      install_id: installId(),
      user_agent: `DNAForge/${payload.app_version ?? 'unknown'} Electron`,
      queue_state: 'pending',
      telemetry: previous ? previous.telemetry : captureOrigin(),
    };
    if (previous && !samePayload(previous, proposed))
      return failure(new QueueFailure('submission_conflict'), id);
    if (previous && completed(previous)) {
      replayReceipts(profile, id);
      return { success: true, submission_id: id };
    }
    if (!previous && queue.filter((row) => !completed(row)).length >= QUEUE_MAX) {
      reportRefusal(id, 'queue_full');
      return failure(new QueueFailure('queue_full'), id);
    }
    item = previous ? { ...previous, queue_state: 'pending' } : proposed;
    if (!previous) item = withReceipt(item, 'accepted_intent', Date.parse(item.timestamp));
    writeQueue(
      profile,
      previous ? queue.map((row) => (row.submission_id === id ? item : row)) : [...queue, item]
    );
    if (!previous) {
      replayReceipts(profile, id, 'accepted_intent');
      report(profile, id, 'durable_queue', Date.now());
    }
  } catch (error) {
    reportRefusal(id, error instanceof QueueFailure ? error.reason : 'storage_unavailable');
    return failure(error, id);
  }
  return deliver(profile, item, url);
}

export function cancelFeedback(profile: string, id: string): FeedbackResult {
  if (typeof id !== 'string' || !UUID.test(id)) return failure(new QueueFailure('invalid_payload'));
  let item: QueuedFeedback | undefined;
  try {
    item = readQueue(profile).find((row) => row.submission_id === id);
    if (item && completed(item)) {
      replayReceipts(profile, id);
      return { success: true, submission_id: id };
    }
    update(profile, id, 'held', 'cancelled', Date.now(), 'cancelled');
  } catch (error) {
    return failure(error, id);
  }
  if (item) replayReceipts(profile, id, 'cancelled');
  active.get(key(profile, id))?.controller.abort();
  return { success: false, queued: false, error: 'cancelled', submission_id: id };
}

export function drainFeedback(url: string, profile: string): Promise<void> {
  const existing = drains.get(profile);
  if (existing) return existing;
  const promise = (async () => {
    let items: QueuedFeedback[];
    try {
      items = readQueue(profile);
    } catch {
      return;
    }
    for (const snapshot of items) {
      replayReceipts(profile, snapshot.submission_id);
      let current: QueuedFeedback | undefined;
      try {
        current = readQueue(profile).find((row) => row.submission_id === snapshot.submission_id);
      } catch {
        return;
      }
      if (current?.queue_state === 'pending') await deliver(profile, current, url);
    }
  })().finally(() => {
    drains.delete(profile);
  });
  drains.set(profile, promise);
  return promise;
}

export function replayFeedbackTelemetry(profile: string): void {
  try {
    for (const item of readQueue(profile)) replayReceipts(profile, item.submission_id);
  } catch (_error) {
    void _error;
  }
}

export function clearFeedbackTelemetryOrigins(profile: string): void {
  const current = readQueue(profile);
  if (current.some((row) => row.telemetry))
    writeQueue(
      profile,
      current
        .filter((row) => !completed(row))
        .map((row) => ({ ...row, telemetry: null, telemetry_receipts: [] }))
    );
}

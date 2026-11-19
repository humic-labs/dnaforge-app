import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical-json';
import { freezeComputeRequest, type FrozenComputeRequest } from '../../shared/compute-request';
import {
  canonicalPredictionProtein,
  submittedProteins,
} from '../../shared/compute-protein-sequence';
import { isWorkspaceSyncDatabaseBusyError } from '../../shared/workspace-sync-errors';

import type Database from 'better-sqlite3';

import { COMPUTE_CREDENTIAL_HEADER } from '../../shared/compute-ipc';
import {
  TERMINAL_COMPUTE_JOB_STATES,
  parseComputeResultTarget,
  type ComputeImportDetails,
  type ComputeJobIntentInput,
  type ComputeJobIntentReceipt,
  type ComputeJobRecord,
  type ComputeJobState,
  type ComputeJobsListOptions,
  type ComputeJobsSnapshot,
  type ComputeJobsSnapshotOptions,
  type ComputeJobTerminalEvent,
  type ComputeRecoveryResult,
} from '../../shared/compute-jobs-ipc';

type SidecarFetch = (pathOrUrl: string | URL, init?: RequestInit) => Promise<Response>;

export interface ComputeJobsDeps {
  db: () => Database.Database;
  sidecarFetch: SidecarFetch;
  readCredential: (providerId: string) => Promise<string | null>;
  grantedCapabilities: () => string[];
  notifyTerminal?: (event: ComputeJobTerminalEvent) => void;
  observeLifecycle?: (record: ComputeJobRecord) => void;
  recoverLegacyResult?: (
    record: ComputeJobRecord,
    assertCurrent: () => void
  ) => Promise<ComputeRecoveryResult>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  createPollAbortSignal?: () => AbortSignal;
  random?: () => number;
}

export const POLL_BASE_MS = 15_000;
export const POLL_SLOW_MS = 60_000;
export const POLL_SLOW_AFTER_MS = 10 * 60_000;
export const POLL_JITTER_MS = 3_000;
export const POLL_REQUEST_TIMEOUT_MS = 30_000;

interface Row {
  id: string;
  provider: string;
  tool_id: string;
  label: string | null;
  settings_hash: string;
  settings_json: string;
  result_target_json: string | null;
  request_json: string | null;
  request_hash: string | null;
  input_files_json: string | null;
  idempotency_key: string | null;
  provider_job_ref: string | null;
  state: string;
  provider_state: string;
  cost_estimate: number | null;
  cost_estimate_unit: string | null;
  cost_actual: number | null;
  cost_actual_unit: string | null;
  terms_snapshot_json: string | null;
  workspace_root: string | null;
  source_path?: string | null;
  source_name?: string | null;
  imported_paths_json: string | null;
  last_error: string | null;
  poll_count: number;
  next_poll_at: number | null;
  created_at: number;
  updated_at: number;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function toRecord(row: Row): ComputeJobRecord {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  let importedPaths: string[] = [];
  try {
    importedPaths = row.imported_paths_json
      ? (JSON.parse(row.imported_paths_json) as string[])
      : [];
  } catch {
    importedPaths = [];
  }
  return {
    id: row.id,
    provider: row.provider,
    toolId: row.tool_id,
    label: row.label,
    settingsHash: row.settings_hash,
    settings,
    requestHash: row.request_hash ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    inputFiles: row.input_files_json ? JSON.parse(row.input_files_json) : [],
    resultTarget: row.result_target_json
      ? parseComputeResultTarget(JSON.parse(row.result_target_json))
      : null,
    remoteId: row.provider_job_ref,
    state: row.state as ComputeJobState,
    providerState: row.provider_state,
    costEstimate: row.cost_estimate,
    costEstimateUnit: row.cost_estimate_unit,
    costActual: row.cost_actual,
    costActualUnit: row.cost_actual_unit,
    workspaceRoot: row.workspace_root,
    sourcePath: row.source_path ?? null,
    sourceName: row.source_name ?? null,
    importedPaths,
    lastError: row.last_error,
    pollCount: row.poll_count,
    nextPollAt: iso(row.next_poll_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function settingsHash(settings: Record<string, unknown>): string {
  const canonical = canonicalJson(settings);
  return createHash('sha256').update(canonical).digest('hex');
}

function stateFromWire(state: string): ComputeJobState {
  switch (state) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'canceled':
      return state;
    default:
      return 'running';
  }
}

type ProviderPollStatus = {
  state: string;
  provider_state: string;
  cost_amount: number | null;
  cost_unit: string | null;
  terminal: boolean;
};

type PollOutcome =
  | { kind: 'retry'; error: string }
  | { kind: 'missing'; error: string }
  | { kind: 'status'; status: ProviderPollStatus };

export function relocateImportedResult(
  db: Database.Database,
  input: {
    provider: string;
    remoteId: string;
    moved: Readonly<Record<string, string>>;
    removed: readonly string[];
    details: ComputeImportDetails | null;
    now: number;
  }
): number {
  const rows = db
    .prepare(
      `SELECT id, imported_paths_json FROM compute_jobs WHERE provider = ? AND provider_job_ref = ?`
    )
    .all(input.provider, input.remoteId) as Array<{
    id: string;
    imported_paths_json: string | null;
  }>;
  const removed = new Set(input.removed);
  let updated = 0;
  for (const row of rows) {
    const paths = row.imported_paths_json ? (JSON.parse(row.imported_paths_json) as string[]) : [];
    if (!paths.some((path) => path in input.moved || removed.has(path))) continue;
    const relocated = [
      ...new Set(
        paths.filter((path) => !removed.has(path)).map((path) => input.moved[path] ?? path)
      ),
    ];
    db.prepare(
      `UPDATE compute_jobs SET imported_paths_json = ?, import_details_json = COALESCE(import_details_json, ?), updated_at = ? WHERE id = ?`
    ).run(
      JSON.stringify(relocated),
      input.details ? JSON.stringify(input.details) : null,
      input.now,
      row.id
    );
    updated += 1;
  }
  return updated;
}

export class ComputeJobRegistry {
  private readonly deps: Required<
    Pick<ComputeJobsDeps, 'now' | 'schedule' | 'createPollAbortSignal' | 'random'>
  > &
    ComputeJobsDeps;
  private timer: { cancel: () => void } | null = null;
  private polling = false;
  private stopped = false;
  private readonly activeRecoveries = new Map<
    string,
    { db: Database.Database; result: Promise<ComputeRecoveryResult> }
  >();
  private readonly recoveringResults = new Set<string>();
  private readonly requestedRecoveryRetries = new Set<string>();
  private readonly recoveryTails = new Map<string, Promise<void>>();
  private readonly recoveryRetryTimers = new Map<string, { cancel: () => void }>();

  constructor(deps: ComputeJobsDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      schedule:
        deps.schedule ??
        ((fn, ms) => {
          const handle = setTimeout(fn, ms);
          return { cancel: () => clearTimeout(handle) };
        }),
      createPollAbortSignal:
        deps.createPollAbortSignal ?? (() => AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)),
      random: deps.random ?? Math.random,
    };
  }

  recordIntent(input: ComputeJobIntentInput): ComputeJobIntentReceipt {
    const now = this.deps.now();
    const resultTarget = input.resultTarget ? parseComputeResultTarget(input.resultTarget) : null;
    const id = randomUUID();
    const request = freezeComputeRequest(input.provider, input.toolId, input.settings, input.files);
    const requestJson = canonicalJson(request);
    const requestHash = createHash('sha256').update(requestJson).digest('hex');
    const idempotencyKey = input.idempotencyKey ?? `dnaforge-compute-${id}`;
    if (!idempotencyKey || idempotencyKey.length > 128)
      throw new Error('A compute idempotency key must contain 1–128 characters.');
    const fileWitnesses = Object.entries(request.files).map(([name, text]) => ({
      name,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      byteLength: Buffer.byteLength(text, 'utf8'),
    }));
    const db = this.deps.db();
    db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT id, state FROM compute_jobs
        WHERE provider = ? AND (idempotency_key = ? OR
          (tool_id = ? AND state IN ('intent','submission-unknown','submitted','queued','running')
            AND (request_hash = ? OR (request_hash IS NULL AND settings_hash = ?))))
        ORDER BY CASE WHEN idempotency_key = ? THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
        )
        .get(
          input.provider,
          idempotencyKey,
          input.toolId,
          requestHash,
          settingsHash(request.settings),
          idempotencyKey
        ) as { id: string; state: string } | undefined;
      if (existing)
        throw new Error(
          `Compute job ${existing.id} already records this request or idempotency key (${existing.state}). Resolve or reuse that job before submitting again.`
        );
      db.prepare(
        `INSERT INTO compute_jobs (id, provider, tool_id, label, settings_hash, settings_json, provider_job_ref,
           state, provider_state, cost_estimate, cost_estimate_unit, terms_snapshot_json, workspace_root,
           source_path, source_name, result_target_json, request_json, request_hash, input_files_json, idempotency_key,
           poll_count, next_poll_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'intent', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      ).run(
        id,
        input.provider,
        input.toolId,
        input.label,
        settingsHash(request.settings),
        canonicalJson(request.settings),
        input.costEstimate,
        input.costEstimateUnit,
        input.termsSnapshot ? JSON.stringify(input.termsSnapshot) : null,
        input.workspaceRoot,
        input.sourcePath ?? null,
        input.sourceName ?? null,
        resultTarget ? JSON.stringify(resultTarget) : null,
        requestJson,
        requestHash,
        JSON.stringify(fileWitnesses),
        idempotencyKey,
        now,
        now
      );
    }).immediate();
    return { ...this.get(id)!, submissionRequest: request };
  }

  markSubmitted(id: string, remoteId: string): ComputeJobRecord | null {
    if (!remoteId.trim() || remoteId.length > 256)
      throw new Error('The provider did not acknowledge a valid job identity.');
    const now = this.deps.now();
    this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET provider_job_ref = ?, state = 'submitted', next_poll_at = ?, updated_at = ?, last_error = NULL
         WHERE id = ? AND state IN ('intent','submission-unknown') AND provider_job_ref IS NULL`
      )
      .run(remoteId, now + this.pollDelay(0), now, id);
    this.kick();
    const record = this.get(id);
    if (record?.state === 'submitted') this.deps.observeLifecycle?.(record);
    return record;
  }

  markFailed(id: string, error: string): ComputeJobRecord | null {
    const now = this.deps.now();
    this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET state = 'failed', last_error = ?, next_poll_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'intent' AND provider_job_ref IS NULL`
      )
      .run(error.slice(0, 2000), now, id);
    return this.announce(this.get(id));
  }

  markSubmissionUnknown(id: string, error: string): ComputeJobRecord | null {
    this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET state = 'submission-unknown',
      last_error = ?, next_poll_at = NULL, updated_at = ?
      WHERE id = ? AND state IN ('intent','submission-unknown') AND provider_job_ref IS NULL`
      )
      .run(error.slice(0, 2000), this.deps.now(), id);
    return this.get(id);
  }

  markCanceled(id: string, providerState: string): ComputeJobRecord | null {
    const now = this.deps.now();
    const update = this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET state = 'canceled', provider_state = ?, next_poll_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND state IN ('submitted','queued','running')`
      )
      .run(providerState.slice(0, 500), now, id);
    const record = this.get(id);
    return update.changes > 0 ? this.announce(record) : record;
  }

  markImported(
    id: string,
    paths: string[],
    details?: ComputeImportDetails | null
  ): ComputeJobRecord | null {
    const now = this.deps.now();
    this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET state = 'imported', imported_paths_json = ?, import_details_json = COALESCE(?, import_details_json), next_poll_at = NULL, updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(paths), details ? JSON.stringify(details) : null, now, id);
    const record = this.announce(this.get(id));
    if (record?.state === 'imported') this.recoverImportedResult(record);
    return record;
  }

  importDetails(id: string): ComputeImportDetails | null {
    const row = this.deps
      .db()
      .prepare(`SELECT import_details_json FROM compute_jobs WHERE id = ?`)
      .get(id) as { import_details_json: string | null } | undefined;
    return row?.import_details_json
      ? (JSON.parse(row.import_details_json) as ComputeImportDetails)
      : null;
  }

  get(id: string): ComputeJobRecord | null {
    const row = this.deps.db().prepare(`SELECT * FROM compute_jobs WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toRecord(row) : null;
  }

  async readCompletedResult(id: string): Promise<{
    job: ComputeJobRecord;
    request: FrozenComputeRequest | null;
    result: {
      ref: { provider: string; remote_id: string; tool_id: string };
      output_kind: string;
      files: Array<{
        name: string;
        media_type: string;
        size_bytes: number | null;
        content: string | null;
        url: string | null;
      }>;
      metrics: Record<string, unknown>;
      provenance: Record<string, string>;
      provider_request?: unknown;
    };
  }> {
    let job = this.get(id);
    if (job?.remoteId && ['submitted', 'queued', 'running'].includes(job.state)) {
      await this.pollOne(job);
      job = this.get(id);
    }
    if (!job?.remoteId || !['completed', 'imported'].includes(job.state))
      throw new Error('A reusable prediction needs a completed, durable compute run.');
    const secret = await this.deps.readCredential(job.provider);
    if (!secret) throw new Error('Connect the prediction provider to verify this result.');
    const response = await this.deps.sidecarFetch(
      `/compute/${encodeURIComponent(job.provider)}/result`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [COMPUTE_CREDENTIAL_HEADER]: secret },
        body: JSON.stringify({
          granted_capabilities: this.deps.grantedCapabilities(),
          remote_id: job.remoteId,
          tool_id: job.toolId,
        }),
        signal: AbortSignal.timeout(60_000),
      }
    );
    if (!response.ok)
      throw new Error(
        `The prediction provider could not verify this result (HTTP ${response.status}).`
      );
    const result = (await response.json()) as Awaited<
      ReturnType<ComputeJobRegistry['readCompletedResult']>
    >['result'];
    if (
      result.ref?.provider !== job.provider ||
      result.ref?.remote_id !== job.remoteId ||
      result.ref?.tool_id !== job.toolId ||
      !Array.isArray(result.files) ||
      !result.provenance ||
      result.provenance.livemode === 'false'
    )
      throw new Error('The result does not attest this live prediction run.');
    const current = this.get(id);
    if (
      !current ||
      current.remoteId !== job.remoteId ||
      current.provider !== job.provider ||
      current.toolId !== job.toolId ||
      canonicalJson(current.settings) !== canonicalJson(job.settings) ||
      !['completed', 'imported'].includes(current.state)
    )
      throw new Error('The compute run changed while its result was being verified.');
    const retained = this.deps
      .db()
      .prepare('SELECT request_json FROM compute_jobs WHERE id = ?')
      .get(id) as { request_json: string | null };
    let request: FrozenComputeRequest | null = null;
    if (retained.request_json) {
      const raw = JSON.parse(retained.request_json) as FrozenComputeRequest;
      request = freezeComputeRequest(raw.provider, raw.toolId, raw.settings, raw.files);
      if (
        raw.schemaVersion !== 1 ||
        request.provider !== current.provider ||
        request.toolId !== current.toolId ||
        canonicalJson(request.settings) !== canonicalJson(current.settings) ||
        createHash('sha256').update(canonicalJson(request)).digest('hex') !== current.requestHash
      )
        throw new Error('The retained complete compute request failed its integrity check.');
    }
    return { job: current, result, request };
  }

  findByRemote(provider: string, remoteId: string): ComputeJobRecord | null {
    const row = this.deps
      .db()
      .prepare(
        `SELECT * FROM compute_jobs WHERE provider = ? AND provider_job_ref = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(provider, remoteId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  list(options: ComputeJobsListOptions = {}): ComputeJobRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const states = options.states?.length ? options.states : null;
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (states) {
      clauses.push(`state IN (${states.map(() => '?').join(',')})`);
      parameters.push(...states);
    }
    if (options.requestHash !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(options.requestHash))
        throw new Error('Complete-request lookup requires a SHA-256 digest.');
      clauses.push('request_hash = ?');
      parameters.push(options.requestHash);
    }
    const protein =
      options.proteinSequence === undefined
        ? null
        : canonicalPredictionProtein(options.proteinSequence);
    const query = this.deps.db().prepare(`SELECT * FROM compute_jobs
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC`);
    const matches: ComputeJobRecord[] = [];
    for (const value of query.iterate(...parameters)) {
      const job = toRecord(value as Row);
      if (protein) {
        try {
          if (!submittedProteins(job.settings).includes(protein)) continue;
        } catch {
          continue;
        }
      }
      matches.push(job);
      if (matches.length === limit) break;
    }
    return matches;
  }

  snapshot(options: ComputeJobsSnapshotOptions = {}): ComputeJobsSnapshot {
    const requested = options.historyLimit ?? 200;
    const historyLimit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 1000)
      : 200;
    const db = this.deps.db();
    return db.transaction(() => {
      const counts = db
        .prepare(
          `SELECT COUNT(*) AS jobCount,
        COALESCE(SUM(CASE WHEN state IN ('intent','submitted','queued','running') THEN 1 ELSE 0 END), 0) AS activeCount,
        COALESCE(SUM(CASE WHEN state IN ('completed','failed','canceled','imported') THEN 1 ELSE 0 END), 0) AS terminalCount
        FROM compute_jobs`
        )
        .get() as { jobCount: number; activeCount: number; terminalCount: number };
      const rows = db
        .prepare(
          `SELECT * FROM compute_jobs
        WHERE state IN ('intent','submitted','queued','running') OR id IN (
          SELECT id FROM compute_jobs WHERE state IN ('completed','failed','canceled','imported')
          ORDER BY created_at DESC, id DESC LIMIT ?
        ) ORDER BY created_at DESC, id DESC`
        )
        .all(historyLimit) as Row[];
      return {
        jobs: rows.map(toRecord),
        ...counts,
        activeComplete: true as const,
        historyComplete: counts.terminalCount <= historyLimit,
        historyLimit,
      };
    })();
  }

  private pollDelay(ageMs: number): number {
    const base = ageMs >= POLL_SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_BASE_MS;
    return base + Math.floor(this.deps.random() * POLL_JITTER_MS);
  }

  start(): void {
    this.stopped = false;
    const now = this.deps.now();
    this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET state = 'submission-unknown',
      last_error = COALESCE(last_error, 'DNAForge restarted before submission was acknowledged. Check the provider before sending another job.'),
      next_poll_at = NULL, updated_at = ? WHERE state = 'intent' AND provider_job_ref IS NULL`
      )
      .run(now);
    this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET next_poll_at = ? WHERE state IN ('submitted','queued','running') AND (next_poll_at IS NULL OR next_poll_at > ?)`
      )
      .run(now, now + POLL_SLOW_MS);
    this.kick();
    this.retryLegacyResultMigrations();
  }

  retryLegacyResultMigrations(): void {
    if (this.stopped) return;
    if (this.deps.recoverLegacyResult) {
      const rows = this.deps
        .db()
        .prepare("SELECT * FROM compute_jobs WHERE state='imported' ORDER BY created_at,id")
        .all() as Row[];
      for (const row of rows) {
        if (this.recoveringResults.has(row.id)) this.requestedRecoveryRetries.add(row.id);
        else this.recoverImportedResult(toRecord(row));
      }
    }
  }

  async recoverLegacyResult(job: ComputeJobRecord): Promise<ComputeRecoveryResult> {
    const recover = this.deps.recoverLegacyResult;
    if (!recover) throw new Error('Compute recovery is unavailable.');
    const db = this.deps.db();
    const assertCurrent = () => {
      if (this.stopped || this.deps.db() !== db) throw new Error('COMPUTE_MIGRATION_OWNER_CHANGED');
    };
    assertCurrent();
    const active = this.activeRecoveries.get(job.id);
    if (active?.db === db) return active.result;
    const result = recover(job, assertCurrent);
    this.activeRecoveries.set(job.id, { db, result });
    try {
      return await result;
    } finally {
      if (this.activeRecoveries.get(job.id)?.result === result)
        this.activeRecoveries.delete(job.id);
    }
  }

  private recoverImportedResult(job: ComputeJobRecord): void {
    if (!this.deps.recoverLegacyResult || this.stopped || !job.workspaceRoot || !job.remoteId)
      return;
    const root = job.workspaceRoot;
    const source = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/compute/${job.provider}/${job.remoteId}/`;
    if (
      this.recoveringResults.has(job.id) ||
      !job.importedPaths.some((path) => path.replace(/\\/g, '/').startsWith(source))
    )
      return;
    const db = this.deps.db();
    this.recoveryRetryTimers.get(job.id)?.cancel();
    this.recoveryRetryTimers.delete(job.id);
    const assertCurrent = () => {
      if (this.stopped || this.deps.db() !== db) throw new Error('COMPUTE_MIGRATION_OWNER_CHANGED');
    };
    this.recoveringResults.add(job.id);
    const operation = (this.recoveryTails.get(root) ?? Promise.resolve()).then(async () => {
      assertCurrent();
      const current = this.get(job.id);
      if (
        !current ||
        current.state !== 'imported' ||
        current.workspaceRoot !== root ||
        current.remoteId !== job.remoteId ||
        current.provider !== job.provider ||
        !current.importedPaths.some((path) => path.replace(/\\/g, '/').startsWith(source))
      )
        return;
      await this.recoverLegacyResult(current);
      assertCurrent();
      db.prepare(
        "UPDATE compute_jobs SET last_error=NULL WHERE id=? AND state='imported' AND last_error LIKE 'Automatic result conversion remains pending:%'"
      ).run(job.id);
    });
    const settled = operation
      .catch((error: unknown) => {
        if (this.stopped || this.deps.db() !== db) return;
        const reason = error instanceof Error ? error.message : String(error);
        db.prepare(
          "UPDATE compute_jobs SET last_error=? WHERE id=? AND state='imported' AND workspace_root=? AND provider_job_ref=?"
        ).run(`Automatic result conversion remains pending: ${reason}`, job.id, root, job.remoteId);
        if (isWorkspaceSyncDatabaseBusyError(error) && !this.recoveryRetryTimers.has(job.id)) {
          this.recoveryRetryTimers.set(
            job.id,
            this.deps.schedule(() => {
              this.recoveryRetryTimers.delete(job.id);
              if (this.stopped || this.deps.db() !== db) return;
              const current = this.get(job.id);
              if (
                current?.state === 'imported' &&
                current.workspaceRoot === root &&
                current.provider === job.provider &&
                current.remoteId === job.remoteId
              )
                this.recoverImportedResult(current);
            }, POLL_BASE_MS)
          );
        }
      })
      .finally(() => {
        this.recoveringResults.delete(job.id);
        if (this.recoveryTails.get(root) === settled) this.recoveryTails.delete(root);
        if (
          this.requestedRecoveryRetries.delete(job.id) &&
          !this.stopped &&
          this.deps.db() === db
        ) {
          const current = this.get(job.id);
          if (current?.state === 'imported') this.recoverImportedResult(current);
        }
      });
    this.recoveryTails.set(root, settled);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    for (const timer of this.recoveryRetryTimers.values()) timer.cancel();
    this.recoveryRetryTimers.clear();
  }

  private kick(): void {
    if (this.stopped || this.timer) return;
    const due = this.nextDue();
    if (due === null) return;
    const wait = Math.max(0, due - this.deps.now());
    this.timer = this.deps.schedule(() => {
      this.timer = null;
      void this.pollDue().finally(() => this.kick());
    }, wait);
  }

  private nextDue(): number | null {
    const row = this.deps
      .db()
      .prepare(
        `SELECT MIN(next_poll_at) AS due FROM compute_jobs WHERE state IN ('submitted','queued','running') AND next_poll_at IS NOT NULL`
      )
      .get() as { due: number | null } | undefined;
    return row?.due ?? null;
  }

  async pollDue(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const now = this.deps.now();
      const rows = this.deps
        .db()
        .prepare(
          `SELECT * FROM compute_jobs WHERE state IN ('submitted','queued','running') AND next_poll_at IS NOT NULL AND next_poll_at <= ? ORDER BY next_poll_at ASC LIMIT 50`
        )
        .all(now) as Row[];
      for (const row of rows) {
        await this.pollOne(toRecord(row));
      }
      return rows.length;
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(job: ComputeJobRecord): Promise<void> {
    const outcome = await this.readPollOutcome(job);
    const now = this.deps.now();
    const age = now - new Date(job.createdAt).getTime();
    if (outcome.kind === 'retry') {
      this.deps
        .db()
        .prepare(
          `UPDATE compute_jobs SET poll_count = poll_count + 1, next_poll_at = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND state IN ('submitted','queued','running')`
        )
        .run(now + this.pollDelay(age), outcome.error, now, job.id);
      return;
    }
    if (outcome.kind === 'missing') {
      const update = this.deps
        .db()
        .prepare(
          `UPDATE compute_jobs SET state = 'failed', last_error = ?, next_poll_at = NULL, updated_at = ?
         WHERE id = ? AND state IN ('submitted','queued','running')`
        )
        .run(outcome.error, now, job.id);
      if (update.changes > 0) this.announce(this.get(job.id));
      return;
    }
    const { status } = outcome;
    const state = stateFromWire(status.state);
    const terminal = TERMINAL_COMPUTE_JOB_STATES.has(state);
    const update = this.deps
      .db()
      .prepare(
        `UPDATE compute_jobs SET state = ?, provider_state = ?, cost_actual = COALESCE(?, cost_actual), cost_actual_unit = COALESCE(?, cost_actual_unit),
           poll_count = poll_count + 1, next_poll_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ? AND state IN ('submitted','queued','running')`
      )
      .run(
        state,
        status.provider_state ?? '',
        status.cost_amount,
        status.cost_unit,
        terminal ? null : now + this.pollDelay(age),
        now,
        job.id
      );
    if (terminal && update.changes > 0) this.announce(this.get(job.id));
  }

  private async readPollOutcome(job: ComputeJobRecord): Promise<PollOutcome> {
    if (!job.remoteId) return { kind: 'retry', error: 'job has no provider id' };
    let pollSignal: AbortSignal | undefined;
    try {
      const secret = await this.deps.readCredential(job.provider);
      if (!secret) return { kind: 'retry', error: 'no credential connected for this provider' };
      pollSignal = this.deps.createPollAbortSignal();
      const response = await this.deps.sidecarFetch(
        `/compute/${encodeURIComponent(job.provider)}/status`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [COMPUTE_CREDENTIAL_HEADER]: secret },
          body: JSON.stringify({
            granted_capabilities: this.deps.grantedCapabilities(),
            remote_id: job.remoteId,
            tool_id: job.toolId,
          }),
          signal: pollSignal,
        }
      );
      if (!response.ok) {
        let error = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { detail?: { error?: string } };
          if (body.detail?.error) error = body.detail.error;
        } catch {}
        return response.status === 404
          ? { kind: 'missing', error: `provider has no record of this job (${error})` }
          : { kind: 'retry', error };
      }
      const status = (await response.json()) as ProviderPollStatus;
      if (!status || typeof status.state !== 'string') {
        return { kind: 'retry', error: 'provider returned an invalid job status' };
      }
      return { kind: 'status', status };
    } catch (error) {
      return {
        kind: 'retry',
        error: pollSignal?.aborted
          ? 'provider status request timed out'
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  private announce(record: ComputeJobRecord | null): ComputeJobRecord | null {
    if (record && TERMINAL_COMPUTE_JOB_STATES.has(record.state)) {
      this.deps.observeLifecycle?.(record);
      this.deps.notifyTerminal?.({
        id: record.id,
        provider: record.provider,
        toolId: record.toolId,
        remoteId: record.remoteId,
        label: record.label,
        state: record.state,
        workspaceRoot: record.workspaceRoot,
        importedPaths: record.importedPaths,
        lastError: record.lastError,
      });
    }
    return record;
  }
}

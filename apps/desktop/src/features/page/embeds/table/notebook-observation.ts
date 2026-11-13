import type { Editor, JSONContent } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { platform } from '../../../../platform';
import {
  captureAnalyticsOptionalOrigin,
  getAnalyticsIdentifiedAccountId,
  isAnalyticsCaptureReady,
  subscribeAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../../../lib/analytics';
import { getTelemetryCorrelationContext } from '../../../../lib/telemetry-correlation';
import { beginWorkflowAction, observeWorkflowAction } from '../../../../lib/workflow-telemetry';
import type {
  WorkflowOutcomeKind,
  WorkflowStatus,
} from '../../../../shared/scientific-workflow-vocab';
import type { OptionalTelemetryOrigin } from '../../../../shared/analytics-types';
import {
  TABLE_NOTEBOOK_RECEIPT_PREFIX,
  isTableOperationObservation,
  type TableOperation,
  type TableOperationObservation,
} from '../../../../shared/table-notebook-observation';
import { withNotebookAuthorityOperation } from '../../notebook-authority-queue';
import { canonicalNotebookJson } from '../../../../db/notebook-markdown-codec';
import type { NotebookDocumentSnapshot } from '../../../../shared/notebook-document';

export const TABLE_NOTEBOOK_UPDATE_META = 'dnaforge-table-notebook-update-v1';
const RECEIPT_TTL_MS = 86_400_000;
const MAX_RECEIPTS = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sameContext(a: OptionalTelemetryOrigin, b: OptionalTelemetryOrigin): boolean {
  return (
    a.consentScope === b.consentScope &&
    a.contextId === b.contextId &&
    a.classification === b.classification
  );
}

function captureOriginGuard() {
  const origin = captureAnalyticsOptionalOrigin();
  if (!origin || !isAnalyticsCaptureReady()) {
    return { origin: null, episode: null, allowed: () => false, dispose: () => {} };
  }
  const account = getAnalyticsIdentifiedAccountId();
  const episode = { ...getTelemetryCorrelationContext() };
  let live = origin !== null && isAnalyticsCaptureReady();
  const allowed = () => {
    const current = captureAnalyticsOptionalOrigin();
    const context = getTelemetryCorrelationContext();
    if (
      !current ||
      !origin ||
      !sameContext(current, origin) ||
      current.processId !== origin.processId ||
      !isAnalyticsCaptureReady() ||
      account !== getAnalyticsIdentifiedAccountId() ||
      context.appSessionId !== episode.appSessionId ||
      context.episodeCorrelationId !== episode.episodeCorrelationId
    )
      live = false;
    return live;
  };
  const dispose = subscribeAnalyticsCaptureReady(() => {
    allowed();
  });
  return { origin, episode, allowed, dispose };
}
type OriginGuard = ReturnType<typeof captureOriginGuard>;

interface TableIntent {
  observation: TableOperationObservation;
  owner: Editor;
  refId: string;
  position: number;
  revisionId: string;
  acceptedAtMs: number;
  guard: OriginGuard | null;
  data: unknown;
}
interface TableRevision {
  intent: TableIntent;
  data: unknown;
  binding: TableSource;
  action: ReturnType<typeof beginWorkflowAction>;
  marker: string;
  committed: boolean;
}
interface TableSource {
  owner: Editor;
  pageId: string;
  workspaceRoot: string;
  current: boolean;
  revisions: Map<string, TableRevision>;
  epoch: number;
  committedEpoch: number;
}
export interface TableNotebookSave {
  readonly source: TableSource;
  readonly revisions: readonly TableRevision[];
  readonly epoch: number;
}
interface TableReceipt {
  observation?: TableOperationObservation;
  version: 1;
  phase: 'accepted' | 'committed' | 'reopened';
  operationId: string;
  revisionId: string;
  acceptedAtMs: number;
  origin: OptionalTelemetryOrigin;
  appSessionId: string;
  episodeCorrelationId: string;
  path?: string;
  authorityFingerprint?: string;
  committedAtMs?: number;
  committedEventId?: string;
  reopenedAtMs?: number;
  reopenedEventId?: string;
  readbackMatch?: boolean;
}

let sources = new WeakMap<Editor, TableSource>();
let snapshots = new WeakMap<JSONContent, TableNotebookSave>();
const currentSources = new Map<string, TableSource>();
const sourceKey = (root: string, pageId: string) => JSON.stringify([root, pageId]);
const receiptPagePrefix = (source: Pick<TableSource, 'workspaceRoot' | 'pageId'>) =>
  TABLE_NOTEBOOK_RECEIPT_PREFIX + sourceKey(source.workspaceRoot, source.pageId) + ':';
const receiptKey = (source: TableSource, refId: string) =>
  receiptPagePrefix(source) + JSON.stringify(refId);

function current(revision: TableRevision): boolean {
  return (
    revision.binding.current &&
    revision.binding.revisions.get(revision.intent.refId) === revision &&
    revision.intent.guard?.allowed() === true
  );
}

function retire(revision: TableRevision, preserveCommitted = false): void {
  try {
    if (!revision.committed && revision.intent.guard?.allowed()) {
      revision.action.cancel({ outcomeKind: 'table_superseded', status: 'cancelled' });
    }
  } catch (_error) {
    void _error;
  } finally {
    revision.intent.guard?.dispose();
  }
  if (preserveCommitted && revision.committed) return;
  const expectedValue = revision.marker;
  void withNotebookAuthorityOperation(revision.binding.pageId, async () => {
    await platform().analytics.writeTableNotebookReceipt?.({
      kind: 'retire',
      key: receiptKey(revision.binding, revision.intent.refId),
      expectedValue,
    });
  }).catch(() => {});
}

export function retireTableNotebookSource(owner: Editor | null): void {
  if (!owner) return;
  const source = sources.get(owner);
  if (!source) return;
  source.current = false;
  for (const revision of source.revisions.values()) retire(revision);
}

export function bindTableNotebookSource(
  owner: Editor,
  pageId: string,
  workspaceRoot: string
): void {
  const existing = sources.get(owner);
  if (existing?.current && existing.pageId === pageId && existing.workspaceRoot === workspaceRoot)
    return;
  if (existing) {
    existing.current = false;
    for (const revision of existing.revisions.values()) retire(revision, true);
  }
  const key = sourceKey(workspaceRoot, pageId);
  const previous = currentSources.get(key);
  if (previous) {
    previous.current = false;
    for (const revision of previous.revisions.values()) retire(revision, true);
  }
  const source: TableSource = {
    owner,
    pageId,
    workspaceRoot,
    current: true,
    revisions: new Map(),
    epoch: 0,
    committedEpoch: 0,
  };
  sources.set(owner, source);
  currentSources.delete(key);
  currentSources.set(key, source);
  if (currentSources.size > MAX_RECEIPTS) {
    const oldest = currentSources.entries().next().value;
    if (oldest) {
      oldest[1].current = false;
      for (const revision of oldest[1].revisions.values()) retire(revision, true);
      currentSources.delete(oldest[0]);
    }
  }
}

export function updateTableNotebookAttributes(
  owner: Editor,
  position: number,
  refId: string,
  patch: Record<string, unknown>,
  observation?: TableOperationObservation
): void {
  if (owner.isDestroyed || !owner.isEditable) throw new Error('The table source is not editable.');
  const before = owner.state.doc;
  const node = before.nodeAt(position);
  if (
    !node ||
    node.type.name !== 'embed' ||
    node.attrs.type !== 'table' ||
    node.attrs.refId !== refId
  ) {
    throw new Error('The table source changed. Reopen the source notebook.');
  }
  const data = { ...node.attrs.data, ...patch };
  let intent: TableIntent | null = null;
  try {
    if (isTableOperationObservation(observation)) {
      intent = {
        owner,
        refId,
        position,
        revisionId: crypto.randomUUID(),
        acceptedAtMs: Date.now(),
        guard: captureOriginGuard(),
        data,
        observation: { ...observation, calculation: { ...observation.calculation } },
      };
    }
  } catch (_error) {
    void _error;
  }
  const transaction = owner.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, data });
  if (intent) transaction.setMeta(TABLE_NOTEBOOK_UPDATE_META, intent);
  try {
    owner.view.dispatch(transaction);
    let admitted = 0;
    owner.state.doc.descendants((candidate) => {
      if (
        candidate.type.name === 'embed' &&
        candidate.attrs.type === 'table' &&
        candidate.attrs.refId === refId &&
        candidate.attrs.data === data
      )
        admitted += 1;
    });
    if (admitted !== 1 || owner.state.doc === before) {
      throw new Error('The table edit was not accepted.');
    }
  } catch (error) {
    intent?.guard?.dispose();
    throw error;
  }
}

export function openTableNotebookView(
  owner: Editor | null,
  position: number,
  refId: string,
  open: () => boolean
): void {
  let source: TableSource | undefined;
  let before: ReturnType<Editor['state']['doc']['nodeAt']> = null;
  let guard: OriginGuard | null = null;
  let atMs = 0;
  try {
    atMs = Date.now();
    source = owner ? sources.get(owner) : undefined;
    if (owner && !owner.isDestroyed) before = owner.state.doc.nodeAt(position);
    guard = captureOriginGuard();
  } catch (_error) {
    void _error;
  }
  let accepted = false;
  try {
    accepted = open();
  } finally {
    try {
      const after = owner?.isDestroyed ? null : owner?.state.doc.nodeAt(position);
      if (
        accepted &&
        owner &&
        source?.current &&
        sources.get(owner) === source &&
        before?.type.name === 'embed' &&
        before.attrs.type === 'table' &&
        before.attrs.refId === refId &&
        after?.attrs.refId === refId &&
        after.attrs.data === before.attrs.data &&
        guard?.allowed()
      ) {
        const action = beginWorkflowAction(
          {
            workflow: 'table',
            action: 'open',
            initiator: 'system',
            artifactCorrelationId:
              source.revisions.get(refId)?.data === before.attrs.data
                ? source.revisions.get(refId)!.intent.revisionId
                : crypto.randomUUID(),
            parentActionId:
              source.revisions.get(refId)?.data === before.attrs.data
                ? source.revisions.get(refId)!.action.actionId
                : undefined,
          },
          {
            now: () => atMs,
            track: (event, properties) =>
              guard?.allowed()
                ? trackRendererEvent(event, { ...properties, table_surface: 'expanded' })
                : false,
          }
        );
        action.complete({ outcomeKind: 'table_open_accepted', status: 'viewed' });
      }
    } catch (_error) {
      void _error;
    } finally {
      try {
        guard?.dispose();
      } catch (_error) {
        void _error;
      }
    }
  }
}

const ACCEPTED_OUTCOME: Record<TableOperation, WorkflowOutcomeKind> = {
  configure: 'table_configure_accepted',
  edit: 'table_edit_accepted',
  paste: 'table_paste_accepted',
  fill: 'table_fill_accepted',
  structure: 'table_structure_accepted',
  replace: 'table_replace_accepted',
  undo: 'table_undo_accepted',
  redo: 'table_redo_accepted',
  format: 'table_format_accepted',
  metadata: 'table_metadata_accepted',
};
const CALCULATION_OUTCOME = {
  evaluated: 'table_calculation_evaluated',
  failed: 'table_calculation_failed',
  saved: 'table_calculation_saved',
  saved_stale: 'table_calculation_saved_stale',
  mixed: 'table_calculation_mixed',
  mixed_failed: 'table_calculation_mixed_failed',
  unavailable: 'table_calculation_unavailable',
} as const;

function emit(
  revision: TableRevision,
  outcomeKind: WorkflowOutcomeKind,
  status: WorkflowStatus,
  atMs = Date.now(),
  calculation = false
): boolean {
  if (!current(revision) || !revision.action.startAccepted) return false;
  return observeWorkflowAction(
    {
      workflow: 'table',
      action: revision.intent.observation.operation === 'configure' ? 'create' : 'update',
      actionId: revision.action.actionId,
      artifactCorrelationId: revision.intent.revisionId,
      tableObservation: revision.intent.observation,
      outcomeKind,
      status,
      phase: calculation ? 'result' : 'commit',
      success:
        status !== 'failed' &&
        status !== 'blocked' &&
        !(calculation && revision.intent.observation.calculation.result === 'unavailable'),
      ...(calculation && status === 'failed' ? { errorClass: 'table_formula_evaluation' } : {}),
      initiator: 'system',
      initiatedAtMs: revision.intent.acceptedAtMs,
    },
    {
      now: () => atMs,
      track: (event, properties) =>
        current(revision) ? trackRendererEvent(event, properties) : false,
    }
  );
}

export function captureTableNotebookDocumentUpdate(input: {
  owner: Editor;
  pageId: string;
  workspaceRoot: string | null;
  transaction: Transaction;
  content: JSONContent;
}): void {
  try {
    if (!input.transaction.docChanged) return;
    const intent = input.transaction.getMeta(TABLE_NOTEBOOK_UPDATE_META) as TableIntent | undefined;
    if (!input.workspaceRoot) {
      intent?.guard?.dispose();
      return;
    }
    bindTableNotebookSource(input.owner, input.pageId, input.workspaceRoot);
    const source = sources.get(input.owner)!;
    source.epoch += 1;
    const dataByRef = new Map<string, unknown>();
    input.owner.state.doc.descendants((node) => {
      if (node.type.name === 'embed' && node.attrs.type === 'table') {
        const ref = node.attrs.refId as string;
        dataByRef.set(ref, dataByRef.has(ref) ? null : node.attrs.data);
      }
    });
    for (const [ref, revision] of source.revisions) {
      if (dataByRef.get(ref) !== revision.data) {
        retire(revision);
        source.revisions.delete(ref);
      }
    }
    if (
      intent?.owner === input.owner &&
      input.transaction.docChanged &&
      dataByRef.get(intent.refId) === intent.data
    ) {
      const previous = source.revisions.get(intent.refId);
      if (previous) retire(previous);
      source.revisions.delete(intent.refId);
      let revision: TableRevision | null = null;
      if (intent.guard?.origin && intent.guard.allowed()) {
        const action = beginWorkflowAction(
          {
            workflow: 'table',
            action: intent.observation.operation === 'configure' ? 'create' : 'update',
            initiator: 'system',
            tableObservation: intent.observation,
            artifactCorrelationId: intent.revisionId,
            outcomeKind: ACCEPTED_OUTCOME[intent.observation.operation],
          },
          {
            now: () => intent.acceptedAtMs,
            track: (event, properties) =>
              intent.guard?.allowed() ? trackRendererEvent(event, properties) : false,
          }
        );
        if (action.startAccepted) {
          const receipt: TableReceipt = {
            version: 1,
            phase: 'accepted',
            observation: intent.observation,
            operationId: action.actionId,
            revisionId: intent.revisionId,
            acceptedAtMs: intent.acceptedAtMs,
            origin: intent.guard.origin,
            appSessionId: intent.guard.episode!.appSessionId,
            episodeCorrelationId: intent.guard.episode!.episodeCorrelationId,
          };
          revision = {
            intent,
            data: dataByRef.get(intent.refId),
            binding: source,
            action,
            marker: JSON.stringify(receipt),
            committed: false,
          };
          source.revisions.set(intent.refId, revision);
        }
      }
      if (!revision) intent.guard?.dispose();
      const accepted = revision;
      void withNotebookAuthorityOperation(input.pageId, async () => {
        const bridge = platform();
        const key = receiptKey(source, intent.refId);
        const rows = await bridge.db.select<{ value: string }[]>(
          'SELECT value FROM settings WHERE key = ?',
          [key]
        );
        const previousValue = rows[0]?.value ?? null;
        if (accepted && current(accepted)) {
          await bridge.analytics.writeTableNotebookReceipt?.({
            kind: 'write',
            key,
            expectedValue: previousValue,
            value: accepted.marker,
            updatedAtMs: intent.acceptedAtMs,
            origin: accepted.intent.guard!.origin!,
          });
        } else if (
          !accepted &&
          previousValue !== null &&
          source.current &&
          !source.revisions.has(intent.refId)
        ) {
          await bridge.analytics.writeTableNotebookReceipt?.({
            kind: 'retire',
            key,
            expectedValue: previousValue,
          });
        }
      }).catch(() => {});
      if (revision) {
        emit(
          revision,
          ACCEPTED_OUTCOME[intent.observation.operation],
          'updated',
          intent.acceptedAtMs
        );
        const result = intent.observation.calculation.result;
        if (result !== 'none')
          emit(
            revision,
            CALCULATION_OUTCOME[result],
            intent.observation.calculation.errorCount > 0
              ? 'failed'
              : result === 'unavailable'
                ? 'needs_action'
                : 'completed',
            intent.acceptedAtMs,
            true
          );
      }
    } else {
      intent?.guard?.dispose();
      void withNotebookAuthorityOperation(input.pageId, async () => {
        const prefix = receiptPagePrefix(source);
        const rows = await platform().db.select<{ key: string; value: string }[]>(
          'SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? LIMIT ?',
          [prefix.length, prefix, MAX_RECEIPTS]
        );
        for (const row of rows) {
          let phase: unknown;
          try {
            phase = (JSON.parse(row.value) as TableReceipt).phase;
          } catch {
            continue;
          }
          if (phase === 'committed' || phase === 'reopened')
            await platform().analytics.writeTableNotebookReceipt?.({
              kind: 'retire',
              key: row.key,
              expectedValue: row.value,
            });
        }
      }).catch(() => {});
    }
    snapshots.set(input.content, {
      source,
      epoch: source.epoch,
      revisions: [...source.revisions.values()].filter((r) => !r.committed),
    });
  } catch (_error) {
    void _error;
  }
}

export function captureTableNotebookSave(
  pageId: string,
  content: JSONContent
): TableNotebookSave | null {
  const snapshot = snapshots.get(content);
  return snapshot?.source.pageId === pageId ? snapshot : null;
}

export interface NativeTableNotebookSave {
  readonly observation: TableNotebookSave;
  readonly content: JSONContent;
}

export function captureNativeTableNotebookSave(
  pageId: string,
  content: JSONContent
): NativeTableNotebookSave | null {
  const observation = captureTableNotebookSave(pageId, content);
  return observation?.revisions.length ? { observation, content } : null;
}

export async function confirmNativeTableNotebookSave(
  save: NativeTableNotebookSave | null,
  captured: Pick<NotebookDocumentSnapshot, 'documentId' | 'revision' | 'copy'>,
  committed: Pick<
    NotebookDocumentSnapshot,
    'documentId' | 'persistedRevision' | 'workspaceRoot' | 'path' | 'canonicalFingerprint'
  >
): Promise<void> {
  try {
    if (
      !save ||
      captured.documentId !== save.observation.source.pageId ||
      committed.documentId !== captured.documentId ||
      committed.persistedRevision !== captured.revision ||
      canonicalNotebookJson(captured.copy.content) !== canonicalNotebookJson(save.content)
    )
      return;
    await confirmTableNotebookCommit(save.observation, {
      workspaceRoot: committed.workspaceRoot,
      artifact: {
        path: committed.path,
        fileKind: 'waypoint-notebook',
        authorityFingerprint: committed.canonicalFingerprint,
      },
      committedAtMs: Date.now(),
      projectionSettled: true,
    });
  } catch (_error) {
    void _error;
  }
}

export function observeTableNotebookSaveFailure(
  snapshot: TableNotebookSave | null,
  error?: unknown
): void {
  try {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : null;
    const outcome =
      code === 'NOTEBOOK_EXTERNAL_CONFLICT' || name === 'NotebookExternalConflictError'
        ? 'table_save_conflict'
        : error === undefined
          ? 'table_save_unconfirmed'
          : 'table_save_failed';
    for (const revision of snapshot?.revisions ?? []) emit(revision, outcome, 'failed');
  } catch (_error) {
    void _error;
  }
}

export async function confirmTableNotebookCommit(
  snapshot: TableNotebookSave | null,
  input: {
    workspaceRoot: string | null;
    artifact: { path: string; fileKind: string; authorityFingerprint?: string } | null | undefined;
    committedAtMs: number;
    projectionSettled: boolean;
  }
): Promise<void> {
  if (!snapshot) return;
  const artifact = input.artifact;
  if (
    !input.projectionSettled ||
    !artifact?.authorityFingerprint ||
    artifact.fileKind !== 'waypoint-notebook' ||
    input.workspaceRoot !== snapshot.source.workspaceRoot
  ) {
    observeTableNotebookSaveFailure(snapshot);
    return;
  }
  try {
    const bridge = platform();
    if (snapshot.source.current) snapshot.source.committedEpoch = snapshot.epoch;
    for (const revision of snapshot.revisions) {
      if (revision.committed || !current(revision)) continue;
      const receipt = {
        ...(JSON.parse(revision.marker) as TableReceipt),
        phase: 'committed' as const,
        path: artifact.path,
        authorityFingerprint: artifact.authorityFingerprint,
        committedAtMs: input.committedAtMs,
        committedEventId: crypto.randomUUID(),
      };
      const value = JSON.stringify(receipt);
      const key = receiptKey(snapshot.source, revision.intent.refId);
      const written = await bridge.analytics.writeTableNotebookReceipt?.({
        kind: 'write',
        key,
        expectedValue: revision.marker,
        value,
        updatedAtMs: input.committedAtMs,
        origin: revision.intent.guard!.origin!,
      });
      if (!written) {
        emit(revision, 'table_save_unconfirmed', 'failed', input.committedAtMs);
        continue;
      }
      revision.committed = true;
      revision.marker = value;
      revision.intent.guard?.dispose();
    }
  } catch (_error) {
    void _error;
  }
}

export function requireNotebookCommitFingerprint(fingerprint: string | undefined): string {
  if (!fingerprint) throw new Error('The notebook authority save was not confirmed.');
  return fingerprint;
}

export function beginTableNotebookReopen(): OriginGuard | null {
  try {
    return captureOriginGuard();
  } catch {
    return null;
  }
}

export async function confirmTableNotebookReopen(
  guard: OriginGuard | null,
  input: {
    pageId: string;
    workspaceRoot: string | null;
    path: string;
    authorityFingerprint?: string;
    created: boolean;
    cancelled: () => boolean;
  }
): Promise<void> {
  const reopenedAtMs = Date.now();
  try {
    if (
      !guard?.origin ||
      !guard.allowed() ||
      !input.workspaceRoot ||
      !input.created ||
      input.cancelled() ||
      !input.authorityFingerprint
    )
      return;
    const prefix = receiptPagePrefix({ workspaceRoot: input.workspaceRoot, pageId: input.pageId });
    const db = platform().db;
    const rows = await db.select<{ key: string; value: string }[]>(
      'SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? LIMIT ?',
      [prefix.length, prefix, MAX_RECEIPTS]
    );
    for (const row of rows) {
      let receipt: TableReceipt;
      try {
        receipt = JSON.parse(row.value) as TableReceipt;
      } catch {
        continue;
      }
      if (
        receipt.version !== 1 ||
        receipt.phase !== 'committed' ||
        !isTableOperationObservation(receipt.observation) ||
        !UUID.test(receipt.operationId) ||
        !UUID.test(receipt.revisionId) ||
        !receipt.origin ||
        !sameContext(receipt.origin, guard.origin) ||
        ![receipt.origin.consentScope, receipt.origin.contextId, receipt.origin.processId].every(
          (id) => UUID.test(id)
        ) ||
        !Number.isSafeInteger(receipt.acceptedAtMs) ||
        !Number.isSafeInteger(receipt.committedAtMs) ||
        receipt.acceptedAtMs < 0 ||
        typeof receipt.authorityFingerprint !== 'string' ||
        !receipt.authorityFingerprint ||
        receipt.acceptedAtMs > receipt.committedAtMs! ||
        receipt.committedAtMs! > reopenedAtMs ||
        reopenedAtMs - receipt.acceptedAtMs > RECEIPT_TTL_MS ||
        receipt.path !== input.path
      )
        continue;
      if (!guard.allowed() || input.cancelled()) return;
      const source = currentSources.get(sourceKey(input.workspaceRoot, input.pageId));
      if (
        source &&
        (source.epoch !== source.committedEpoch ||
          [...source.revisions.values()].some((r) => !r.committed))
      )
        continue;
      const match = receipt.authorityFingerprint === input.authorityFingerprint;
      const value = JSON.stringify({
        ...receipt,
        phase: 'reopened',
        readbackMatch: match,
        reopenedAtMs,
        reopenedEventId: crypto.randomUUID(),
      });
      await platform().analytics.writeTableNotebookReceipt?.({
        kind: 'write',
        key: row.key,
        expectedValue: row.value,
        value,
        updatedAtMs: reopenedAtMs,
        origin: guard.origin,
      });
    }
  } catch (_error) {
    void _error;
  } finally {
    guard?.dispose();
  }
}

export function resetTableNotebookObservationsForTests(): void {
  for (const source of currentSources.values()) {
    source.current = false;
    for (const revision of source.revisions.values()) revision.intent.guard?.dispose();
  }
  currentSources.clear();
  sources = new WeakMap();
  snapshots = new WeakMap();
}

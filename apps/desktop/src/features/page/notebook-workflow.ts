import type { JSONContent } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import {
  captureAnalyticsOptionalOrigin,
  getAnalyticsCaptureGeneration,
  getAnalyticsIdentifiedAccountId,
  isAnalyticsCaptureReady,
  trackRendererEvent,
} from '../../lib/analytics';
import { getTelemetryCorrelationContext } from '../../lib/telemetry-correlation';
import {
  beginWorkflowAction,
  observeWorkflowAction,
  type WorkflowOperation,
} from '../../lib/workflow-telemetry';
import { isExternalConflictError } from './notebook-external-conflict';
import type { NotebookDocumentSnapshot } from '../../shared/notebook-document';

function captureGuard() {
  const origin = captureAnalyticsOptionalOrigin();
  if (!origin || !isAnalyticsCaptureReady()) return null;
  const signature = JSON.stringify(origin);
  const generation = getAnalyticsCaptureGeneration();
  const account = getAnalyticsIdentifiedAccountId();
  const context = { ...getTelemetryCorrelationContext() };
  const sameAuthority = () =>
    isAnalyticsCaptureReady() &&
    generation === getAnalyticsCaptureGeneration() &&
    account === getAnalyticsIdentifiedAccountId() &&
    signature === JSON.stringify(captureAnalyticsOptionalOrigin());
  return {
    sameAuthority,
    allowed: () => {
      const current = getTelemetryCorrelationContext();
      return (
        sameAuthority() &&
        context.appSessionId === current.appSessionId &&
        context.episodeCorrelationId === current.episodeCorrelationId
      );
    },
  };
}
type Guard = NonNullable<ReturnType<typeof captureGuard>>;
interface Revision {
  pageId: string;
  root: string;
  key: string;
  id: string;
  version: number;
  state: 'editing' | 'saving' | 'failed' | 'committed' | 'retired';
  action: WorkflowOperation;
  guard: Guard;
}
interface Source {
  key: string;
  revision: Revision | null;
}
export interface NotebookSaveObservation {
  readonly revision: Revision;
  readonly version: number;
  fileWritten: boolean;
}
interface Commit {
  revision: Revision;
  path: string;
  fingerprint: string;
  number: number;
  atMs: number;
  reopened: boolean;
}
type Artifact =
  | { path: string; fileKind: string; authorityFingerprint?: string }
  | null
  | undefined;
let sources = new WeakMap<object, Source>();
let snapshots = new WeakMap<JSONContent, { revision: Revision; version: number }>();
const latest = new Map<string, Revision>();
const commits = new Map<string, Commit>();
let commitNumber = 0;
const sourceKey = (root: string, pageId: string) => JSON.stringify([root, pageId]);

function retain(revision: Revision) {
  latest.delete(revision.key);
  latest.set(revision.key, revision);
  while (latest.size > 256) {
    const key = latest.keys().next().value;
    if (key === undefined) break;
    latest.delete(key);
    commits.delete(key);
  }
}

function start(revision: Pick<Revision, 'id' | 'guard'>) {
  return beginWorkflowAction(
    { workflow: 'content', action: 'commit', artifactCorrelationId: revision.id },
    {
      track: (event, properties) =>
        revision.guard.allowed() ? trackRendererEvent(event, properties) : false,
    }
  );
}

export function captureNotebookDocumentUpdate(input: {
  owner: object;
  pageId: string;
  workspaceRoot: string | null;
  transaction: Pick<Transaction, 'docChanged' | 'getMeta'>;
  content: JSONContent;
}): void {
  try {
    if (
      !input.workspaceRoot ||
      !input.transaction.docChanged ||
      input.transaction.getMeta('preventUpdate') === true ||
      input.transaction.getMeta('addToHistory') === false
    )
      return;
    const key = sourceKey(input.workspaceRoot, input.pageId);
    let source = sources.get(input.owner);
    if (source && source.key !== key) retireNotebookDocumentSource(input.owner);
    if (!source || source.key !== key) {
      source = { key, revision: null };
      sources.set(input.owner, source);
    }
    let revision = source.revision;
    if (!revision || revision.state !== 'editing' || !revision.guard.allowed()) {
      const guard = captureGuard();
      if (!guard) return;
      const identity = { id: crypto.randomUUID(), guard };
      const action = start(identity);
      if (!action.startAccepted) return;
      revision = {
        ...identity,
        action,
        pageId: input.pageId,
        root: input.workspaceRoot,
        key,
        version: 0,
        state: 'editing',
      };
      source.revision = revision;
      retain(revision);
    }
    revision.version += 1;
    snapshots.set(input.content, { revision, version: revision.version });
  } catch {
    return;
  }
}

export function captureNotebookSave(
  pageId: string,
  content: JSONContent
): NotebookSaveObservation | null {
  try {
    const snapshot = snapshots.get(content);
    if (
      !snapshot ||
      snapshot.revision.pageId !== pageId ||
      snapshot.version !== snapshot.revision.version
    )
      return null;
    const revision = snapshot.revision;
    if (!revision.guard.allowed() || !['editing', 'failed'].includes(revision.state)) return null;
    if (revision.state === 'failed') {
      revision.action = start(revision);
      if (!revision.action.startAccepted) return null;
    }
    revision.state = 'saving';
    return { ...snapshot, fileWritten: false };
  } catch {
    return null;
  }
}

export function observeNotebookAuthorityWrite(
  save: NotebookSaveObservation | null,
  input: { workspaceRoot: string | null; artifact: Artifact }
): void {
  try {
    if (
      save &&
      input.workspaceRoot === save.revision.root &&
      input.artifact?.fileKind === 'waypoint-notebook' &&
      input.artifact.authorityFingerprint
    )
      save.fileWritten = true;
  } catch {
    return;
  }
}

export function observeNotebookSaveFailure(
  save: NotebookSaveObservation | null,
  error?: unknown
): void {
  try {
    if (!save || save.revision.state !== 'saving') return;
    const conflict = isExternalConflictError(error);
    save.revision.state = 'failed';
    if (!save.revision.guard.allowed()) return;
    save.revision.action.fail(save.fileWritten ? 'projection_failed' : 'write_failed', {
      outcomeKind: conflict
        ? 'notebook_save_conflict'
        : error === undefined
          ? 'notebook_save_unconfirmed'
          : 'notebook_save_failed',
      recordWriteStatus: save.fileWritten ? 'written' : 'unconfirmed',
      recordProjectionStatus: save.fileWritten ? 'failed' : 'not_attempted',
    });
  } catch {
    return;
  }
}

export function confirmNotebookCommit(
  save: NotebookSaveObservation | null,
  input: {
    workspaceRoot: string | null;
    artifact: Artifact;
    projectionSettled: boolean;
    expectedFingerprint?: string;
  }
): void {
  try {
    if (!save || save.revision.state !== 'saving') return;
    observeNotebookAuthorityWrite(save, input);
    const artifact = input.artifact;
    if (!save.fileWritten || !artifact?.authorityFingerprint || !input.projectionSettled) {
      observeNotebookSaveFailure(save);
      return;
    }
    const revision = save.revision;
    if (!revision.guard.allowed()) {
      revision.state = 'retired';
      return;
    }
    revision.state = 'committed';
    const unchanged = input.expectedFingerprint === artifact.authorityFingerprint;
    const accepted = revision.action.complete({
      status: unchanged ? 'no_match' : 'saved',
      outcomeKind: unchanged ? 'notebook_unchanged' : 'notebook_committed',
      recordWriteStatus: 'written',
      recordProjectionStatus: 'ready',
    });
    if (!accepted || unchanged) return;
    commits.set(revision.key, {
      revision,
      path: artifact.path,
      fingerprint: artifact.authorityFingerprint,
      number: ++commitNumber,
      atMs: Date.now(),
      reopened: false,
    });
    while (commits.size > 256) {
      const key = commits.keys().next().value;
      if (key === undefined) break;
      commits.delete(key);
    }
  } catch {
    return;
  }
}

export function confirmNativeNotebookSave(
  save: NotebookSaveObservation | null,
  captured: Pick<NotebookDocumentSnapshot, 'documentId' | 'revision'>,
  committed: Pick<
    NotebookDocumentSnapshot,
    'documentId' | 'persistedRevision' | 'workspaceRoot' | 'path' | 'canonicalFingerprint'
  >,
  expectedFingerprint?: string
): void {
  if (
    committed.documentId !== captured.documentId ||
    committed.persistedRevision !== captured.revision
  ) {
    observeNotebookSaveFailure(save);
    return;
  }
  confirmNotebookCommit(save, {
    workspaceRoot: committed.workspaceRoot,
    artifact: {
      path: committed.path,
      fileKind: 'waypoint-notebook',
      authorityFingerprint: committed.canonicalFingerprint,
    },
    projectionSettled: true,
    expectedFingerprint,
  });
}

export function retireNotebookDocumentSource(
  owner: object | null,
  reason: 'discarded' | 'superseded' = 'superseded'
): void {
  try {
    if (!owner) return;
    const source = sources.get(owner);
    const revision = source?.revision;
    if (revision && !['committed', 'retired'].includes(revision.state)) {
      revision.state = 'retired';
      if (latest.get(revision.key) === revision) latest.delete(revision.key);
      if (revision.guard.allowed())
        revision.action.cancel({
          status: 'cancelled',
          outcomeKind: reason === 'discarded' ? 'notebook_discarded' : 'notebook_superseded',
        });
    }
    sources.delete(owner);
  } catch {
    return;
  }
}

export function beginNotebookReopen() {
  try {
    const guard = captureGuard();
    return guard ? { guard, number: commitNumber, atMs: Date.now() } : null;
  } catch {
    return null;
  }
}

export function confirmNotebookReopen(
  reopen: ReturnType<typeof beginNotebookReopen>,
  input: {
    pageId: string;
    workspaceRoot: string | null;
    path: string;
    authorityFingerprint?: string;
    created: boolean;
    cancelled: () => boolean;
  }
): void {
  try {
    if (
      !reopen ||
      !input.workspaceRoot ||
      !input.created ||
      input.cancelled() ||
      !reopen.guard.allowed()
    )
      return;
    const key = sourceKey(input.workspaceRoot, input.pageId);
    const commit = commits.get(key);
    if (
      !commit ||
      commit.number > reopen.number ||
      commit.reopened ||
      commit.path !== input.path ||
      !input.authorityFingerprint ||
      !commit.revision.guard.sameAuthority() ||
      Date.now() - commit.atMs > 86_400_000
    )
      return;
    const pending = latest.get(key);
    if (pending && !['committed', 'retired'].includes(pending.state)) return;
    const match = commit.fingerprint === input.authorityFingerprint;
    const accepted = observeWorkflowAction(
      {
        workflow: 'content',
        action: 'open',
        initiator: 'system',
        phase: 'result',
        artifactCorrelationId: commit.revision.id,
        parentActionId: commit.revision.action.actionId,
        outcomeKind: match ? 'notebook_reopened' : 'notebook_reopen_mismatch',
        status: 'viewed',
        success: true,
        initiatedAtMs: reopen.atMs,
      },
      {
        track: (event, properties) =>
          reopen.guard.allowed() ? trackRendererEvent(event, properties) : false,
      }
    );
    if (accepted && match) commit.reopened = true;
  } catch {
    return;
  }
}

export function resetNotebookWorkflowForTests(): void {
  sources = new WeakMap();
  snapshots = new WeakMap();
  latest.clear();
  commits.clear();
  commitNumber = 0;
}

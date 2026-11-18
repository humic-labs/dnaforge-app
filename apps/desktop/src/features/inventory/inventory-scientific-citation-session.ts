import type {
  InventoryScientificCitationEntry,
  InventoryScientificCitationPredecessor,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyScientificCitationRequestSchema,
  inventoryApplyScientificCitationWithdrawalRequestSchema,
  inventoryScientificCitationPreviewSnapshotSchema,
  inventoryScientificCitationWithdrawalPreviewSnapshotSchema,
  inventoryScientificCitationsReadSchema,
  type InventoryScientificCitationPreviewSnapshot,
  type InventoryScientificCitationWithdrawalPreviewSnapshot,
} from '../../shared/inventory-scientific-citations';
import type { InventoryAttempt } from './inventory-pending-coordinator';
import {
  InventoryPendingCoordinator,
  executeInventoryAcceptedRequest,
  assertInventoryReceiptForAttempt,
} from './inventory-pending-coordinator';

export type CitationTarget = {
  project: string;
  inventoryId: string;
  workId: string;
  workIntentSha256: `sha256:${string}`;
};
export type CitationAction =
  | { kind: 'add' }
  | { kind: 'withdraw' | 'reattach'; entry: InventoryScientificCitationEntry };
export type CitationDraft = {
  identityId: string;
  contextKind: 'notebook-page' | 'protocol-run';
  entityId: string;
  sourceSha256: string;
  reason: string;
};
type Preview =
  | InventoryScientificCitationPreviewSnapshot
  | InventoryScientificCitationWithdrawalPreviewSnapshot;
type Phase =
  | { kind: 'editing' }
  | { kind: 'previewing' }
  | { kind: 'previewed'; preview: Preview }
  | { kind: 'sending' }
  | { kind: 'unknown'; attempt: InventoryAttempt; message: string }
  | { kind: 'saved-refresh-failed'; attempt: InventoryAttempt; message: string }
  | { kind: 'complete'; message: string }
  | { kind: 'failed'; message: string };
export class InventoryScientificCitationSession {
  private snapshot: { draft: CitationDraft; phase: Phase };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private readonly storageKey: string;
  constructor(
    private readonly client: InventoryClient,
    private readonly pending: InventoryPendingCoordinator,
    readonly target: CitationTarget,
    readonly action: CitationAction,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly operationId: () => string = () => crypto.randomUUID()
  ) {
    this.storageKey = `dnaforge.inventory.citation-draft.v1:${JSON.stringify([target.project, target.inventoryId, target.workId, action.kind, 'entry' in action ? action.entry.citation.id : null])}`;
    let draft: CitationDraft = {
      identityId: crypto.randomUUID(),
      contextKind: 'entry' in action ? action.entry.citation.context.kind : 'notebook-page',
      entityId: 'entry' in action ? action.entry.citation.context.entityId : '',
      sourceSha256: 'entry' in action ? action.entry.citation.context.source.sha256 : '',
      reason: '',
    };
    try {
      const raw = storage.getItem(this.storageKey);
      if (raw) {
        const retained = JSON.parse(raw);
        if (
          retained.version !== 1 ||
          Object.keys(draft).some((key) => typeof retained.draft?.[key] !== 'string') ||
          !['notebook-page', 'protocol-run'].includes(retained.draft.contextKind)
        )
          throw Error('The citation draft could not be read.');
        draft = retained.draft;
      }
      this.snapshot = { draft, phase: { kind: 'editing' } };
    } catch (cause) {
      this.snapshot = { draft, phase: { kind: 'failed', message: text(cause) } };
    }
  }
  getSnapshot = () => this.snapshot;
  activate() {
    this.disposed = false;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(phase: Phase, draft = this.snapshot.draft) {
    if (this.disposed) return;
    this.snapshot = { draft, phase };
    for (const listener of this.listeners) listener();
  }
  private busy() {
    return ['sending', 'unknown', 'saved-refresh-failed', 'complete'].includes(
      this.snapshot.phase.kind
    );
  }
  edit(draft: CitationDraft) {
    if (this.busy()) return;
    ++this.generation;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, draft }));
      this.publish({ kind: 'editing' }, { ...draft });
    } catch {
      this.publish({ kind: 'failed', message: 'The citation draft could not be retained safely.' });
    }
  }
  invalidatePreview() {
    if (this.busy()) return;
    ++this.generation;
    this.publish({ kind: 'editing' });
  }
  private predecessor(): InventoryScientificCitationPredecessor | null {
    if (this.action.kind !== 'reattach') return null;
    const { citation, withdrawal } = this.action.entry;
    if (!withdrawal) throw Error('Only a withdrawn citation can be added again.');
    return {
      citationId: citation.id,
      citationIntentSha256: citation.intentSha256,
      withdrawalId: withdrawal.id,
      withdrawalIntentSha256: withdrawal.intentSha256,
    };
  }
  private choices(draft: CitationDraft) {
    const base = {
      workId: this.target.workId,
      workIntentSha256: this.target.workIntentSha256,
      reason: draft.reason.trim(),
    };
    if (this.action.kind === 'withdraw')
      return {
        ...base,
        identity: { namespace: 'manual-citation-withdrawals', withdrawalId: draft.identityId },
        citationId: this.action.entry.citation.id,
        citationIntentSha256: this.action.entry.citation.intentSha256,
      };
    return {
      ...base,
      identity: { namespace: 'manual-citations', citationId: draft.identityId },
      context: {
        kind: draft.contextKind,
        entityId: draft.entityId,
        sourceSha256: draft.sourceSha256 as `sha256:${string}`,
      },
      reinstates: this.predecessor(),
    };
  }
  private async currentRead() {
    const read = inventoryScientificCitationsReadSchema.parse(
      await this.client.scientificCitations({ ...this.target, limit: 20 })
    );
    if (read.kind !== 'ready') throw Error(read.message);
    if (
      read.projectId !== this.target.project ||
      read.inventoryId !== this.target.inventoryId ||
      read.workId !== this.target.workId ||
      read.workIntentSha256 !== this.target.workIntentSha256
    )
      throw Error('Citations belong to another recorded work.');
    return read;
  }
  async preview() {
    if (this.busy()) return;
    const draft = { ...this.snapshot.draft },
      generation = ++this.generation;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({ version: 1, draft }));
      this.publish({ kind: 'previewing' });
      const read = await this.currentRead();
      if (this.disposed || generation !== this.generation) return;
      const common = {
        project: this.target.project,
        inventoryId: this.target.inventoryId,
        expectedRevision: read.revision,
      };
      const preview =
        this.action.kind === 'withdraw'
          ? inventoryScientificCitationWithdrawalPreviewSnapshotSchema.parse(
              await this.client.previewScientificCitationWithdrawal({
                ...common,
                choices: this.choices(draft) as Parameters<
                  InventoryClient['previewScientificCitationWithdrawal']
                >[0]['choices'],
              })
            )
          : inventoryScientificCitationPreviewSnapshotSchema.parse(
              await this.client.previewScientificCitation({
                ...common,
                choices: this.choices(draft) as Parameters<
                  InventoryClient['previewScientificCitation']
                >[0]['choices'],
              })
            );
      if (this.disposed || generation !== this.generation) return;
      if (
        preview.projectId !== this.target.project ||
        preview.inventoryId !== this.target.inventoryId ||
        preview.workId !== this.target.workId ||
        preview.target.revision !== read.revision
      )
        throw Error('The citation preview belongs to another work or inventory snapshot.');
      this.publish({ kind: 'previewed', preview });
    } catch (cause) {
      if (!this.disposed && generation === this.generation)
        this.publish({ kind: 'failed', message: text(cause) });
    }
  }
  async submit() {
    const state = this.snapshot;
    if (state.phase.kind !== 'previewed' || state.phase.preview.kind !== 'ready') return;
    try {
      const common = {
        project: this.target.project,
        inventoryId: this.target.inventoryId,
        expectedRevision: state.phase.preview.target.revision,
        expectedPlanDigest: state.phase.preview.planDigest,
        operationId: this.operationId(),
      };
      const request =
        this.action.kind === 'withdraw'
          ? inventoryApplyScientificCitationWithdrawalRequestSchema.parse({
              ...common,
              kind: 'withdraw-scientific-citation',
              choices: this.choices(state.draft),
            })
          : inventoryApplyScientificCitationRequestSchema.parse({
              ...common,
              kind: 'record-scientific-citation',
              choices: this.choices(state.draft),
            });
      const attempt = {
        request,
        summary:
          this.action.kind === 'withdraw'
            ? 'Withdraw scientific citation'
            : 'Add saved scientific citation',
      };
      this.pending.retain(attempt);
      await this.send(attempt);
    } catch (cause) {
      this.publish({ kind: 'failed', message: text(cause) });
    }
  }
  resume(attempt: InventoryAttempt) {
    if (
      !('kind' in attempt.request) ||
      !['record-scientific-citation', 'withdraw-scientific-citation'].includes(
        attempt.request.kind
      ) ||
      attempt.request.project !== this.target.project ||
      attempt.request.inventoryId !== this.target.inventoryId ||
      !('choices' in attempt.request) ||
      !('workId' in attempt.request.choices) ||
      attempt.request.choices.workId !== this.target.workId ||
      !('workIntentSha256' in attempt.request.choices) ||
      attempt.request.choices.workIntentSha256 !== this.target.workIntentSha256
    )
      throw Error('This saved change belongs to another inventory.');
    this.publish(
      attempt.receipt
        ? {
            kind: 'saved-refresh-failed',
            attempt,
            message: 'This change was saved. Reload its citations.',
          }
        : { kind: 'unknown', attempt, message: 'A saved change needs confirmation.' }
    );
  }
  private async committed(
    attempt: InventoryAttempt & { receipt: NonNullable<InventoryAttempt['receipt']> }
  ) {
    try {
      this.pending.confirm(this.pending.retain(attempt), attempt.receipt);
      await this.currentRead();
      this.storage.setItem(this.storageKey, '');
      this.pending.clear(this.pending.retain(attempt));
      this.publish({
        kind: 'complete',
        message: this.action.kind === 'withdraw' ? 'Citation withdrawn.' : 'Saved citation added.',
      });
    } catch (cause) {
      this.publish({
        kind: 'saved-refresh-failed',
        attempt,
        message: `The change was saved. Reload its citations. ${text(cause)}`,
      });
    }
  }
  private async send(attempt: InventoryAttempt) {
    let release: (() => void) | undefined;
    this.publish({ kind: 'sending' });
    try {
      const existing = this.pending.peek(attempt.request);
      if (existing?.receipt) return this.committed({ ...existing, receipt: existing.receipt });
      release = this.pending.acquire(this.pending.retain(attempt), 'send');
      const result = await executeInventoryAcceptedRequest(this.client, attempt.request);
      if (result.status === 'committed') {
        assertInventoryReceiptForAttempt(attempt, result);
        await this.committed({ ...attempt, receipt: result });
      } else {
        if (
          result.status !== 'rejected' ||
          result.inventoryId !== attempt.request.inventoryId ||
          result.operationId !== attempt.request.operationId ||
          typeof result.code !== 'string' ||
          typeof result.message !== 'string'
        )
          throw Error('The citation result could not be confirmed.');
        this.pending.clear(this.pending.retain(attempt));
        try {
          await this.currentRead();
        } catch (cause) {
          this.publish({ kind: 'failed', message: `${result.message} ${text(cause)}` });
          return;
        }
        this.publish({ kind: 'failed', message: result.message });
      }
    } catch (cause) {
      this.publish({
        kind: 'unknown',
        attempt,
        message: `The result needs confirmation. ${text(cause)}`,
      });
    } finally {
      release?.();
    }
  }
  async checkStatus() {
    const phase = this.snapshot.phase;
    if (phase.kind !== 'unknown') return;
    let release: (() => void) | undefined;
    try {
      const existing = this.pending.peek(phase.attempt.request);
      if (existing?.receipt) return this.committed({ ...existing, receipt: existing.receipt });
      release = this.pending.acquire(this.pending.retain(phase.attempt), 'inspect');
      const receipt = await this.client.operation({
        project: phase.attempt.request.project,
        inventoryId: phase.attempt.request.inventoryId,
        operationId: phase.attempt.request.operationId,
      });
      if (receipt) {
        assertInventoryReceiptForAttempt(phase.attempt, receipt);
        await this.committed({ ...phase.attempt, receipt });
      } else
        this.publish({
          ...phase,
          message: 'No completed change was found. You can retry this same change.',
        });
    } catch (cause) {
      this.publish({ ...phase, message: text(cause) });
    } finally {
      release?.();
    }
  }
  async retry() {
    const phase = this.snapshot.phase;
    if (phase.kind === 'unknown') await this.send(phase.attempt);
  }
  async reloadSaved() {
    const phase = this.snapshot.phase;
    if (phase.kind === 'saved-refresh-failed' && phase.attempt.receipt)
      await this.committed({ ...phase.attempt, receipt: phase.attempt.receipt });
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
  }
}
function text(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The citation could not be completed.';
}

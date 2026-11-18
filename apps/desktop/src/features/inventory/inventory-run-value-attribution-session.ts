import {
  inventoryTableCanonicalJson,
  inventoryRunValueAttributionId,
  type InventoryRunValueAttributionEntry,
  type InventoryRunValueAttributionChoices,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyRunValueAttributionRequestSchema,
  inventoryApplyRunValueAttributionWithdrawalRequestSchema,
  inventoryRunValueAttributionPreviewSnapshotSchema,
  inventoryRunValueAttributionWithdrawalPreviewSnapshotSchema,
  inventoryRunValueAttributionsReadSchema,
  inventoryRunValueAttributionReadSchema,
  type InventoryRunValueAttributionPreviewSnapshot,
  type InventoryRunValueAttributionWithdrawalPreviewSnapshot,
  type InventoryApplyRunValueAttributionRequest,
  type InventoryApplyRunValueAttributionWithdrawalRequest,
} from '../../shared/inventory-run-value-attributions';
import {
  InventoryPendingCoordinator,
  assertInventoryReceiptForAttempt,
  executeInventoryAcceptedRequest,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
export type RunValueAttributionAction =
  | { kind: 'add'; runId: string }
  | { kind: 'withdraw' | 'correct'; entry: InventoryRunValueAttributionEntry };
export type RunValueAttributionDraft = {
  identityId: string;
  runValue: InventoryRunValueAttributionChoices['runValue'] | null;
  physical: InventoryRunValueAttributionChoices['physical'] | null;
  reason: string;
};
type Request =
  | InventoryApplyRunValueAttributionRequest
  | InventoryApplyRunValueAttributionWithdrawalRequest;
type Preview =
  | InventoryRunValueAttributionPreviewSnapshot
  | InventoryRunValueAttributionWithdrawalPreviewSnapshot;
type Phase =
  | { kind: 'editing' | 'previewing' | 'sending' }
  | { kind: 'previewed'; preview: Preview; request?: Request }
  | { kind: 'unknown' | 'saved-refresh-failed'; attempt: InventoryAttempt; message: string }
  | { kind: 'complete'; entry: InventoryRunValueAttributionEntry }
  | { kind: 'failed'; message: string };
export class InventoryRunValueAttributionSession {
  private snapshot: { draft: RunValueAttributionDraft; phase: Phase };
  private generation = 0;
  private active = true;
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;
  private prepared: Request | null = null;
  constructor(
    readonly scope: PlatePlanScope,
    readonly action: RunValueAttributionAction,
    private readonly client: InventoryClient,
    private readonly pending: InventoryPendingCoordinator,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly operationId: () => string = () => crypto.randomUUID()
  ) {
    const original = 'entry' in action ? action.entry.attribution : null;
    this.storageKey = `dnaforge.inventory.run-value-attribution-draft.v1:${JSON.stringify([scope.project, scope.inventoryId, action.kind, original?.id ?? (action.kind === 'add' ? action.runId : null)])}`;
    let draft: RunValueAttributionDraft = {
      identityId: crypto.randomUUID(),
      runValue: original?.runValue ?? null,
      physical: original?.physical ?? null,
      reason: '',
    };
    try {
      const raw = storage.getItem(this.storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          typeof saved.draft?.identityId !== 'string' ||
          typeof saved.draft?.reason !== 'string'
        )
          throw Error('The saved association draft is unavailable.');
        draft = saved.draft;
        if (saved.prepared) {
          this.prepared =
            'kind' in saved.prepared && saved.prepared.kind === 'withdraw-run-value-attribution'
              ? inventoryApplyRunValueAttributionWithdrawalRequestSchema.parse(saved.prepared)
              : inventoryApplyRunValueAttributionRequestSchema.parse(saved.prepared);
          this.assertRequest(this.prepared);
        }
      }
      this.snapshot = { draft, phase: { kind: 'editing' } };
    } catch (cause) {
      this.snapshot = { draft, phase: { kind: 'failed', message: message(cause) } };
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  activate() {
    this.active = true;
  }
  private publish(phase: Phase, draft = this.snapshot.draft) {
    if (!this.active) return;
    this.snapshot = { draft, phase };
    for (const listener of this.listeners) listener();
  }
  private busy() {
    return ['sending', 'unknown', 'saved-refresh-failed', 'complete'].includes(
      this.snapshot.phase.kind
    );
  }
  private retain(draft = this.snapshot.draft) {
    this.storage.setItem(
      this.storageKey,
      JSON.stringify({ version: 1, draft, prepared: this.prepared })
    );
  }
  edit(draft: RunValueAttributionDraft) {
    if (this.busy()) return;
    ++this.generation;
    try {
      this.retain(draft);
      this.publish({ kind: 'editing' }, structuredClone(draft));
    } catch {
      this.publish({
        kind: 'failed',
        message: 'The association draft could not be retained safely.',
      });
    }
  }
  invalidate() {
    if (this.busy()) return;
    ++this.generation;
    this.publish({ kind: 'editing' });
  }
  private choices() {
    const draft = this.snapshot.draft;
    if (!draft.reason.trim()) throw Error('Enter a reason for this association or correction.');
    if (this.action.kind === 'withdraw') {
      const original = this.action.entry.attribution;
      return {
        identity: { namespace: 'manual-run-value-withdrawals', withdrawalId: draft.identityId },
        attributionId: original.id,
        attributionIntentSha256: original.intentSha256,
        reason: draft.reason.trim(),
      };
    }
    if (!draft.runValue || !draft.physical)
      throw Error('Choose an exact saved value and recorded physical subject.');
    if (this.action.kind === 'add' && draft.runValue.entityId !== this.action.runId)
      throw Error('The saved value belongs to another Run.');
    let predecessor: InventoryRunValueAttributionChoices['predecessor'] = null;
    if (this.action.kind === 'correct') {
      const original = this.action.entry.attribution,
        withdrawal = this.action.entry.withdrawal;
      if (!withdrawal) throw Error('Only a withdrawn association can have an explicit successor.');
      if (
        draft.runValue.entityId !== original.runValue.entityId ||
        draft.runValue.collection !== original.runValue.collection ||
        draft.runValue.key !== original.runValue.key
      )
        throw Error('A correction must retain the same Run and saved field.');
      predecessor = {
        attributionId: original.id,
        attributionIntentSha256: original.intentSha256,
        withdrawalId: withdrawal.id,
        withdrawalIntentSha256: withdrawal.intentSha256,
      };
    }
    return {
      identity: { namespace: 'manual-run-value-associations', attributionId: draft.identityId },
      runValue: draft.runValue,
      physical: draft.physical,
      predecessor,
      reason: draft.reason.trim(),
    };
  }
  async preview() {
    if (this.busy()) return;
    const generation = ++this.generation;
    try {
      this.retain();
      const choices = this.choices();
      this.publish({ kind: 'previewing' });
      const list = inventoryRunValueAttributionsReadSchema.parse(
        await this.client.runValueAttributions({ ...this.scope, limit: 1 })
      );
      if (!this.active || generation !== this.generation) return;
      if (list.kind === 'unavailable') throw Error(list.message);
      if (list.projectId !== this.scope.project || list.inventoryId !== this.scope.inventoryId)
        throw Error('The association inventory changed.');
      const expectedRevision = list.kind === 'ready' ? list.revision : 0,
        common = { ...this.scope, expectedRevision };
      const preview =
        this.action.kind === 'withdraw'
          ? inventoryRunValueAttributionWithdrawalPreviewSnapshotSchema.parse(
              await this.client.previewRunValueAttributionWithdrawal({
                ...common,
                choices: choices as InventoryApplyRunValueAttributionWithdrawalRequest['choices'],
              })
            )
          : inventoryRunValueAttributionPreviewSnapshotSchema.parse(
              await this.client.previewRunValueAttribution({
                ...common,
                choices: choices as InventoryApplyRunValueAttributionRequest['choices'],
              })
            );
      if (!this.active || generation !== this.generation) return;
      if (preview.kind === 'unavailable') throw Error(preview.message);
      if (
        preview.projectId !== this.scope.project ||
        preview.inventoryId !== this.scope.inventoryId ||
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId ||
        (preview.kind === 'ready' && preview.target.revision !== expectedRevision)
      )
        throw Error('The association preview belongs to another inventory.');
      let request: Request | undefined;
      if (preview.kind === 'ready') {
        const operationId =
          this.prepared &&
          this.prepared.expectedRevision === expectedRevision &&
          this.prepared.expectedPlanDigest === preview.planDigest &&
          inventoryTableCanonicalJson(this.prepared.choices) ===
            inventoryTableCanonicalJson(choices)
            ? this.prepared.operationId
            : this.operationId();
        request =
          this.action.kind === 'withdraw'
            ? inventoryApplyRunValueAttributionWithdrawalRequestSchema.parse({
                ...common,
                kind: 'withdraw-run-value-attribution',
                operationId,
                expectedPlanDigest: preview.planDigest,
                choices,
              })
            : inventoryApplyRunValueAttributionRequestSchema.parse({
                ...common,
                kind: 'record-run-value-attribution',
                operationId,
                expectedPlanDigest: preview.planDigest,
                choices,
              });
      }
      this.prepared = request ?? null;
      this.retain();
      this.publish({ kind: 'previewed', preview, ...(request ? { request } : {}) });
    } catch (cause) {
      if (this.active && generation === this.generation)
        this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  private assertRequest(request: Request) {
    if (request.project !== this.scope.project || request.inventoryId !== this.scope.inventoryId)
      throw Error('The original association operation belongs to another inventory.');
    if (this.action.kind === 'withdraw') {
      if (
        request.kind !== 'withdraw-run-value-attribution' ||
        request.choices.attributionId !== this.action.entry.attribution.id ||
        request.choices.attributionIntentSha256 !== this.action.entry.attribution.intentSha256
      )
        throw Error('The original withdrawal belongs to another association.');
    } else {
      if (request.kind !== 'record-run-value-attribution')
        throw Error('The original operation is not an association.');
      if (this.action.kind === 'add' && request.choices.runValue.entityId !== this.action.runId)
        throw Error('The original association belongs to another Run.');
      if (this.action.kind === 'correct') {
        const original = this.action.entry.attribution,
          withdrawal = this.action.entry.withdrawal,
          predecessor = request.choices.predecessor;
        if (
          !withdrawal ||
          !predecessor ||
          predecessor.attributionId !== original.id ||
          predecessor.attributionIntentSha256 !== original.intentSha256 ||
          predecessor.withdrawalId !== withdrawal.id ||
          predecessor.withdrawalIntentSha256 !== withdrawal.intentSha256 ||
          request.choices.runValue.entityId !== original.runValue.entityId ||
          request.choices.runValue.collection !== original.runValue.collection ||
          request.choices.runValue.key !== original.runValue.key
        )
          throw Error('The original correction belongs to another predecessor or saved field.');
      }
    }
  }
  resume(attempt: InventoryAttempt) {
    if (
      !('kind' in attempt.request) ||
      !['record-run-value-attribution', 'withdraw-run-value-attribution'].includes(
        attempt.request.kind
      )
    )
      throw Error('This saved operation is not a value association.');
    this.assertRequest(attempt.request as Request);
    this.publish({
      kind: attempt.receipt ? 'saved-refresh-failed' : 'unknown',
      attempt,
      message: 'Confirm the exact original association change before making another.',
    });
  }
  async submit() {
    const phase = this.snapshot.phase;
    if (phase.kind !== 'previewed' || phase.preview.kind !== 'ready' || !phase.request) return;
    try {
      const attempt = {
        request: phase.request,
        summary:
          this.action.kind === 'withdraw'
            ? 'Withdraw saved value association'
            : 'Associate saved Run value with recorded subject',
      };
      this.pending.retain(attempt);
      await this.send(attempt);
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  private async committed(
    attempt: InventoryAttempt & { receipt: NonNullable<InventoryAttempt['receipt']> }
  ) {
    try {
      if (
        !('kind' in attempt.request) ||
        !['record-run-value-attribution', 'withdraw-run-value-attribution'].includes(
          attempt.request.kind
        )
      )
        throw Error('The original operation is not a value association.');
      const request = attempt.request as Request;
      this.assertRequest(request);
      this.pending.confirm(this.pending.retain(attempt), attempt.receipt);
      const attributionId =
        request.kind === 'record-run-value-attribution'
          ? inventoryRunValueAttributionId(request.choices.identity)
          : request.choices.attributionId;
      let intentSha256: `sha256:${string}`;
      if (request.kind === 'record-run-value-attribution') {
        const { inventoryRunValueAttributionIntentSha256 } =
          await import('@waypoint/domain-services');
        intentSha256 = inventoryRunValueAttributionIntentSha256(request.choices);
      } else intentSha256 = request.choices.attributionIntentSha256;
      const detail = inventoryRunValueAttributionReadSchema.parse(
        await this.client.runValueAttribution({ ...this.scope, attributionId, intentSha256 })
      );
      if (
        detail.kind !== 'available' ||
        detail.projectId !== this.scope.project ||
        detail.inventoryId !== this.scope.inventoryId ||
        detail.attribution.id !== attributionId ||
        detail.attribution.intentSha256 !== intentSha256
      )
        throw Error('The saved association could not be reloaded.');
      this.pending.clear(this.pending.retain(attempt));
      this.storage.setItem(this.storageKey, '');
      this.publish({
        kind: 'complete',
        entry: { attribution: detail.attribution, withdrawal: detail.withdrawal },
      });
    } catch (cause) {
      this.publish({
        kind: 'saved-refresh-failed',
        attempt,
        message: `The change was saved. Reload that original result. ${message(cause)}`,
      });
    }
  }
  private async send(attempt: InventoryAttempt) {
    this.publish({ kind: 'sending' });
    let release: (() => void) | undefined;
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
          throw Error('The association acknowledgement could not be confirmed.');
        this.pending.clear(this.pending.retain(attempt));
        this.publish({ kind: 'failed', message: result.message });
      }
    } catch (cause) {
      this.publish({
        kind: 'unknown',
        attempt,
        message: `Confirm the original result. ${message(cause)}`,
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
        ...this.scope,
        operationId: phase.attempt.request.operationId,
      });
      if (receipt) {
        assertInventoryReceiptForAttempt(phase.attempt, receipt);
        await this.committed({ ...phase.attempt, receipt });
      } else
        this.publish({
          ...phase,
          message: 'No completed change was found. Retry only this same original request.',
        });
    } catch (cause) {
      this.publish({ ...phase, message: message(cause) });
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
  detach() {
    this.active = false;
    ++this.generation;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The saved value association is unavailable.';
}

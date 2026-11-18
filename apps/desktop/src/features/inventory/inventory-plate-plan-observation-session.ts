import {
  inventoryTableCanonicalJson,
  inventoryPlatePlanObservationId,
  inventoryPlatePlanObservationIntentSha256,
  type InventoryPlatePlanVersion,
  type InventoryLocalPrincipal,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyPlatePlanObservationRequestSchema,
  inventoryPlatePlanObservationPreviewSnapshotSchema,
  inventoryPlatePlanObservationReadSchema,
  type InventoryApplyPlatePlanObservationRequest,
  type InventoryPlatePlanObservationPreviewSnapshot,
} from '../../shared/inventory-plate-plan-observations';
import { inventoryPlatePlanVersionsReadSchema } from '../../shared/inventory-plate-plans';
import {
  InventoryPendingCoordinator,
  assertInventoryReceiptForAttempt,
  executeInventoryAcceptedRequest,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
import type { PlatePlanScope } from './inventory-plate-plan-draft-session';
export type PlatePlanObservationDraft = {
  observationId: string;
  destinationPlateId: string;
  sources: Record<string, string>;
  contextKind: 'notebook-page' | 'protocol-run';
  entityId: string;
  sourceSha256: string;
  reason: string;
  declaration: '' | 'whole' | 'uncertain';
};
type Phase =
  | { kind: 'editing' | 'previewing' | 'sending' }
  | {
      kind: 'previewed';
      preview: InventoryPlatePlanObservationPreviewSnapshot;
      request?: InventoryApplyPlatePlanObservationRequest;
    }
  | { kind: 'unknown' | 'saved-refresh-failed'; attempt: InventoryAttempt; message: string }
  | { kind: 'complete'; observationId: string; intentSha256: `sha256:${string}` }
  | { kind: 'failed'; message: string };
export class InventoryPlatePlanObservationSession {
  private snapshot: { draft: PlatePlanObservationDraft; phase: Phase };
  private generation = 0;
  private active = true;
  private boundary: ReturnType<typeof setTimeout> | null = null;
  private principalKey: string | null = null;
  private readonly listeners = new Set<() => void>();
  private prepared: InventoryApplyPlatePlanObservationRequest | null = null;
  private readonly storageKey: string;
  constructor(
    readonly scope: PlatePlanScope,
    readonly version: InventoryPlatePlanVersion,
    private readonly client: InventoryClient,
    private readonly pending: InventoryPendingCoordinator,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    initial?: { destinationPlateId: string; sources: Record<string, string> },
    private readonly operationId: () => string = () => crypto.randomUUID()
  ) {
    this.storageKey = `dnaforge.inventory.plate-plan-observation-draft.v1:${JSON.stringify([scope.project, scope.inventoryId, version.id, version.definitionSha256])}`;
    let draft: PlatePlanObservationDraft = {
      observationId: crypto.randomUUID(),
      destinationPlateId: initial?.destinationPlateId ?? '',
      sources: { ...initial?.sources },
      contextKind: 'protocol-run',
      entityId: '',
      sourceSha256: '',
      reason: '',
      declaration: '',
    };
    try {
      const raw = storage.getItem(this.storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          !saved.draft ||
          !['notebook-page', 'protocol-run'].includes(saved.draft.contextKind) ||
          !['', 'whole', 'uncertain'].includes(saved.draft.declaration) ||
          ['observationId', 'destinationPlateId', 'entityId', 'sourceSha256', 'reason'].some(
            (key) => typeof saved.draft[key] !== 'string'
          ) ||
          !saved.draft.sources ||
          Object.values(saved.draft.sources).some((value) => typeof value !== 'string')
        )
          throw Error('The saved manual report draft could not be read.');
        draft = saved.draft;
        if (saved.prepared) {
          const request = inventoryApplyPlatePlanObservationRequestSchema.parse(saved.prepared);
          this.assertRequest(request);
          this.prepared = request;
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
  private retainDraft(draft = this.snapshot.draft) {
    this.storage.setItem(
      this.storageKey,
      JSON.stringify({ version: 1, draft, prepared: this.prepared })
    );
  }
  edit(draft: PlatePlanObservationDraft) {
    if (this.busy()) return;
    this.invalidate();
    try {
      this.retainDraft(draft);
      this.publish({ kind: 'editing' }, structuredClone(draft));
    } catch {
      this.publish({
        kind: 'failed',
        message: 'This manual report draft could not be retained safely.',
      });
    }
  }
  invalidate() {
    ++this.generation;
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    if (!this.busy()) this.publish({ kind: 'editing' });
  }
  setPrincipal(principal: InventoryLocalPrincipal | undefined) {
    const key = principal ? inventoryTableCanonicalJson(principal) : null;
    if (this.principalKey !== null && key !== this.principalKey) this.invalidate();
    this.principalKey = key;
  }
  private choices() {
    const draft = this.snapshot.draft;
    if (draft.declaration !== 'whole')
      throw Error('Confirm that all listed manual transfers were completed exactly as shown.');
    if (
      !draft.observationId.trim() ||
      !draft.reason.trim() ||
      !draft.entityId ||
      !/^sha256:[a-f0-9]{64}$/u.test(draft.sourceSha256)
    )
      throw Error(
        'Choose a saved scientific context and enter the reason for this completed manual report.'
      );
    return {
      identity: { namespace: 'manual-plate-plan-reports', observationId: draft.observationId },
      context: {
        kind: draft.contextKind,
        entityId: draft.entityId,
        sourceSha256: draft.sourceSha256 as `sha256:${string}`,
      },
      binding: {
        versionId: this.version.id,
        definitionSha256: this.version.definitionSha256,
        destinationPlateId: draft.destinationPlateId,
        sources: this.version.definition.sourceSlots.map((slot) => ({
          sourceSlotKey: slot.key,
          stockId: draft.sources[slot.key] ?? '',
        })),
      },
      reason: draft.reason.trim(),
    };
  }
  async preview() {
    if (this.busy()) return;
    this.invalidate();
    const generation = this.generation,
      started = performance.now();
    try {
      this.retainDraft();
      const choices = this.choices();
      this.publish({ kind: 'previewing' });
      const list = inventoryPlatePlanVersionsReadSchema.parse(
        await this.client.platePlanVersions({ ...this.scope, limit: 1 })
      );
      if (!this.current(generation)) return;
      if (
        list.kind !== 'ready' ||
        list.projectId !== this.scope.project ||
        list.inventoryId !== this.scope.inventoryId ||
        list.identity !== null
      )
        throw Error(
          list.kind === 'unavailable'
            ? list.message
            : 'The inventory containing this plan is unavailable.'
        );
      const preview = inventoryPlatePlanObservationPreviewSnapshotSchema.parse(
        await this.client.previewPlatePlanObservation({
          ...this.scope,
          expectedRevision: list.revision,
          choices,
        })
      );
      if (!this.current(generation)) return;
      if (preview.kind === 'unavailable') throw Error(preview.message);
      if (
        preview.projectId !== this.scope.project ||
        preview.inventoryId !== this.scope.inventoryId ||
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId ||
        (preview.kind === 'ready' && preview.target.revision !== list.revision) ||
        (this.principalKey !== null &&
          inventoryTableCanonicalJson(preview.principal) !== this.principalKey)
      )
        throw Error('The report preview belongs to another inventory or principal.');
      if (
        preview.kind !== 'blocked' &&
        (preview.observation.id !== inventoryPlatePlanObservationId(choices.identity) ||
          preview.observation.intentSha256 !==
            inventoryPlatePlanObservationIntentSha256(choices, this.version.definition) ||
          inventoryTableCanonicalJson(preview.observation.binding) !==
            inventoryTableCanonicalJson(choices.binding) ||
          preview.observation.context.kind !== choices.context.kind ||
          preview.observation.context.entityId !== choices.context.entityId ||
          preview.observation.context.source.sha256 !== choices.context.sourceSha256)
      )
        throw Error('The preview does not match this exact manual occurrence and context.');
      const delay =
        preview.nextBoundaryAt === null
          ? null
          : preview.nextBoundaryAt - preview.asOf - (performance.now() - started);
      if (delay !== null && delay <= 0)
        throw Error(
          'The report preview needs rechecking because an inventory time boundary passed.'
        );
      const request =
        preview.kind === 'ready'
          ? inventoryApplyPlatePlanObservationRequestSchema.parse({
              ...this.scope,
              kind: 'record-plate-plan-observation',
              expectedRevision: list.revision,
              expectedPlanDigest: preview.planDigest,
              operationId:
                this.prepared &&
                this.prepared.expectedRevision === list.revision &&
                this.prepared.expectedPlanDigest === preview.planDigest &&
                inventoryTableCanonicalJson(this.prepared.choices) ===
                  inventoryTableCanonicalJson(choices)
                  ? this.prepared.operationId
                  : this.operationId(),
              choices,
            })
          : undefined;
      this.prepared = request ?? null;
      this.retainDraft();
      this.publish({ kind: 'previewed', preview, ...(request ? { request } : {}) });
      if (delay !== null && delay > 0)
        this.boundary = setTimeout(
          () => {
            if (this.current(generation)) this.invalidate();
          },
          Math.min(delay, 2147483647)
        );
    } catch (cause) {
      if (this.current(generation)) this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  private current(generation: number) {
    return this.active && generation === this.generation;
  }
  private assertRequest(request: InventoryApplyPlatePlanObservationRequest) {
    if (
      request.project !== this.scope.project ||
      request.inventoryId !== this.scope.inventoryId ||
      request.choices.binding.versionId !== this.version.id ||
      request.choices.binding.definitionSha256 !== this.version.definitionSha256
    )
      throw Error('The saved manual report belongs to another inventory or plan version.');
  }
  resume(attempt: InventoryAttempt) {
    if (!('kind' in attempt.request) || attempt.request.kind !== 'record-plate-plan-observation')
      throw Error('This saved change is not a manual plan report.');
    this.assertRequest(attempt.request);
    const choices = attempt.request.choices;
    this.publish(
      {
        kind: attempt.receipt ? 'saved-refresh-failed' : 'unknown',
        attempt,
        message: 'Confirm the original manual report before recording another occurrence.',
      },
      {
        observationId: choices.identity.observationId,
        destinationPlateId: choices.binding.destinationPlateId,
        sources: Object.fromEntries(
          choices.binding.sources.map((row) => [row.sourceSlotKey, row.stockId])
        ),
        contextKind: choices.context.kind,
        entityId: choices.context.entityId,
        sourceSha256: choices.context.sourceSha256,
        reason: choices.reason,
        declaration: 'whole',
      }
    );
  }
  async previewSameOccurrence() {
    if (this.snapshot.phase.kind !== 'complete') return;
    this.publish({ kind: 'editing' });
    await this.preview();
  }
  newOccurrence() {
    const phase = this.snapshot.phase;
    if (this.busy() && phase.kind !== 'complete') return;
    this.invalidate();
    const draft = {
      ...this.snapshot.draft,
      observationId: crypto.randomUUID(),
      reason: '',
      declaration: '' as const,
    };
    try {
      this.prepared = null;
      this.retainDraft(draft);
      this.publish({ kind: 'editing' }, draft);
    } catch {
      this.publish({
        kind: 'failed',
        message: 'A separate report draft could not be retained safely.',
      });
    }
  }
  async submit() {
    const phase = this.snapshot.phase;
    if (phase.kind !== 'previewed' || phase.preview.kind !== 'ready' || !phase.request) return;
    try {
      const attempt = {
        request: phase.request,
        summary: 'Record completed manual plate-plan transfers',
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
      if (!('kind' in attempt.request) || attempt.request.kind !== 'record-plate-plan-observation')
        throw Error('This saved change is not a manual plan report.');
      this.assertRequest(attempt.request);
      this.pending.confirm(this.pending.retain(attempt), attempt.receipt);
      const observationId = inventoryPlatePlanObservationId(attempt.request.choices.identity),
        intentSha256 = inventoryPlatePlanObservationIntentSha256(
          attempt.request.choices,
          this.version.definition
        );
      const detail = inventoryPlatePlanObservationReadSchema.parse(
        await this.client.platePlanObservation({ ...this.scope, observationId, intentSha256 })
      );
      if (
        detail.kind !== 'available' ||
        detail.projectId !== this.scope.project ||
        detail.inventoryId !== this.scope.inventoryId ||
        detail.observation.id !== observationId ||
        detail.observation.intentSha256 !== intentSha256
      )
        throw Error('The saved manual report could not be read.');
      this.pending.clear(this.pending.retain(attempt));
      this.publish({ kind: 'complete', observationId, intentSha256 });
    } catch (cause) {
      this.publish({
        kind: 'saved-refresh-failed',
        attempt,
        message: `The transfers were recorded. Reload this same result. ${message(cause)}`,
      });
    }
  }
  private async send(attempt: InventoryAttempt) {
    this.publish({ kind: 'sending' });
    let release: (() => void) | undefined;
    try {
      const saved = this.pending.peek(attempt.request);
      if (saved?.receipt) return this.committed({ ...saved, receipt: saved.receipt });
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
          throw Error('The manual report result could not be confirmed.');
        this.pending.clear(this.pending.retain(attempt));
        this.publish({ kind: 'failed', message: result.message });
      }
    } catch (cause) {
      this.publish({
        kind: 'unknown',
        attempt,
        message: `The report needs confirmation. ${message(cause)}`,
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
      const saved = this.pending.peek(phase.attempt.request);
      if (saved?.receipt) return this.committed({ ...saved, receipt: saved.receipt });
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
          message: 'No completed report was found. Retry only this same saved report.',
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
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The manual plate-plan report is unavailable.';
}

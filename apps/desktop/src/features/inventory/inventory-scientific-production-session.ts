import {
  inventoryScientificProductionId,
  inventoryScientificProductionIntentSha256,
  inventoryScientificProductionChoices,
  parseInventoryScientificProductionChoices,
  inventoryTableCanonicalJson,
  normalizeInventoryAmount,
  type AcceptedDnaProductionSelection,
  type InventoryScientificProduction,
  type InventoryLocalPrincipal,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyScientificProductionRequestSchema,
  inventoryScientificProductionPreviewSnapshotSchema,
  inventoryScientificProductionReadSchema,
  type InventoryApplyScientificProductionRequest,
  type InventoryScientificProductionPreviewSnapshot,
} from '../../shared/inventory-scientific-productions';
import {
  assertInventoryReceiptForAttempt,
  executeInventoryAcceptedRequest,
  type InventoryAttempt,
  type InventoryPendingCoordinator,
} from './inventory-pending-coordinator';
export type ScientificProductionScope = { project: string; inventoryId: string };
export type ScientificProductionResource = {
  projectId: string;
  workspaceScope: string;
  entityId: string;
  fileObjectUuid: string | null;
};
export type ScientificProductionDraft = {
  productionId: string;
  sourceSha256: string;
  design: AcceptedDnaProductionSelection | null;
  inputs: { key: string; stockId: string; amount: string }[];
  outputVesselId: string;
  outputAmount: string;
  lotName: string;
  method: string;
  reason: string;
  declaration: '' | 'completed' | 'uncertain';
};
type Phase =
  | { kind: 'editing' | 'previewing' | 'sending' }
  | { kind: 'failed'; message: string }
  | {
      kind: 'previewed';
      preview: InventoryScientificProductionPreviewSnapshot;
      request?: InventoryApplyScientificProductionRequest;
    }
  | { kind: 'unknown' | 'accepted-read-pending'; attempt: InventoryAttempt; message: string }
  | {
      kind: 'recorded';
      outcome: 'committed' | 'existing';
      production: InventoryScientificProduction;
    };
export class InventoryScientificProductionSession {
  private snapshot: { draft: ScientificProductionDraft; phase: Phase };
  private active = true;
  private generation = 0;
  private boundary: ReturnType<typeof setTimeout> | null = null;
  private prepared: InventoryApplyScientificProductionRequest | null = null;
  private principalKey: string | null = null;
  private writable = true;
  private listeners = new Set<() => void>();
  private readonly storageKey: string;
  constructor(
    readonly scope: ScientificProductionScope,
    readonly resource: ScientificProductionResource,
    private readonly client: InventoryClient,
    private readonly pending: InventoryPendingCoordinator,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly operationId: () => string = () => crypto.randomUUID()
  ) {
    this.storageKey = `dnaforge.inventory.scientific-production-draft.v1:${JSON.stringify([scope.project, scope.inventoryId, resource.entityId, resource.fileObjectUuid])}`;
    const draft: ScientificProductionDraft = {
      productionId: crypto.randomUUID(),
      sourceSha256: '',
      design: null,
      inputs: [{ key: crypto.randomUUID(), stockId: '', amount: '' }],
      outputVesselId: '',
      outputAmount: '',
      lotName: '',
      method: '',
      reason: '',
      declaration: '',
    };
    this.snapshot = { draft, phase: { kind: 'editing' } };
    try {
      if (resource.projectId !== scope.project || resource.workspaceScope !== scope.project)
        throw Error('This Run does not belong to the selected inventory project.');
      const raw = storage.getItem(this.storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          !saved.draft ||
          [
            'productionId',
            'sourceSha256',
            'outputVesselId',
            'outputAmount',
            'lotName',
            'method',
            'reason',
          ].some((key) => typeof saved.draft[key] !== 'string') ||
          !['', 'completed', 'uncertain'].includes(saved.draft.declaration) ||
          !Array.isArray(saved.draft.inputs) ||
          saved.draft.inputs.some(
            (row: Record<string, unknown>) =>
              !row || ['key', 'stockId', 'amount'].some((key) => typeof row[key] !== 'string')
          )
        )
          throw Error('The retained production draft could not be read.');
        this.snapshot.draft = saved.draft;
        if (saved.prepared) {
          inventoryApplyScientificProductionRequestSchema.parse(saved.prepared);
          this.assertRequest(saved.prepared);
          this.prepared = saved.prepared;
        }
      }
      this.retainDraft();
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
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
    return ['sending', 'unknown', 'accepted-read-pending', 'recorded'].includes(
      this.snapshot.phase.kind
    );
  }
  private retainDraft(draft = this.snapshot.draft) {
    this.storage.setItem(
      this.storageKey,
      JSON.stringify({ version: 1, draft, prepared: this.prepared })
    );
  }
  invalidate() {
    ++this.generation;
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
    if (!this.busy()) this.publish({ kind: 'editing' });
  }
  setWritable(value: boolean) {
    if (this.writable !== value) this.invalidate();
    this.writable = value;
  }
  setPrincipal(principal: InventoryLocalPrincipal) {
    const key = inventoryTableCanonicalJson(principal);
    if (this.principalKey !== null && key !== this.principalKey) this.invalidate();
    this.principalKey = key;
  }
  edit(draft: ScientificProductionDraft) {
    if (this.busy()) return;
    this.invalidate();
    this.prepared = null;
    try {
      this.retainDraft(draft);
      this.publish({ kind: 'editing' }, structuredClone(draft));
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  private choices() {
    const draft = this.snapshot.draft;
    if (draft.declaration !== 'completed')
      throw Error('Confirm that this production was completed manually before recording it.');
    if (!draft.design) throw Error('Choose an existing accepted DNA design.');
    return parseInventoryScientificProductionChoices({
      identity: { namespace: 'manual-scientific-production', productionId: draft.productionId },
      context: {
        kind: 'protocol-run',
        entityId: this.resource.entityId,
        sourceSha256: draft.sourceSha256,
      },
      design: draft.design,
      inputs: draft.inputs.map((row) => ({
        stockId: row.stockId,
        quantity: normalizeInventoryAmount({ value: row.amount, unit: 'uL' }),
      })),
      output: {
        vesselId: draft.outputVesselId,
        quantity: normalizeInventoryAmount({ value: draft.outputAmount, unit: 'uL' }),
        lotName: draft.lotName,
      },
      method: draft.method.trim(),
      reason: draft.reason.trim(),
    });
  }
  async preview(original?: InventoryScientificProduction) {
    if ((this.busy() || !this.writable) && !original) return;
    this.invalidate();
    const generation = this.generation,
      started = performance.now();
    try {
      this.retainDraft();
      const choices = original ? inventoryScientificProductionChoices(original) : this.choices();
      this.publish({ kind: 'previewing' });
      const state = await this.client.inspect(this.scope);
      if (!this.current(generation)) return;
      const revision = state?.revision ?? 0;
      const preview = inventoryScientificProductionPreviewSnapshotSchema.parse(
        await this.client.previewScientificProduction({
          ...this.scope,
          expectedRevision: revision,
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
        (preview.kind === 'ready' && preview.revision !== revision) ||
        (this.principalKey !== null &&
          this.principalKey !== inventoryTableCanonicalJson(preview.principal))
      )
        throw Error('The production preview no longer matches this inventory or caller.');
      if (preview.kind !== 'blocked') this.assertProduction(preview.production, choices);
      if (original && preview.kind !== 'no-change')
        throw Error('The original production could not be confirmed. No new report will be sent.');
      const delay =
        preview.nextBoundaryAt === null
          ? null
          : preview.nextBoundaryAt - preview.asOf - (performance.now() - started);
      if (preview.kind === 'ready' && delay !== null && delay <= 0)
        throw Error('Availability changed while previewing. Preview again.');
      const request =
        preview.kind === 'ready'
          ? inventoryApplyScientificProductionRequestSchema.parse({
              ...this.scope,
              kind: 'record-scientific-production',
              expectedRevision: revision,
              operationId:
                this.prepared &&
                this.prepared.expectedRevision === revision &&
                this.prepared.expectedPlanDigest === preview.planDigest &&
                inventoryTableCanonicalJson(this.prepared.choices) ===
                  inventoryTableCanonicalJson(choices)
                  ? this.prepared.operationId
                  : this.operationId(),
              expectedPlanDigest: preview.planDigest,
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
  private assertRequest(request: InventoryApplyScientificProductionRequest) {
    if (
      request.project !== this.scope.project ||
      request.inventoryId !== this.scope.inventoryId ||
      request.choices.context.kind !== 'protocol-run' ||
      request.choices.context.entityId !== this.resource.entityId
    )
      throw Error('The retained production belongs to another Run or inventory.');
  }
  private assertProduction(
    production: InventoryScientificProduction,
    choices: InventoryApplyScientificProductionRequest['choices']
  ) {
    if (
      production.id !== inventoryScientificProductionId(choices.identity) ||
      production.intentSha256 !== inventoryScientificProductionIntentSha256(choices) ||
      inventoryTableCanonicalJson(inventoryScientificProductionChoices(production)) !==
        inventoryTableCanonicalJson(choices)
    )
      throw Error('The saved production does not match the exact original report.');
  }
  resume(attempt: InventoryAttempt) {
    if (!('kind' in attempt.request) || attempt.request.kind !== 'record-scientific-production')
      throw Error('This saved change is not a production report.');
    this.assertRequest(attempt.request);
    this.invalidate();
    this.publish({
      kind: attempt.receipt ? 'accepted-read-pending' : 'unknown',
      attempt,
      message: 'Confirm the original production report before starting another report.',
    });
  }
  async submit() {
    const phase = this.snapshot.phase;
    if (
      !this.writable ||
      phase.kind !== 'previewed' ||
      phase.preview.kind !== 'ready' ||
      !phase.request
    )
      return;
    const attempt: InventoryAttempt = {
      request: phase.request,
      summary: 'Record completed manual production',
    };
    try {
      this.pending.retain(attempt);
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
      return;
    }
    await this.send(attempt);
  }
  private async exact(attempt: InventoryAttempt) {
    if (!('kind' in attempt.request) || attempt.request.kind !== 'record-scientific-production')
      throw Error('This change is not a production report.');
    this.assertRequest(attempt.request);
    const choices = attempt.request.choices;
    const result = inventoryScientificProductionReadSchema.parse(
      await this.client.scientificProduction({
        ...this.scope,
        productionId: inventoryScientificProductionId(choices.identity),
        intentSha256: inventoryScientificProductionIntentSha256(choices),
      })
    );
    if (result.kind !== 'available') throw Error(result.message);
    if (result.projectId !== this.scope.project || result.inventoryId !== this.scope.inventoryId)
      throw Error('The saved production belongs to another inventory.');
    this.assertProduction(result.production, choices);
    return result.production;
  }
  private async existing(attempt: InventoryAttempt) {
    const production = await this.exact(attempt);
    this.pending.clear(this.pending.retain(attempt));
    this.publish({ kind: 'recorded', outcome: 'existing', production });
  }
  private async committed(
    attempt: InventoryAttempt & { receipt: NonNullable<InventoryAttempt['receipt']> }
  ) {
    assertInventoryReceiptForAttempt(attempt, attempt.receipt);
    this.pending.confirm(this.pending.retain(attempt), attempt.receipt);
    this.publish({
      kind: 'accepted-read-pending',
      attempt,
      message: 'The production was recorded. Loading its original saved facts…',
    });
    try {
      const production = await this.exact(attempt);
      this.pending.clear(this.pending.retain(attempt));
      this.publish({ kind: 'recorded', outcome: 'committed', production });
    } catch (cause) {
      this.publish({
        kind: 'accepted-read-pending',
        attempt,
        message: `The production was recorded. ${message(cause)}`,
      });
    }
  }
  private async send(attempt: InventoryAttempt) {
    let release: (() => void) | undefined;
    try {
      const token = this.pending.retain(attempt);
      release = this.pending.acquire(token, 'send');
      this.publish({ kind: 'sending' });
      const result = await executeInventoryAcceptedRequest(this.client, attempt.request);
      if (result?.status === 'committed') {
        await this.committed({ ...attempt, receipt: result });
      } else if (
        result?.status === 'rejected' &&
        result.operationId === attempt.request.operationId &&
        result.inventoryId === attempt.request.inventoryId &&
        typeof result.code === 'string' &&
        typeof result.message === 'string'
      ) {
        if (result.code === 'INVENTORY_SCIENTIFIC_PRODUCTION_NO_CHANGES')
          await this.existing(attempt);
        else {
          this.pending.clear(token);
          this.publish({ kind: 'failed', message: result.message });
        }
      } else throw Error('The acknowledgement does not match the original production request.');
    } catch (cause) {
      this.publish({
        kind: 'unknown',
        attempt,
        message: `Keep the original report. ${message(cause)}`,
      });
    } finally {
      release?.();
    }
  }
  async checkStatus() {
    const phase = this.snapshot.phase;
    if (phase.kind !== 'unknown' && phase.kind !== 'accepted-read-pending') return;
    const attempt = phase.attempt;
    let release: (() => void) | undefined;
    try {
      release = this.pending.acquire(this.pending.retain(attempt), 'inspect');
      if (attempt.receipt) {
        await this.committed({ ...attempt, receipt: attempt.receipt });
        return;
      }
      const receipt = await this.client.operation({
        ...this.scope,
        operationId: attempt.request.operationId,
      });
      if (receipt) await this.committed({ ...attempt, receipt });
      else await this.existing(attempt);
    } catch (cause) {
      this.publish({
        kind: attempt.receipt ? 'accepted-read-pending' : 'unknown',
        attempt,
        message: message(cause),
      });
    } finally {
      release?.();
    }
  }
  async retry() {
    const phase = this.snapshot.phase;
    if (phase.kind === 'unknown') await this.send(phase.attempt);
    else if (phase.kind === 'accepted-read-pending') await this.checkStatus();
  }
  newReport() {
    if (this.snapshot.phase.kind !== 'recorded') return;
    this.prepared = null;
    const draft = {
      ...this.snapshot.draft,
      productionId: crypto.randomUUID(),
      outputVesselId: '',
      outputAmount: '',
      lotName: '',
      reason: '',
      declaration: '' as const,
    };
    this.publish({ kind: 'editing' });
    this.edit(draft);
  }
  detach() {
    this.active = false;
    ++this.generation;
    if (this.boundary) clearTimeout(this.boundary);
    this.boundary = null;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The production report could not be confirmed.';
}

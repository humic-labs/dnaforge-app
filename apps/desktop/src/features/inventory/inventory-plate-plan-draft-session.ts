import {
  normalizeInventoryAmount,
  parseInventoryPlatePlanDefinition,
  inventoryPlatePlanDefinitionSha256,
  inventoryPlatePlanVersionId,
  inventoryTableCanonicalJson,
  type InventoryPlatePlanVersion,
  type InventoryPlatePlanVersionChoices,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import {
  inventoryApplyPlatePlanVersionRequestSchema,
  inventoryPlatePlanVersionPreviewSnapshotSchema,
  inventoryPlatePlanVersionReadSchema,
  inventoryPlatePlanVersionsReadSchema,
  type InventoryPlatePlanVersionPreviewSnapshot,
  type InventoryApplyPlatePlanVersionRequest,
} from '../../shared/inventory-plate-plans';
import {
  InventoryPendingCoordinator,
  assertInventoryReceiptForAttempt,
  executeInventoryAcceptedRequest,
  type InventoryAttempt,
} from './inventory-pending-coordinator';
export type PlatePlanScope = { project: string; inventoryId: string };
export type PlatePlanDraft = {
  identity: { namespace: string; planId: string };
  title: string;
  rows: string;
  columns: string;
  reason: string;
  sourceSlots: { key: string; label: string }[];
  transfers: {
    actionId: string;
    sourceSlotKey: string;
    destinationPosition: string;
    volume: string;
    label: string;
  }[];
};
type Save =
  | { kind: 'editing' | 'previewing' | 'sending' }
  | {
      kind: 'previewed';
      preview: InventoryPlatePlanVersionPreviewSnapshot;
      choices: InventoryPlatePlanVersionChoices;
      request?: InventoryApplyPlatePlanVersionRequest;
    }
  | { kind: 'unknown' | 'saved-refresh-failed'; attempt: InventoryAttempt; message: string }
  | { kind: 'complete'; version: InventoryPlatePlanVersion }
  | { kind: 'failed'; message: string };
function fresh(): PlatePlanDraft {
  const role = `source-${crypto.randomUUID()}`;
  return {
    identity: { namespace: 'manual-plate-plans', planId: crypto.randomUUID() },
    title: '',
    rows: '8',
    columns: '12',
    reason: '',
    sourceSlots: [{ key: role, label: 'Source 1' }],
    transfers: [
      {
        actionId: crypto.randomUUID(),
        sourceSlotKey: role,
        destinationPosition: 'A1',
        volume: '4',
        label: 'Transfer 1',
      },
    ],
  };
}
export function platePlanDraftChoices(draft: PlatePlanDraft): InventoryPlatePlanVersionChoices {
  const definition = parseInventoryPlatePlanDefinition({
    schema: 'dnaforge.inventory-plate-plan-definition.v1',
    title: draft.title.trim(),
    layout: { kind: 'fixed-well', rows: Number(draft.rows), columns: Number(draft.columns) },
    sourceSlots: draft.sourceSlots.map((slot) => ({ ...slot, label: slot.label.trim() })),
    transfers: draft.transfers.map(({ volume, ...transfer }) => {
      const amount = normalizeInventoryAmount({ value: volume, unit: 'uL' });
      return {
        ...transfer,
        label: transfer.label.trim(),
        quantity: { value: amount.value, unit: 'uL' },
      };
    }),
  });
  return { identity: { ...draft.identity }, definition, reason: draft.reason.trim() };
}
function fromChoices(choices: InventoryPlatePlanVersionChoices): PlatePlanDraft {
  return {
    identity: { ...choices.identity },
    title: choices.definition.title,
    rows: String(choices.definition.layout.rows),
    columns: String(choices.definition.layout.columns),
    reason: choices.reason,
    sourceSlots: choices.definition.sourceSlots.map((slot) => ({ ...slot })),
    transfers: choices.definition.transfers.map(({ quantity, ...row }) => ({
      ...row,
      volume: quantity.value,
    })),
  };
}
export class InventoryPlatePlanDraftSession {
  private snapshot: { draft: PlatePlanDraft; save: Save };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private prepared: InventoryApplyPlatePlanVersionRequest | null = null;
  private detached = false;
  private readonly key: string;
  constructor(
    private readonly scope: PlatePlanScope,
    private readonly client: InventoryClient,
    private readonly pending: InventoryPendingCoordinator,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly operationId: () => string = () => crypto.randomUUID()
  ) {
    this.key = `dnaforge.inventory.plate-plan-draft.v1:${JSON.stringify(scope)}`;
    let draft = fresh();
    try {
      const raw = storage.getItem(this.key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          !saved.draft ||
          typeof saved.draft.identity?.planId !== 'string' ||
          !Array.isArray(saved.draft.sourceSlots) ||
          !Array.isArray(saved.draft.transfers)
        )
          throw Error('The saved plan draft could not be read.');
        draft = saved.draft;
        if (saved.prepared) {
          const request = inventoryApplyPlatePlanVersionRequestSchema.parse(saved.prepared);
          if (request.project !== scope.project || request.inventoryId !== scope.inventoryId)
            throw Error('The prepared plan draft belongs to another inventory.');
          this.prepared = request;
        }
      }
      this.snapshot = { draft, save: { kind: 'editing' } };
    } catch (cause) {
      this.snapshot = { draft, save: { kind: 'failed', message: message(cause) } };
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  activate() {
    this.detached = false;
  }
  private publish(save: Save, draft = this.snapshot.draft) {
    if (this.detached) return;
    this.snapshot = { draft, save };
    for (const listener of this.listeners) listener();
  }
  private busy() {
    return ['sending', 'unknown', 'saved-refresh-failed'].includes(this.snapshot.save.kind);
  }
  edit(draft: PlatePlanDraft) {
    if (this.busy()) return;
    ++this.generation;
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({ version: 1, draft, prepared: this.prepared })
      );
      this.publish({ kind: 'editing' }, structuredClone(draft));
    } catch {
      this.publish({ kind: 'failed', message: 'The plan draft could not be retained safely.' });
    }
  }
  newPlan() {
    this.edit(fresh());
  }
  editVersion(version: InventoryPlatePlanVersion) {
    this.edit({ ...fromChoices(version), reason: '' });
  }
  invalidate() {
    if (!this.busy() && this.snapshot.save.kind !== 'complete') {
      ++this.generation;
      this.publish({ kind: 'editing' });
    }
  }
  async preview() {
    if (this.busy()) return;
    const generation = ++this.generation;
    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({ version: 1, draft: this.snapshot.draft, prepared: this.prepared })
      );
      const choices = platePlanDraftChoices(this.snapshot.draft);
      this.publish({ kind: 'previewing' });
      const list = inventoryPlatePlanVersionsReadSchema.parse(
        await this.client.platePlanVersions({ ...this.scope, limit: 1, identity: choices.identity })
      );
      if (this.detached || generation !== this.generation) return;
      if (list.kind === 'unavailable') throw Error(list.message);
      if (
        list.projectId !== this.scope.project ||
        list.inventoryId !== this.scope.inventoryId ||
        JSON.stringify(list.identity) !== JSON.stringify(choices.identity)
      )
        throw Error('The plan inventory belongs to another scope or family.');
      const revision = list.kind === 'ready' ? list.revision : 0;
      const preview = inventoryPlatePlanVersionPreviewSnapshotSchema.parse(
        await this.client.previewPlatePlanVersion({
          ...this.scope,
          expectedRevision: revision,
          choices,
        })
      );
      if (this.detached || generation !== this.generation) return;
      if (
        preview.projectId !== this.scope.project ||
        preview.inventoryId !== this.scope.inventoryId ||
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId ||
        (preview.kind === 'ready' && preview.target.revision !== revision)
      )
        throw Error('The save preview belongs to another inventory.');
      if (
        preview.kind !== 'blocked' &&
        (inventoryTableCanonicalJson(preview.version.identity) !==
          inventoryTableCanonicalJson(choices.identity) ||
          inventoryTableCanonicalJson(preview.version.definition) !==
            inventoryTableCanonicalJson(choices.definition))
      )
        throw Error('The save preview belongs to another definition or plan family.');
      const request =
        preview.kind === 'ready'
          ? inventoryApplyPlatePlanVersionRequestSchema.parse({
              ...this.scope,
              kind: 'save-plate-plan-version',
              expectedRevision: preview.target.revision,
              expectedPlanDigest: preview.planDigest,
              operationId:
                this.prepared &&
                this.prepared.expectedRevision === preview.target.revision &&
                this.prepared.expectedPlanDigest === preview.planDigest &&
                JSON.stringify(this.prepared.choices) === JSON.stringify(choices)
                  ? this.prepared.operationId
                  : this.operationId(),
              choices,
            })
          : undefined;
      this.prepared = request ?? null;
      this.storage.setItem(
        this.key,
        JSON.stringify({ version: 1, draft: this.snapshot.draft, prepared: this.prepared })
      );
      this.publish({ kind: 'previewed', preview, choices, ...(request ? { request } : {}) });
    } catch (cause) {
      if (!this.detached && generation === this.generation)
        this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  async submit() {
    const save = this.snapshot.save;
    if (save.kind !== 'previewed' || save.preview.kind !== 'ready' || !save.request) return;
    try {
      const request = save.request;
      const attempt = { request, summary: 'Save reusable plate-plan version' };
      this.pending.retain(attempt);
      await this.send(attempt);
    } catch (cause) {
      this.publish({ kind: 'failed', message: message(cause) });
    }
  }
  resume(attempt: InventoryAttempt) {
    if (
      !('kind' in attempt.request) ||
      attempt.request.kind !== 'save-plate-plan-version' ||
      attempt.request.project !== this.scope.project ||
      attempt.request.inventoryId !== this.scope.inventoryId
    )
      throw Error('The saved plan change belongs to another inventory.');
    this.publish(
      {
        kind: attempt.receipt ? 'saved-refresh-failed' : 'unknown',
        attempt,
        message: attempt.receipt
          ? 'This version was saved. Reload its result.'
          : 'A saved plan change needs confirmation.',
      },
      fromChoices(attempt.request.choices)
    );
  }
  private async saved(
    attempt: InventoryAttempt & { receipt: NonNullable<InventoryAttempt['receipt']> }
  ) {
    try {
      if (!('kind' in attempt.request) || attempt.request.kind !== 'save-plate-plan-version')
        throw Error('The saved change is not a plan version.');
      this.pending.confirm(this.pending.retain(attempt), attempt.receipt);
      const choices = attempt.request.choices,
        definitionSha256 = inventoryPlatePlanDefinitionSha256(choices.definition),
        versionId = inventoryPlatePlanVersionId(choices.identity, definitionSha256);
      const result = inventoryPlatePlanVersionReadSchema.parse(
        await this.client.platePlanVersion({ ...this.scope, versionId, definitionSha256 })
      );
      if (result.kind !== 'available') throw Error(result.message);
      if (
        result.projectId !== this.scope.project ||
        result.inventoryId !== this.scope.inventoryId ||
        result.version.id !== versionId ||
        result.version.definitionSha256 !== definitionSha256
      )
        throw Error('The saved version belongs to another plan.');
      this.pending.clear(this.pending.retain(attempt));
      this.publish({ kind: 'complete', version: result.version });
    } catch (cause) {
      this.publish({
        kind: 'saved-refresh-failed',
        attempt,
        message: `The version was saved. Reload its result. ${message(cause)}`,
      });
    }
  }
  private async send(attempt: InventoryAttempt) {
    this.publish({ kind: 'sending' });
    let release: (() => void) | undefined;
    try {
      const retained = this.pending.peek(attempt.request);
      if (retained?.receipt) return this.saved({ ...retained, receipt: retained.receipt });
      release = this.pending.acquire(this.pending.retain(attempt), 'send');
      const result = await executeInventoryAcceptedRequest(this.client, attempt.request);
      if (result.status === 'committed') {
        assertInventoryReceiptForAttempt(attempt, result);
        await this.saved({ ...attempt, receipt: result });
      } else {
        if (
          result.status !== 'rejected' ||
          result.inventoryId !== attempt.request.inventoryId ||
          result.operationId !== attempt.request.operationId ||
          typeof result.code !== 'string' ||
          typeof result.message !== 'string'
        )
          throw Error('The plan result could not be confirmed.');
        this.pending.clear(this.pending.retain(attempt));
        this.publish({ kind: 'failed', message: result.message });
      }
    } catch (cause) {
      this.publish({
        kind: 'unknown',
        attempt,
        message: `The plan result needs confirmation. ${message(cause)}`,
      });
    } finally {
      release?.();
    }
  }
  async checkStatus() {
    const save = this.snapshot.save;
    if (save.kind !== 'unknown') return;
    let release: (() => void) | undefined;
    try {
      const retained = this.pending.peek(save.attempt.request);
      if (retained?.receipt) return this.saved({ ...retained, receipt: retained.receipt });
      release = this.pending.acquire(this.pending.retain(save.attempt), 'inspect');
      const receipt = await this.client.operation({
        project: save.attempt.request.project,
        inventoryId: save.attempt.request.inventoryId,
        operationId: save.attempt.request.operationId,
      });
      if (receipt) {
        assertInventoryReceiptForAttempt(save.attempt, receipt);
        await this.saved({ ...save.attempt, receipt });
      } else
        this.publish({
          ...save,
          message: 'No completed save was found. You can retry this same change.',
        });
    } catch (cause) {
      this.publish({ ...save, message: message(cause) });
    } finally {
      release?.();
    }
  }
  async retry() {
    const save = this.snapshot.save;
    if (save.kind === 'unknown') await this.send(save.attempt);
  }
  async reloadSaved() {
    const save = this.snapshot.save;
    if (save.kind === 'saved-refresh-failed' && save.attempt.receipt)
      await this.saved({ ...save.attempt, receipt: save.attempt.receipt });
  }
  detach() {
    this.detached = true;
    ++this.generation;
  }
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The plan could not be saved.';
}

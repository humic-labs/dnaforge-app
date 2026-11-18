import {
  INVENTORY_AMOUNT_UNITS,
  type InventoryAmountUnit,
  type InventoryScientificTransferChoicesV2,
} from '@waypoint/domain-services';
import type { InventoryClient } from '../../shared/inventory-client';
import type { InventoryReadRequest } from '../../shared/inventory-command';

export interface InventoryScientificDraft {
  namespace: string;
  workId: string;
  contextKind: 'notebook-page' | 'protocol-run';
  entityId: string;
  expectedSourceSha256: string;
  sourceStockId: string;
  destinationVesselId: string;
  quantity: string;
  unit: InventoryAmountUnit;
  reason: string;
}
const fresh = (): InventoryScientificDraft => ({
  namespace: 'manual-observations',
  workId: crypto.randomUUID(),
  contextKind: 'notebook-page',
  entityId: '',
  expectedSourceSha256: '',
  sourceStockId: '',
  destinationVesselId: '',
  quantity: '',
  unit: 'uL',
  reason: '',
});
export function inventoryScientificChoices(
  draft: InventoryScientificDraft
): InventoryScientificTransferChoicesV2 {
  for (const [key, value] of Object.entries(draft))
    if (!value.trim())
      throw Error(
        `Complete ${key === 'expectedSourceSha256' ? 'the saved notebook selection' : key}.`
      );
  if (!/^sha256:[a-f0-9]{64}$/u.test(draft.expectedSourceSha256))
    throw Error('Choose a current saved notebook source.');
  return {
    identity: { namespace: draft.namespace.trim(), workId: draft.workId.trim() },
    context: {
      kind: draft.contextKind,
      entityId: draft.entityId,
      sourceSha256: draft.expectedSourceSha256 as `sha256:${string}`,
    },
    sourceStockId: draft.sourceStockId,
    destinationVesselId: draft.destinationVesselId,
    quantity: { value: draft.quantity, unit: draft.unit },
    reason: draft.reason.trim(),
  };
}
type Snapshot = { draft: InventoryScientificDraft } & (
  | { phase: 'editing' | 'previewing' }
  | {
      phase: 'previewed';
      choices: InventoryScientificTransferChoicesV2;
      preview: Awaited<ReturnType<InventoryClient['previewScientificTransferV2']>>;
    }
  | { phase: 'failed'; message: string }
);
export class InventoryScientificSession {
  private current: Snapshot;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly client: InventoryClient,
    private readonly scope: InventoryReadRequest,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  ) {
    let draft = fresh();
    try {
      const raw = storage?.getItem(this.key());
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.version === 1 && saved.draft) {
          const { pageId, ...old } = saved.draft;
          saved.draft = { ...old, contextKind: 'notebook-page', entityId: pageId };
          saved.version = 2;
        }
        if (
          saved.version !== 2 ||
          !saved.draft ||
          Object.keys(draft).some((key) => typeof saved.draft[key] !== 'string') ||
          !INVENTORY_AMOUNT_UNITS.includes(saved.draft.unit) ||
          !['notebook-page', 'protocol-run'].includes(saved.draft.contextKind)
        )
          throw Error('The saved scientific transfer draft is invalid.');
        draft = saved.draft;
      }
      this.current = { phase: 'editing', draft };
    } catch (cause) {
      this.current = {
        phase: 'failed',
        draft,
        message:
          cause instanceof Error
            ? cause.message
            : 'The saved scientific transfer could not be read.',
      };
    }
  }
  private key() {
    return `dnaforge.inventory.scientific-draft.v1:${JSON.stringify(this.scope)}`;
  }
  private save(draft: InventoryScientificDraft) {
    if (!this.storage) throw Error('Scientific transfer recovery storage is unavailable.');
    this.storage.setItem(this.key(), JSON.stringify({ version: 2, draft }));
  }
  getSnapshot = (): Snapshot => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(snapshot: Snapshot) {
    this.current = snapshot;
    for (const listener of this.listeners) listener();
  }
  edit(draft: InventoryScientificDraft) {
    ++this.generation;
    try {
      this.save(draft);
      this.publish({ phase: 'editing', draft: structuredClone(draft) });
    } catch {
      this.publish({
        phase: 'failed',
        draft,
        message:
          'The scientific transfer recovery draft could not be saved. Restore local storage before recording.',
      });
    }
  }
  newObservation() {
    this.edit(fresh());
  }
  cancelPreview() {
    ++this.generation;
    if (this.current.phase === 'previewing')
      this.publish({ phase: 'editing', draft: this.current.draft });
  }
  async preview(expectedRevision: number) {
    const generation = ++this.generation,
      draft = this.current.draft;
    try {
      this.save(draft);
      const choices = inventoryScientificChoices(draft);
      this.publish({ phase: 'previewing', draft });
      const preview = await this.client.previewScientificTransferV2({
        ...this.scope,
        expectedRevision,
        choices,
      });
      if (generation !== this.generation) return;
      if (
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId
      )
        throw Error('The scientific preview belongs to another project or inventory.');
      this.publish({ phase: 'previewed', draft, choices, preview });
    } catch (cause) {
      if (generation === this.generation)
        this.publish({
          phase: 'failed',
          draft,
          message:
            cause instanceof Error
              ? cause.message
              : 'The observed scientific transfer could not be previewed.',
        });
    }
  }
}

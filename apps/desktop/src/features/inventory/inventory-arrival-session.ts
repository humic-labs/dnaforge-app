import {
  type InventoryAmountUnit,
  type InventoryArrivalChoices,
  type InventoryArrivalSource,
  type InventoryVesselPlacement,
} from '@waypoint/domain-services';
import type {
  InventoryArrivalPreviewSnapshot,
  InventoryClient,
} from '../../shared/inventory-client';

export interface InventoryArrivalComponentDraft {
  key: string;
  label: string;
  componentBatch: string;
  disposition:
    | 'identified'
    | 'unidentified-physical'
    | 'unobserved-physical'
    | 'observed-missing'
    | 'evidence-only';
  materialId: string;
  lotKind: 'new' | 'existing' | 'unattributed';
  lotReason: string;
  lotId: string;
  lotName: string;
  lotNumber: string;
  managementReason: string;
  quantityKind: 'known' | 'unknown';
  quantity: string;
  unit: InventoryAmountUnit;
  quantityReason: string;
  quality: '' | 'usable' | 'quarantined';
  qualityReason: string;
  vesselName: string;
  storageId: string;
  position: string;
  dispositionReason: string;
}
export interface InventoryArrivalDraft {
  namespace: string;
  deliveryId: string;
  supplier: string;
  supplierKind: 'known' | 'unknown';
  observationReason: string;
  scopeKind: 'selected-components' | 'complete-listed-manifest';
  scopeReason: string;
  documentText: string;
  documentCoverage: '' | 'full' | 'excerpt';
  excerptReason: string;
  packageLabel: string;
  packagingBatch: string;
  components: readonly InventoryArrivalComponentDraft[];
}
export const newArrivalComponent = (key: string): InventoryArrivalComponentDraft => ({
  key,
  label: '',
  componentBatch: '',
  disposition: 'identified',
  materialId: '',
  lotKind: 'new',
  lotReason: '',
  lotId: '',
  lotName: '',
  lotNumber: '',
  managementReason: '',
  quantityKind: 'known',
  quantity: '',
  unit: 'mg',
  quantityReason: '',
  quality: '',
  qualityReason: '',
  vesselName: '',
  storageId: '',
  position: '',
  dispositionReason: '',
});
const initialDraft = (): InventoryArrivalDraft => ({
  namespace: 'local-deliveries',
  deliveryId: crypto.randomUUID(),
  supplier: '',
  supplierKind: 'known',
  observationReason: '',
  scopeKind: 'selected-components',
  scopeReason: '',
  documentText: '',
  documentCoverage: '',
  excerptReason: '',
  packageLabel: '',
  packagingBatch: '',
  components: [newArrivalComponent('component-1')],
});
const required = (value: string, label: string) => {
  if (!value.trim()) throw new Error(`Enter ${label}.`);
  return value.trim();
};
export function inventoryArrivalDraftInput(draft: InventoryArrivalDraft): {
  sourceText: string;
  options: InventoryArrivalChoices;
} {
  if (!draft.documentCoverage)
    throw new Error('Choose full document or an explicitly labeled excerpt.');
  if (!draft.documentText) throw new Error('Retain the original supplier document text.');
  const supplier =
    draft.supplierKind === 'unknown' ? null : required(draft.supplier, 'the supplier');
  const source: InventoryArrivalSource = {
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: {
      namespace: required(draft.namespace, 'the delivery namespace'),
      arrivalId: required(draft.deliveryId, 'the actual delivery ID'),
    },
    supplier,
    observedAt: null,
    observationReason: required(draft.observationReason, 'the actual arrival observation reason'),
    scope: {
      kind: draft.scopeKind,
      reason: required(draft.scopeReason, 'the observed component scope'),
    },
    documents: [
      {
        key: 'document-1',
        mediaType: 'text/plain',
        body: { encoding: 'utf8', value: draft.documentText },
        reference: null,
        coverage:
          draft.documentCoverage === 'full'
            ? { kind: 'full' }
            : {
                kind: 'excerpt',
                reason: required(draft.excerptReason, 'the excerpt scope reason'),
              },
      },
    ],
    packages: draft.packageLabel.trim()
      ? [
          {
            key: 'package-1',
            label: draft.packageLabel.trim(),
            productCode: null,
            packagingBatch: draft.packagingBatch.trim() || null,
          },
        ]
      : [],
    components: draft.components.map((component) => ({
      key: component.key,
      packageKey: draft.packageLabel.trim() ? 'package-1' : null,
      label: required(component.label, 'each component label'),
      productCode: null,
      componentBatch: component.componentBatch.trim() || null,
    })),
    claims: [],
  };
  const options: InventoryArrivalChoices = {
    components: draft.components.map((component) => {
      const placement: InventoryVesselPlacement = component.storageId
        ? {
            kind: 'located',
            storageId: component.storageId,
            slotId: required(component.position, 'the exact destination position'),
          }
        : { kind: 'unplaced' };
      const vessel = {
        name: required(
          component.vesselName ||
            (component.disposition === 'observed-missing' ||
            component.disposition === 'evidence-only'
              ? component.label
              : ''),
          'each physical container name'
        ),
        placement,
      };
      if (component.disposition === 'observed-missing' || component.disposition === 'evidence-only')
        return {
          componentKey: component.key,
          kind: component.disposition,
          reason: required(component.dispositionReason, 'the component disposition reason'),
        };
      if (component.disposition !== 'identified')
        return {
          componentKey: component.key,
          kind: component.disposition,
          vessel,
          reason: required(component.dispositionReason, 'the physical contents observation reason'),
        };
      if (!component.quality) throw new Error('Choose each stock’s local quality explicitly.');
      const reason = required(component.quantityReason, 'the measurement or unknown amount reason');
      return {
        componentKey: component.key,
        kind: 'identified',
        materialId: required(component.materialId, 'the current scientific material'),
        lot:
          component.lotKind === 'unattributed'
            ? {
                kind: 'unattributed',
                reason: required(component.lotReason, 'the unattributed lot reason'),
              }
            : component.lotKind === 'existing'
              ? {
                  kind: 'existing',
                  lotId: required(component.lotId, 'the existing lot'),
                  reason: required(component.lotReason, 'the existing lot mapping reason'),
                }
              : {
                  kind: 'new',
                  lotKey: component.key,
                  name: required(component.lotName, 'the new lot name'),
                  supplier: required(
                    supplier ?? '',
                    'the known supplier before creating a supplier lot'
                  ),
                  lotNumber: required(
                    component.componentBatch,
                    'the actual supplier component batch'
                  ),
                  managementReason: required(
                    component.managementReason,
                    'the local management reason'
                  ),
                },
        quantity:
          component.quantityKind === 'known'
            ? {
                kind: 'known',
                value: required(component.quantity, 'the measured amount'),
                unit: component.unit,
              }
            : { kind: 'unknown', unit: component.unit },
        quantityBasis:
          component.quantityKind === 'known'
            ? { kind: 'measurement', reason }
            : { kind: 'unknown', reason },
        stockQuality: {
          value: component.quality,
          reason: required(component.qualityReason, 'the local stock quality reason'),
        },
        vessel,
      };
    }),
  };
  return { sourceText: JSON.stringify(source), options };
}

type Snapshot = { draft: InventoryArrivalDraft } & (
  | { phase: 'editing' | 'previewing' }
  | {
      phase: 'previewed';
      input: ReturnType<typeof inventoryArrivalDraftInput>;
      preview: InventoryArrivalPreviewSnapshot;
    }
  | { phase: 'failed'; message: string }
);
export class InventoryArrivalSession {
  private current: Snapshot;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly client: InventoryClient,
    private readonly scope: { project: string; inventoryId: string },
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  ) {
    let draft = initialDraft();
    try {
      const saved = storage?.getItem(this.storageKey());
      if (saved) {
        const parsed = JSON.parse(saved) as { version?: unknown; draft?: unknown };
        if (parsed.version !== 1 || !parsed.draft || typeof parsed.draft !== 'object')
          throw new Error('Invalid saved delivery draft.');
        const candidate = parsed.draft as InventoryArrivalDraft;
        if (
          Object.keys(draft).some(
            (key) =>
              typeof candidate[key as keyof InventoryArrivalDraft] !==
              typeof draft[key as keyof InventoryArrivalDraft]
          ) ||
          !Array.isArray(candidate.components) ||
          !candidate.components.length ||
          candidate.components.some((component) =>
            Object.keys(newArrivalComponent('')).some(
              (key) => typeof component[key as keyof InventoryArrivalComponentDraft] !== 'string'
            )
          )
        )
          throw new Error('Invalid saved delivery draft fields.');
        draft = candidate;
      }
      this.current = { phase: 'editing', draft };
    } catch (cause) {
      this.current = {
        phase: 'failed',
        draft,
        message:
          cause instanceof Error ? cause.message : 'The saved delivery draft could not be read.',
      };
    }
  }
  private storageKey() {
    return `dnaforge.inventory.arrival-draft.v1:${JSON.stringify(this.scope)}`;
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
  edit(draft: InventoryArrivalDraft) {
    ++this.generation;
    try {
      this.storage?.setItem(this.storageKey(), JSON.stringify({ version: 1, draft }));
      this.publish({ phase: 'editing', draft });
    } catch {
      this.publish({
        phase: 'failed',
        draft,
        message: 'The delivery recovery draft could not be saved. Check storage before receiving.',
      });
    }
  }
  newDelivery() {
    this.edit(initialDraft());
  }
  async preview() {
    const generation = ++this.generation,
      draft = this.current.draft;
    try {
      this.storage?.setItem(this.storageKey(), JSON.stringify({ version: 1, draft }));
      const input = inventoryArrivalDraftInput(draft);
      this.publish({ phase: 'previewing', draft });
      const preview = await this.client.previewArrival({ ...this.scope, ...input });
      if (generation !== this.generation) return;
      if (
        preview.target.projectId !== this.scope.project ||
        preview.target.inventoryId !== this.scope.inventoryId
      )
        throw new Error('The delivery preview belongs to another project or inventory.');
      this.publish({ phase: 'previewed', draft, input, preview });
    } catch (cause) {
      if (generation === this.generation)
        this.publish({
          phase: 'failed',
          draft,
          message: cause instanceof Error ? cause.message : 'The delivery could not be previewed.',
        });
    }
  }
}

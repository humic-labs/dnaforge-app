import { applyInventoryCommandBatch } from './inventory-state';
import {
  createInventoryState,
  type InventoryCommand,
  type InventoryState,
} from './inventory-types';
import {
  applyInventoryPlatePlanVersion,
  inventoryPlatePlanVersionPreview,
} from './inventory-plate-plans';
import {
  inventoryNotebookSourceSha256,
  inventoryProtocolRunSourceSha256,
} from './inventory-scientific-source';
import type {
  InventoryScientificContextSource,
  InventoryNotebookSavedSource,
  InventoryProtocolRunSavedSource,
} from './inventory-scientific-types';
import type { InventoryPlatePlanDefinition } from './inventory-plate-plan-types';
import type { InventoryPlatePlanObservationPreviewInput } from './inventory-plate-plan-observation-types';

export const platePlanObservationPrincipal = {
  kind: 'local-profile' as const,
  profileKey: 'a'.repeat(64),
};
export const platePlanObservationContext = {
  at: 100,
  principal: platePlanObservationPrincipal,
  authority: platePlanObservationPrincipal,
};
export function platePlanObservationTarget(state: InventoryState) {
  return {
    projectId: 'project',
    inventoryId: 'inventory',
    present: state.revision !== 0,
    revision: state.revision,
  };
}
export function applyPlatePlanObservationFixtureCommands(
  state: InventoryState,
  commands: readonly InventoryCommand[],
  at = 100
) {
  const applied = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    { ...platePlanObservationContext, at }
  );
  if (!applied.ok) throw new Error(`${applied.code}: ${applied.message}`);
  return applied.state;
}
export function inventoryPlatePlanObservationFixture(
  quantity = '8',
  kind: 'notebook-page' | 'protocol-run' = 'notebook-page'
) {
  const definition: InventoryPlatePlanDefinition = {
    schema: 'dnaforge.inventory-plate-plan-definition.v1',
    title: 'Whole manual aliquot plan µL',
    layout: { kind: 'fixed-well', rows: 2, columns: 3 },
    sourceSlots: [
      { key: 'sample', label: 'Sample' },
      { key: 'control', label: 'Control' },
    ],
    transfers: [
      {
        actionId: 'z-first',
        sourceSlotKey: 'sample',
        destinationPosition: 'A3',
        quantity: { value: '4', unit: 'uL' },
        label: 'Sample aliquot',
      },
      {
        actionId: 'a-second',
        sourceSlotKey: 'control',
        destinationPosition: 'B1',
        quantity: { value: '4', unit: 'uL' },
        label: 'Control aliquot',
      },
    ],
  };
  const initial = createInventoryState(),
    choices = {
      identity: { namespace: 'plans', planId: 'family' },
      definition,
      reason: 'Reusable instructions',
    };
  const preview = inventoryPlatePlanVersionPreview(initial, {
    ...choices,
    target: platePlanObservationTarget(initial),
    asOf: 100,
    principal: platePlanObservationPrincipal,
    authority: platePlanObservationPrincipal,
  });
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const saved = applyInventoryPlatePlanVersion(
    initial,
    {
      ...choices,
      target: platePlanObservationTarget(initial),
      expectedPlanDigest: preview.planDigest,
    },
    platePlanObservationContext
  );
  if (!saved.ok) throw new Error(saved.message);
  const state = applyPlatePlanObservationFixtureCommands(saved.state, [
    {
      kind: 'create-layout-storage',
      id: 'plate',
      name: 'Original plate',
      layout: definition.layout,
      placement: { kind: 'root' },
    },
    { kind: 'create-vessel', id: 'vial', name: 'Original vial', placement: { kind: 'unplaced' } },
    {
      kind: 'receive-stock',
      id: 'stock',
      vesselId: 'vial',
      materialId: 'material',
      quantity: { kind: 'known', value: quantity, unit: 'uL' },
      quality: 'usable',
    },
  ]);
  const notebook: InventoryNotebookSavedSource = {
    schema: 'dnaforge.notebook-saved-source.v1',
    projectId: 'project',
    workspaceScope: 'project',
    pageId: 'project::page',
    fileObjectUuid: 'page-file',
    title: 'Saved experiment',
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Completed the whole plan.' }] },
      ],
    },
  };
  const run: InventoryProtocolRunSavedSource = {
    schema: 'dnaforge.protocol-run-saved-source.v1',
    projectId: 'project',
    workspaceScope: 'project',
    runId: 'project::run',
    fileObjectUuid: 'run-file',
    title: 'Saved Run',
    originalText: JSON.stringify({
      schema: 'dnaforge.protocol-run.v1',
      kind: 'protocol_run',
      id: 'run',
      title: 'Saved Run',
      status: 'in_progress',
      immutable: false,
      protocol: {
        sourceId: 'protocol',
        destinationId: 'project::protocol',
        name: 'Protocol',
        pinnedVersionId: 'source-v1',
        pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      },
      inputs: [],
      outputs: [],
      measurements: [],
      tables: [],
      links: [],
      startedAt: null,
      completedAt: null,
      amendments: [],
      provenance: { provider: 'dnaforge', immutableSource: false },
    }),
  };
  const source: InventoryScientificContextSource = kind === 'notebook-page' ? notebook : run;
  const input: InventoryPlatePlanObservationPreviewInput = {
    identity: { namespace: 'manual-reports', observationId: 'occurrence-one' },
    context:
      kind === 'notebook-page'
        ? { kind, entityId: notebook.pageId, sourceSha256: inventoryNotebookSourceSha256(notebook) }
        : { kind, entityId: run.runId, sourceSha256: inventoryProtocolRunSourceSha256(run) },
    binding: {
      versionId: preview.version.id,
      definitionSha256: preview.version.definitionSha256,
      destinationPlateId: 'plate',
      sources: [
        { sourceSlotKey: 'control', stockId: 'stock' },
        { sourceSlotKey: 'sample', stockId: 'stock' },
      ],
    },
    reason: 'Operator reports all instructions completed',
    target: platePlanObservationTarget(state),
    source,
    asOf: 100,
    principal: platePlanObservationPrincipal,
    authority: platePlanObservationPrincipal,
  };
  return { state, input, source, version: preview.version, context: platePlanObservationContext };
}

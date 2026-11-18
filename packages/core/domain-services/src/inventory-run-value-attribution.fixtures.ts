import {
  inventoryPlatePlanObservationFixture,
  platePlanObservationTarget,
} from './inventory-plate-plan-observation.fixtures';
import {
  applyInventoryPlatePlanObservation,
  inventoryPlatePlanObservationPreview,
} from './inventory-plate-plan-observations';
import { inventoryRunValueAttributionSelection } from './inventory-run-value-attribution-source';
import { protocolExecutionDefinition, protocolSavedSourceSha256 } from './protocol-package';
import { inventoryTableSha256 } from './inventory-table-binding';
import type { InventoryProtocolRunSavedSource } from './inventory-scientific-types';
import type { InventoryRunValueAttributionPreviewInput } from './inventory-run-value-attribution-types';

export function inventoryRunValueAttributionFixture(value = 0) {
  const fixture = inventoryPlatePlanObservationFixture('16', 'protocol-run'),
    preview = inventoryPlatePlanObservationPreview(fixture.state, fixture.input);
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const applied = applyInventoryPlatePlanObservation(
    fixture.state,
    { ...fixture.input, expectedPlanDigest: preview.planDigest },
    fixture.context
  );
  if (!applied.ok) throw new Error(applied.message);
  const protocolText = JSON.stringify({
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'protocol',
    title: 'Protocol',
    editable: true,
    overview: { type: 'doc', content: [] },
    steps: [
      {
        id: 'step',
        sourceStepId: 'step',
        ordinal: 1,
        title: 'Step',
        content: { type: 'doc', content: [] },
      },
    ],
    inputs: [
      {
        key: 'sample',
        label: 'Sample',
        required: true,
        description: null,
        valueType: { kind: 'text' },
      },
      {
        key: 'unrecorded',
        label: 'Missing',
        required: true,
        description: null,
        valueType: { kind: 'text' },
      },
    ],
    outputs: [
      {
        key: 'result',
        label: 'Result',
        required: false,
        description: null,
        valueType: { kind: 'number' },
      },
    ],
    links: [],
    version: {
      sourceVersionId: 'local-v1',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      immutable: true,
      importedAt: '2026-01-01T00:00:00.000Z',
    },
    provenance: { provider: 'dnaforge' },
  });
  const definition = protocolExecutionDefinition(protocolText),
    protocolSource = {
      schema: 'dnaforge.protocol-saved-source.v1' as const,
      projectId: 'project',
      workspaceScope: 'project',
      protocolId: 'project::protocol',
      fileObjectUuid: 'protocol-file',
      title: 'Protocol',
      originalText: protocolText,
    };
  const frozenProtocol = {
    schema: 'dnaforge.protocol-execution-snapshot.v1',
    source: {
      kind: 'native-observed-saved-source',
      projectId: 'project',
      workspaceScope: 'project',
      protocolId: 'project::protocol',
      fileObjectUuid: 'protocol-file',
      sourceSha256: protocolSavedSourceSha256(protocolSource),
      fileSha256: inventoryTableSha256(protocolText),
      originalText: protocolText,
    },
    definitionSha256: definition.definitionSha256,
    declaredVersion: definition.declaredVersion,
    paperAcceptedVersion: null,
  };
  const source: InventoryProtocolRunSavedSource = {
    schema: 'dnaforge.protocol-run-saved-source.v1',
    projectId: 'project',
    workspaceScope: 'project',
    runId: 'project::values-run',
    fileObjectUuid: 'values-file',
    title: 'Values Run',
    originalText: JSON.stringify({
      schema: 'dnaforge.protocol-run.v1',
      kind: 'protocol_run',
      id: 'values-run',
      title: 'Values Run',
      status: 'in_progress',
      immutable: false,
      protocol: {
        sourceId: 'protocol',
        destinationId: 'project::protocol',
        name: 'Protocol',
        pinnedVersionId: `saved-${definition.definitionSha256.slice(7)}`,
        pinnedVersionHash: definition.definitionSha256,
      },
      frozenProtocol,
      inputs: [{ key: 'sample', label: 'Sample', value: { type: 'text', value: '' } }],
      outputs: [
        {
          key: 'result',
          label: 'Result',
          value: { type: 'number', value, opaque: ['retained', 0, false] },
          rowExtra: { materialId: 'opaque-not-a-material-reference' },
        },
      ],
      measurements: [
        {
          key: 'accepted',
          label: 'Accepted',
          value: { type: 'boolean', value: false },
          recordedAt: '2026-01-01T00:00:00.000Z',
        },
        { key: 'date', label: 'Date', value: { type: 'date', value: '2026-01-01T00:00:00.000Z' } },
        {
          key: 'unsupported',
          label: 'Quantity',
          value: {
            type: 'quantity',
            lexical: '4 mystery',
            value: null,
            unit: 'mystery',
            unitCompatibility: 'unrecognized',
          },
        },
      ],
      tables: [],
      links: [],
      startedAt: null,
      completedAt: null,
      amendments: [],
      provenance: { provider: 'dnaforge' },
      opaqueRoot: true,
    }),
  };
  const selected = inventoryRunValueAttributionSelection(source, {
      collection: 'outputs',
      key: 'result',
    }),
    observation = preview.observation;
  const input: InventoryRunValueAttributionPreviewInput = {
    identity: { namespace: 'run-value-tests', attributionId: 'base' },
    runValue: selected.runValue,
    physical: {
      observationId: observation.id,
      observationIntentSha256: observation.intentSha256,
      subject: {
        kind: 'output-action',
        actionId: observation.actions[0].actionId,
        stockId: observation.effects.destinations[0].after.id,
      },
    },
    predecessor: null,
    reason: 'Saved value describes this physical subject',
    target: platePlanObservationTarget(applied.state),
    source,
    ...fixture.context,
    asOf: fixture.context.at,
  };
  return { state: applied.state, source, input, observation, context: fixture.context };
}
export function inventoryRunValueSourceWithResult(
  source: InventoryProtocolRunSavedSource,
  value: unknown
): InventoryProtocolRunSavedSource {
  const raw = JSON.parse(source.originalText);
  raw.outputs[0].value.value = value;
  return { ...source, originalText: JSON.stringify(raw) };
}

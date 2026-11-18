import {
  inventoryPlatePlanObservationFixture,
  platePlanObservationTarget,
} from './inventory-plate-plan-observation.fixtures';
import { inventoryWellId } from './inventory-layout';
import {
  inventoryScientificProductionPreview,
  applyInventoryScientificProduction,
} from './inventory-scientific-productions';
import type { InventoryProtocolRunSavedSource } from './inventory-scientific-types';
import type {
  InventoryScientificProductionPreviewInput,
  VerifiedAcceptedDnaProductionBinding,
} from './inventory-scientific-production-types';

export function inventoryScientificProductionFixture(quantity = '8') {
  const fixture = inventoryPlatePlanObservationFixture(quantity, 'protocol-run');
  const source = fixture.source as InventoryProtocolRunSavedSource;
  const design: VerifiedAcceptedDnaProductionBinding = {
    kind: 'accepted-dna-design',
    owner: {
      projectId: 'project',
      workspaceScope: 'project',
      scientificWorkspaceId: 'scientific-project',
    },
    selection: {
      scientificWorkspaceId: 'scientific-project',
      revision: {
        kind: 'accepted-object',
        resourceId: 'designed-dna',
        resourceRevisionId: `rr_${'a'.repeat(64)}`,
        workspaceVersionId: `wv_${'b'.repeat(64)}`,
        contentSha256: 'c'.repeat(64),
      },
    },
    document: {
      name: 'Accepted DNA',
      molecule: 'DNA',
      length: 24,
      topology: 'linear',
      scientificSha256: `sha256:${'d'.repeat(64)}`,
    },
  };
  const input: InventoryScientificProductionPreviewInput = {
    identity: { namespace: 'manual-productions', productionId: 'occurrence-one' },
    context: {
      kind: 'protocol-run',
      entityId: source.runId,
      sourceSha256: fixture.input.context.sourceSha256,
    },
    design: design.selection,
    inputs: [{ stockId: 'stock', quantity: { value: '8', unit: 'uL' } }],
    output: {
      vesselId: inventoryWellId('plate', 'A1'),
      quantity: { value: '5', unit: 'uL' },
      lotName: '  Measured product batch  ',
    },
    method: 'Completed manual preparation',
    reason: 'Operator reports measured output',
    target: platePlanObservationTarget(fixture.state),
    source,
    designBinding: design,
    asOf: 100,
    principal: fixture.context.principal,
    authority: fixture.context.authority,
  };
  return { state: fixture.state, input, source, design, context: fixture.context };
}
export function recordedScientificProductionFixture(quantity = '8') {
  const fixture = inventoryScientificProductionFixture(quantity);
  const preview = inventoryScientificProductionPreview(fixture.state, fixture.input);
  if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
  const result = applyInventoryScientificProduction(
    fixture.state,
    { ...fixture.input, expectedPlanDigest: preview.planDigest },
    fixture.context
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return { ...fixture, preview, recorded: result.state, production: preview.production };
}

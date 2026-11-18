import { describe, expect, it } from 'vitest';
import { inventoryWellId } from './inventory-layout';
import { unknownInventoryGeometry } from './inventory-geometry';
import {
  applyPlatePlanObservationFixtureCommands,
  inventoryPlatePlanObservationFixture,
  platePlanObservationTarget,
} from './inventory-plate-plan-observation.fixtures';
import { inventoryPlatePlanObservationPreview } from './inventory-plate-plan-observations';
import { inventoryScientificProductionFixture } from './inventory-scientific-production.fixtures';
import { inventoryScientificProductionPreview } from './inventory-scientific-productions';
import { inventoryScientificTransferPreviewV2 } from './inventory-scientific';

describe('inventory plan compatibility', () => {
  it.each([
    [
      'notebook-page',
      'sha256:8de2b9794b17e5c4e9a837025941dbadd7521836970a035278dbfad356a83c41',
      'sha256:dbf33abbfa437878094a825475ff7b61eb17e733591a739d61158f539b748e73',
    ],
    [
      'protocol-run',
      'sha256:f9d19c811d665d7edfa9e65f198d350c796437fc044a8a74e9d483953b5e5ca8',
      'sha256:275655cd5448b7eeb718eb137fe8bf7a725ed087fc8d26a168508e1fc999aa30',
    ],
  ] as const)('preserves the accepted %s transfer plan', (kind, planDigest, intentSha256) => {
    const fixture = inventoryPlatePlanObservationFixture('16', kind);
    const preview = inventoryScientificTransferPreviewV2(fixture.state, {
      identity: { namespace: 'frozen-plan-vectors', workId: 'one' },
      context: fixture.input.context,
      sourceStockId: 'stock',
      destinationVesselId: inventoryWellId('plate', 'A1'),
      quantity: { value: '2', unit: 'uL' },
      reason: 'Completed manual transfer',
      target: fixture.input.target,
      source: fixture.source,
      asOf: 100,
      principal: fixture.context.principal,
      authority: fixture.context.authority,
    });
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
    expect(preview.planDigest).toBe(planDigest);
    expect(preview.intentSha256).toBe(intentSha256);
  });

  it('preserves the accepted whole-plate observation plan', () => {
    const fixture = inventoryPlatePlanObservationFixture('16');
    const preview = inventoryPlatePlanObservationPreview(fixture.state, fixture.input);
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
    expect(preview.planDigest).toBe(
      'sha256:96112072457b67f15e979551dabc36cb03cb6e093010a4141610e804eb9ce31f'
    );
    expect(preview.intentSha256).toBe(
      'sha256:3bdfd9a607c2478c3609ce264b29ec4641d39df07d24014bb8d5de1be096c96c'
    );
  });

  it('preserves the accepted production plan', () => {
    const fixture = inventoryScientificProductionFixture('16');
    const preview = inventoryScientificProductionPreview(fixture.state, fixture.input);
    expect(preview.kind).toBe('ready');
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
    expect(preview.planDigest).toBe(
      'sha256:11831adfb474c1908ecae102181fa44b291ee3100816709fc40ab6ff5dbb06d8'
    );
    expect(preview.intentSha256).toBe(
      'sha256:243e9720e0c35da0e2dc0e92b03d98a4432446f11df36cbff873c94d20c4b3a0'
    );
  });

  it('continues to bind custom metadata whose key matches the new stock field', () => {
    const fixture = inventoryScientificProductionFixture('16');
    const vesselId = fixture.input.output.vesselId;
    const vessel = fixture.state.vessels[vesselId];
    const configured = applyPlatePlanObservationFixtureCommands(fixture.state, [
      {
        kind: 'define-physical-type',
        id: 'metadata-type-v1',
        typeId: 'metadata-type',
        name: 'Configured well',
        description: '',
        fields: [
          { key: 'incidentReviewRootIds', label: 'Custom references', type: 'string_array' },
        ],
        sources: [],
        definition: {
          kind: 'vessel',
          mobility: 'fixed-well',
          limits: vessel.limits,
          geometry: unknownInventoryGeometry(),
        },
      },
      {
        kind: 'configure-item',
        item: { kind: 'vessel', id: vesselId },
        typeVersionId: 'metadata-type-v1',
        metadata: {},
        orientation: vessel.configuration.orientation,
        unavailablePositions: vessel.configuration.unavailablePositions,
        reason: 'Declare custom metadata',
      },
    ]);
    const configuredVessel = configured.vessels[vesselId];
    const state = {
      ...configured,
      vessels: {
        ...configured.vessels,
        [vesselId]: {
          ...configuredVessel,
          configuration: {
            ...configuredVessel.configuration,
            metadata: { incidentReviewRootIds: [] },
          },
        },
      },
    };
    const input = { ...fixture.input, target: platePlanObservationTarget(configured) };
    const original = inventoryScientificProductionPreview(configured, input);
    const changed = inventoryScientificProductionPreview(state, input);
    expect(original.kind).toBe('ready');
    expect(changed.kind, JSON.stringify(changed)).toBe('ready');
    if (original.kind !== 'ready' || changed.kind !== 'ready')
      throw new Error(JSON.stringify({ original, changed }));
    expect(changed.planDigest).not.toBe(original.planDigest);
    expect(state.vessels[vesselId].configuration.metadata.incidentReviewRootIds).toEqual([]);
  });
});

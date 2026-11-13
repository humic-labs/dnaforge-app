import { expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { structureInspectionId } from '../structure-drawer/public/structure-inspection';
import { applyVariantProteinMeasurement } from './apply-variant-measurement';
const calls = vi.hoisted(() => ({
  apply: vi.fn(async (..._args: unknown[]) => ({ mappedResidues: [1], unmappedResidues: [] })),
}));
vi.mock('./variant-analysis', () => ({ loadVariantAnalysis: async () => ({ documentId: 'dna' }) }));
vi.mock('./variant-protein-measurement', () => ({
  buildVariantProteinMeasurement: () => ({ id: 'measurement' }),
}));
vi.mock('../structure-drawer/public/apply-inspection-measurement', () => ({
  applyInspectionMeasurement: calls.apply,
}));
it('targets the current inspection view instead of a retained reference with the same tab owner', async () => {
  useStructure3dStore.setState({ expandedStructures: {} });
  const prior = {
    source: 'file' as const,
    sourceId: 'old reference',
    structureLinkOwnerId: 'protein\u0000tab',
    structureViewIdentity: { schemaVersion: 1 as const, structureViewId: 'old', bindingId: null },
  };
  const current = {
    ...prior,
    sourceId: 'current comparison',
    structureViewIdentity: { ...prior.structureViewIdentity, structureViewId: 'current' },
  };
  useStructure3dStore.getState().registerStructure('old', prior, 'Old');
  useStructure3dStore.getState().registerStructure('current', current, 'Current');
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        activeTabId: 'tab',
        tabs: [
          {
            id: 'tab',
            type: 'structure',
            entityId: structureInspectionId('dna'),
            label: 'Comparison',
            structureInspection: {
              request: { entityId: 'dna', translation: 'MAG' },
              viewSettings: { candidateId: 'comparison', structureViewId: 'current' },
            },
          },
        ],
      },
    },
  });
  await applyVariantProteinMeasurement({
    analysisId: 'analysis',
    name: 'Signal',
    filter: 'all',
    effect: 'all',
    sequence: { sequence: 'ATGGCGGGC' } as any,
  });
  expect(calls.apply).toHaveBeenCalledWith(
    expect.objectContaining({ sourceId: 'current comparison' }),
    'main',
    { id: 'measurement' }
  );
});

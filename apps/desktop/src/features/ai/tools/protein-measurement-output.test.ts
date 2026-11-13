import { describe, expect, it, vi } from 'vitest';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { execTool } from './test-helpers';
import { createProteinMeasurementTool } from './protein-measurement';
import { createColorVariantProteinTool } from './sequence-variant-analysis';
import {
  proteinMeasurementOutputSchema,
  colorVariantProteinOutputSchema,
} from './protein-output-schemas';

const native = vi.hoisted(() => ({ apply: vi.fn(), variant: vi.fn() }));
vi.mock('../../structure-drawer/apply-inspection-measurement', () => ({
  applyInspectionMeasurement: native.apply,
}));
vi.mock('../../alignment-manager/variant-protein-measurement', async (original) => ({
  ...(await original<typeof import('../../alignment-manager/variant-protein-measurement')>()),
  applyVariantProteinMeasurement: native.variant,
}));
vi.mock('../../alignment-manager/variant-analysis', () => ({
  loadVariantAnalysis: async () => ({ documentId: 'document1' }),
}));
vi.mock('./path-utils', () => ({
  loadSequenceDocumentBiologyFile: async () => ({ biology: { sequence: { sequence: 'ATGGCC' } } }),
}));
vi.mock('../../sequence/store', () => ({
  useSequenceStore: { getState: () => ({ getSequence: () => null }) },
}));
vi.mock('../../page/embeds/structure3d/store', () => ({
  useStructure3dStore: { getState: () => ({ expandedStructures: { view1: { data: {} } } }) },
}));
vi.mock('../../canvas/store', () => ({
  useCanvasStore: {
    subscribe: () => () => {},
    getState: () => ({
      panels: {
        main: {
          id: 'main',
          activeTabId: 'tab1',
          tabs: [
            {
              id: 'tab1',
              type: 'structure',
              initialStructureAttrs: { structureViewIdentity: { structureViewId: 'view1' } },
            },
          ],
        },
      },
    }),
  },
}));

const measurement = {
  id: 'signal1',
  name: 'Supplied signal',
  proteinSequenceSha256: 'a'.repeat(64),
  source: { label: 'Synthetic values', analysisId: 'analysis1', revision: 'rev1' },
  units: 'fraction',
  values: [
    { residue: 1, value: 0.5 },
    { residue: 2, value: null },
  ],
  scale: {
    transform: 'linear',
    domain: [0, 1],
    colors: ['#000000', '#ffffff'],
    missingColor: '#999999',
  },
  variantEvidence: { aggregation: 'maximum' },
};
describe('canonical protein measurement output contracts', () => {
  it('reports exact mapped and unmapped residue identities for supplied measurements', async () => {
    native.apply.mockResolvedValueOnce({ mappedResidues: [1], unmappedResidues: [2] });
    const result = await execTool(createProteinMeasurementTool(), {
      structureViewId: 'view1',
      measurement,
    });
    assertMcpOutput(proteinMeasurementOutputSchema, result);
    expect(result).toMatchObject({ ok: true, mappedResidues: [1], unmappedResidues: [2] });
  });
  it('retains the derived values, scale, aggregation and exclusions from saved-variant rendering', async () => {
    native.variant.mockResolvedValueOnce({
      measurement: {
        ...measurement,
        variantEvidence: { aggregation: 'maximum', excluded: [{ reason: 'filtered' }] },
      },
      mappedResidues: [1],
      unmappedResidues: [2],
    });
    const result = await execTool(createColorVariantProteinTool([]), { analysisId: 'analysis1' });
    assertMcpOutput(colorVariantProteinOutputSchema, result);
    expect(result).toMatchObject({
      ok: true,
      aggregation: 'maximum',
      excludedCallCount: 1,
      unknownResidueCount: 1,
    });
  });
});

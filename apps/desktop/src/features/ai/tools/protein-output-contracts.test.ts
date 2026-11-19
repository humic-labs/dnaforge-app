import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { useCanvasStore } from '../../canvas/public/store';
import { execTool } from './test-helpers';
import { createMolecularStructuresTool } from './molecular-structures';
import { createProteinStructureComparisonTool } from './protein-structure-comparison';
import { createProteinGetContextTool } from './protein-context';
import {
  molecularStructuresOutputSchema,
  proteinStructureComparisonOutputSchema,
  proteinContextOutputSchema,
} from './protein-output-schemas';

const operations = vi.hoisted(() => ({
  list: vi.fn(),
  register: vi.fn(),
  load: vi.fn(),
  open: vi.fn(),
  attach: vi.fn(),
  saved: vi.fn(),
  discover: vi.fn(),
  inspectionPredictions: vi.fn(),
  predictionOpen: vi.fn(),
  reuse: vi.fn(),
  attachSaved: vi.fn(),
  compare: vi.fn(),
  context: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({ molecularCatalog: { list: operations.list } }),
}));
vi.mock('../../compute/molecular-catalog', () => ({
  registerCatalogStructure: operations.register,
  loadCatalogStructure: operations.load,
  openCatalogStructure: operations.open,
}));
vi.mock('../../structure-drawer/inspection-catalog', () => ({
  attachCatalogToInspection: operations.attach,
}));
vi.mock('../../../db/entity-references', () => ({ listSavedMolecularViews: operations.saved }));
vi.mock('../../../stores/workspaceStore', () => ({ getCurrentWorkspaceScope: () => null }));
vi.mock('../../structure-drawer/inspection-comparison', () => ({
  attachSavedInspectionStructure: operations.attachSaved,
  compareInspectionProteins: operations.compare,
}));
vi.mock('../../structure-drawer/inspection-prediction', () => ({
  listInspectionPredictions: operations.inspectionPredictions,
  reuseInspectionPrediction: operations.reuse,
}));
vi.mock('../../compute/public/prediction-library', () => ({
  discoverProteinPredictions: operations.discover,
}));
vi.mock('../../compute/prediction-result-view', () => ({
  openProteinPrediction: operations.predictionOpen,
}));
vi.mock('@waypoint/api-client', () => ({
  isApiError: () => false,
  postFetchExternalFetchPost: operations.context,
}));
vi.mock('../../../services/sidecar-session', () => ({
  createRendererSidecarApiClient: vi.fn(() => ({ options: (options: RequestInit = {}) => options })),
  resolveExternalLookupBaseUrl: vi.fn(async () => 'http://sidecar.test'),
}));

const observationId = 'a'.repeat(64);
const observation = {
  id: observationId,
  coordinateId: 'coordinates1',
  coordinateSha256: 'b'.repeat(64),
  format: 'cif',
  byteCount: 12,
  label: 'Synthetic structure',
  sourceKind: 'import',
  origin: { workspaceRoot: '/workspace', filePath: '/workspace/synthetic.cif' },
  run: null,
  metrics: { score: 1 },
  provenance: { source: 'fixture' },
  createdAt: 1,
};
const chain = {
  key: 'A:1',
  blockIndex: 0,
  modelIndex: 0,
  modelNumber: 1,
  labelAsymId: 'A',
  authAsymId: 'A',
  entityId: '1',
  kind: 'protein',
  sequenceEvidence: 'declared',
  sequence: 'MAG',
  sequencePositions: [1, 2, 3],
  declaredComponents: ['MET', 'ALA', 'GLY'],
  unresolved: [],
  observedResidues: [
    {
      labelSequenceId: 1,
      authorSequenceId: 1,
      insertionCode: '',
      componentIds: ['MET'],
      encodedCode: 'M',
      atomCount: 4,
    },
  ],
};
const match = {
  observation,
  chains: [
    {
      key: chain.key,
      blockIndex: chain.blockIndex,
      modelIndex: chain.modelIndex,
      modelNumber: chain.modelNumber,
      labelAsymId: chain.labelAsymId,
      authAsymId: chain.authAsymId,
      entityId: chain.entityId,
      kind: chain.kind,
      sequenceEvidence: chain.sequenceEvidence,
      sequenceLength: 3,
      observedResidueCount: 1,
      unresolvedCount: 0,
      relationship: 'partial',
      mappedCount: 1,
      matchCount: 1,
      mismatchCount: 0,
    },
  ],
};
const mapping = {
  molecule: { kind: 'protein', sequence: 'MAG' },
  chainKey: 'A:1',
  relationship: 'partial',
  status: 'mapped',
  method: 'author-numbering',
  residues: [{ sequencePosition: 1, observedResidueIndex: 0 }],
  sequenceLength: 3,
  mappedCount: 1,
  matchCount: 1,
  mismatchCount: 0,
};
const presented = {
  status: 'presented',
  tabId: 'tab1',
  panelId: 'main',
  tabType: 'structure',
  disposition: 'created',
  content: 'loading',
};

beforeEach(() => {
  for (const operation of Object.values(operations)) operation.mockReset();
  useCanvasStore.setState(useCanvasStore.getInitialState());
});
describe('protein and molecular catalog canonical output contracts', () => {
  it('validates register, empty discovery, mapping, attachment and native-open catalog replies', async () => {
    const tool = createMolecularStructuresTool();
    operations.register.mockResolvedValue(match);
    assertMcpOutput(
      molecularStructuresOutputSchema,
      await execTool(tool, {
        operation: 'register',
        workspaceRoot: '/workspace',
        filePath: '/workspace/synthetic.cif',
        source: { kind: 'import' },
      })
    );
    operations.list.mockResolvedValue([]);
    const empty = await execTool(tool, { operation: 'list', limit: 50 });
    assertMcpOutput(molecularStructuresOutputSchema, empty);
    expect(empty).toEqual({ ok: true, matches: [] });
    operations.load.mockResolvedValue({
      observation,
      inventory: { chains: [chain] },
      mappings: [mapping],
    });
    assertMcpOutput(
      molecularStructuresOutputSchema,
      await execTool(tool, { operation: 'mapping', observationId, chainKey: 'A:1' })
    );
    operations.attach.mockResolvedValue(undefined);
    assertMcpOutput(
      molecularStructuresOutputSchema,
      await execTool(tool, {
        operation: 'open',
        observationId,
        chainKey: 'A:1',
        documentId: 'document1',
      })
    );
    const entityId = `catalog-view:${observationId}:${chain.key}`;
    operations.open.mockImplementationOnce(async () => {
      const canvas = useCanvasStore.getState();
      const tabId = canvas.openTab(presented.panelId, {
        type: 'structure',
        entityId,
        label: observation.label,
        initialStructureAttrs: {
          source: 'file',
          sourceId: `catalog:${observationId}`,
          catalogSource: { observationId, chainKey: chain.key },
        },
      });
      return { ...presented, tabId };
    });
    const opened = await execTool(tool, { operation: 'open', observationId, chainKey: chain.key });
    assertMcpOutput(molecularStructuresOutputSchema, opened);
    const { activeTabId } = useCanvasStore.getState().panels[presented.panelId];
    expect(opened).toMatchObject({
      ok: true,
      observationId,
      chainKey: chain.key,
      opened: {
        content: 'loading',
        tabId: activeTabId,
        viewHandle: `structure-tab:${activeTabId}`,
        structureViewId: entityId,
        label: observation.label,
        viewerStatus: 'loading',
      },
    });
  });

  it('validates every comparison-management response shape without submitting provider compute', async () => {
    const tool = createProteinStructureComparisonTool();
    operations.discover.mockResolvedValue({
      predictions: [
        {
          kind: 'protein-prediction-result',
          version: 1,
          run: {
            jobRecordId: 'job1',
            provider: 'fixture',
            remoteId: 'run1',
            toolId: 'prediction',
            label: null,
            createdAt: '2026-10-15',
            settingsHash: 'settings1',
          },
          origin: { workspaceRoot: '/workspace', filePath: '/workspace/prediction.cif' },
          chainCount: 1,
          metrics: { score: 1 },
          provenance: { source: 'fixture' },
          id: 'prediction1',
          chainId: 'A',
          proteinLength: 3,
        },
      ],
      notices: [],
      runs: [],
    });
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, { action: 'list-predictions', proteinSequence: 'MAG' })
    );
    operations.inspectionPredictions.mockResolvedValue({
      status: 'protein-required',
      documentId: 'document1',
      message: 'Choose a protein',
    });
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, { action: 'list-predictions', documentId: 'document1' })
    );
    operations.saved.mockResolvedValue([{ id: 'saved1', display_label: 'View', created_at: 1 }]);
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, { action: 'list-saved' })
    );
    operations.predictionOpen.mockResolvedValue(presented);
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, {
        action: 'open-prediction',
        proteinSequence: 'MAG',
        referenceId: 'prediction1',
        chainId: 'A',
      })
    );
    operations.reuse.mockResolvedValue({
      referenceId: 'prediction1',
      chainId: 'A',
      proteinKey: 'MAG',
      jobRecordId: 'job1',
    });
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, {
        action: 'reuse-prediction',
        documentId: 'document1',
        referenceId: 'prediction1',
        chainId: 'A',
      })
    );
    operations.attachSaved.mockResolvedValue({ referenceId: 'saved1', proteinKey: 'MAG' });
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, { action: 'attach', documentId: 'document1', referenceId: 'saved1' })
    );
    operations.compare.mockResolvedValue({
      referenceId: 'saved1',
      alternateId: 'saved2',
      referenceSha256: 'a'.repeat(64),
      alternateSha256: 'b'.repeat(64),
    });
    assertMcpOutput(
      proteinStructureComparisonOutputSchema,
      await execTool(tool, { action: 'compare', documentId: 'document1' })
    );
  });

  it('retains provider scientific metadata within the typed external-fetch receipt', async () => {
    operations.context.mockResolvedValue({
      data: {
        agent_artifact_id: null,
        attribution: null,
        binding_id: null,
        cache_hit: false,
        external_id: 'P00698',
        external_resource_id: 'resource1',
        license: null,
        metadata: { features: [{ type: 'binding site', position: 12 }] },
        provider: 'uniprot-mcp',
        xref_count: 0,
      },
    });
    const result = await execTool(createProteinGetContextTool(), {
      source: 'uniprot-mcp',
      operation: 'annotations',
      uniprotId: 'P00698',
    });
    assertMcpOutput(proteinContextOutputSchema, result);
    expect(result).toMatchObject({ ok: true, metadata: { features: [{ position: 12 }] } });
  });

  it('rejects malformed nested mapping and run metadata using the real MCP client validator', () => {
    expect(() =>
      assertMcpOutput(molecularStructuresOutputSchema, {
        ok: true,
        observation,
        chain,
        mappings: [{ ...mapping, residues: [{ sequencePosition: '1', observedResidueIndex: 0 }] }],
      })
    ).toThrow('MCP output contract rejected');
    expect(() =>
      assertMcpOutput(proteinStructureComparisonOutputSchema, {
        ok: true,
        predictions: [{ run: { provider: 'fixture' } }],
        notices: [],
        runs: [],
      })
    ).toThrow('MCP output contract rejected');
  });
});

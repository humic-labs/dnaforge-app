import { execDesignContract } from '../../test-utils/design-output-test-helper';
import { previewFinalizeDesignAssemblyOutputSchema } from '../ai/tools/design-output-schemas';
import { createPreviewFinalizeDesignAssemblyTool } from '../ai/tools/accepted-assembly-lifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useDesignStore } from '../design/store';
import { useSequenceStore } from '../sequence/store';
import PUC19_SOURCE from '../../../../../test-fixtures/sequences/circular/pUC19.gb?raw';
import {
  REAL_ASSEMBLY_PIPELINE_DESIGN_ID,
  realAssemblyPipelineAppScenario,
} from '../../test/scenarios/assembly-real-pipeline';

const DESIGN_ID = `${REAL_ASSEMBLY_PIPELINE_DESIGN_ID}:gibson-pcr-pcr`;

const {
  mockFs,
  mockGetCurrentCatalogFileForEntity,
  mockGetCatalogEntity,
  mockResolveSequenceDocument,
  mockReadAcceptedScientificFile,
} = vi.hoisted(() => ({
  mockFs: {
    exists: vi.fn().mockResolvedValue(false),
    readTextFile: vi.fn(),
    readFile: vi.fn(),
    writeTextFile: vi.fn(),
    validateWorkspacePath: vi.fn().mockResolvedValue(true),
  },
  mockGetCurrentCatalogFileForEntity: vi.fn().mockResolvedValue(null),
  mockGetCatalogEntity: vi.fn().mockResolvedValue(null),
  mockResolveSequenceDocument: vi.fn(),
  mockReadAcceptedScientificFile: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: mockFs }),
}));

vi.mock('../lims/operations', () => ({
  getLimsSchemas: vi.fn().mockResolvedValue([
    {
      schemaId: 'schema-entity-plasmid',
      currentRevisionId: 'schema-entity-plasmid-v7',
      entityKind: 'plasmid',
      baseKind: 'sequence',
      displayName: 'Lab plasmid',
      description: 'Current user-defined plasmid schema',
      version: 7,
      builtin: true,
      fields: [{ key: 'purpose', label: 'Purpose', type: 'text' }],
    },
  ]),
}));

vi.mock('../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-catalog')>()),
  getCatalogEntity: mockGetCatalogEntity,
  getCatalogEntityByLocator: vi.fn().mockResolvedValue(null),
  getCatalogEventsForEntity: vi.fn().mockResolvedValue([]),
  findConstructIdForAcceptedAssemblyVersion: vi.fn().mockResolvedValue(null),
  getCatalogEntityForFilePath: vi.fn().mockResolvedValue(null),
  getCurrentCatalogFileForEntity: mockGetCurrentCatalogFileForEntity,
  getCurrentSequenceFileForDocumentId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../sequence/public/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sequence/public/sequence-document-repository')>()),
  resolveSequenceDocumentById: mockResolveSequenceDocument,
}));
vi.mock('../../services/read-accepted-scientific-file', () => ({
  readAcceptedScientificFile: mockReadAcceptedScientificFile,
}));

import { computeChecksum, parseGenBankFull } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import {
  clearFinalizationPreviewsForTests,
  getStoredFinalizationPreview,
  prepareFinalizationCandidate,
  previewFinalizeDesignAssembly,
  resolveBoundAcceptedPackageForDesign,
} from './accepted-finalization-preview';
import { ReplaceProductConfirmationRequired } from './accepted-product-integrity';
import {
  clearAssemblyFinalizationIdempotencyForTests,
  createFinalizeDesignAssemblyTool,
} from '../ai/tools/accepted-assembly-lifecycle';

describe('accepted finalization preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.exists.mockResolvedValue(false);
    mockGetCurrentCatalogFileForEntity.mockResolvedValue(null);
    mockGetCatalogEntity.mockResolvedValue(null);
    mockResolveSequenceDocument.mockRejectedValue(new Error('No managed source in this fixture.'));
    mockReadAcceptedScientificFile.mockResolvedValue(null);
    clearFinalizationPreviewsForTests();
    clearAssemblyFinalizationIdempotencyForTests();
    const scenario = realAssemblyPipelineAppScenario('gibson-pcr-pcr');
    useDesignStore.setState({
      designs: scenario.designs?.designs ?? {},
      activeDesignId: scenario.designs?.activeDesignId ?? null,
    });
    useSequenceStore.setState({ sequences: scenario.sequences ?? {} });
    useWorkspaceStore.setState({
      folders: [{ name: 'workspace', path: '/workspace', addedAt: 1 }],
      activeWorkspaceFile: null,
    });
  });

  it(' resolves an unopened draft from its own project with multiple writable projects', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    useWorkspaceStore.setState({
      folders: [
        { name: 'My Project', path: '/workspace', addedAt: 1 },
        { name: 'Other Project', path: '/other', addedAt: 2 },
      ],
      activeWorkspaceFile: '/other/session.dnaforge',
    });
    mockGetCurrentCatalogFileForEntity.mockImplementation(async (id: string) =>
      id === DESIGN_ID
        ? { path: '/workspace/assemblies/draft.wpdesign.json', file_kind: 'waypoint-design' }
        : null
    );
    const preview = await previewFinalizeDesignAssembly({
      designId: DESIGN_ID,
      expectedDesignVersion: design.version,
    });
    expect(preview.targetProductPath).toMatch(/^\/workspace\//);
    expect(preview.blockers).toEqual([]);
  });

  it(' names the missing bound project instead of suggesting current-project changes', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    mockGetCurrentCatalogFileForEntity.mockImplementation(async (id: string) =>
      id === DESIGN_ID
        ? { path: '/closed/assemblies/draft.wpdesign.json', file_kind: 'waypoint-design' }
        : null
    );
    const result = await execDesignContract(
      previewFinalizeDesignAssemblyOutputSchema,
      createPreviewFinalizeDesignAssemblyTool(),
      { designId: DESIGN_ID, expectedDesignVersion: design.version }
    );
    expect(result).toMatchObject({
      canFinalize: false,
      blockers: [
        {
          code: 'DESIGN_PROJECT_NOT_OPEN',
          message: expect.stringMatching(/design.*project.*open/i),
        },
      ],
    });
  });

  it('allows the first publication of a draft with a reserved construct identity', async () => {
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [DESIGN_ID]: { ...state.designs[DESIGN_ID], constructId: 'reserved-new-construct' },
      },
    }));
    const preview = await previewFinalizeDesignAssembly({
      designId: DESIGN_ID,
      expectedDesignVersion: useDesignStore.getState().designs[DESIGN_ID].version,
    });
    expect(preview.createsNewConstruct).toBe(true);
  });

  it('captures the complete accepted unopened managed source without a resident sequence cache', async () => {
    const sourceId = 'managed-puc19-without-an-open-tab';
    const original = useDesignStore.getState().designs[DESIGN_ID];
    const design = {
      ...original,
      regions: original.regions.map((region) => {
        const next = { ...region, sourceSequenceId: sourceId };
        delete next.sourceSequence;
        delete next.sourceAnnotations;
        return next;
      }),
    };
    useDesignStore.setState({ designs: { [DESIGN_ID]: design } });
    useSequenceStore.setState({ sequences: {} });
    mockResolveSequenceDocument.mockResolvedValue({
      documentId: sourceId,
      sourcePath: '/workspace/imports/pUC19/contents/pUC19.gb',
    });
    mockReadAcceptedScientificFile.mockResolvedValue({
      resourceId: sourceId,
      bytes: new TextEncoder().encode(PUC19_SOURCE),
    });
    mockGetCatalogEntity.mockResolvedValue({ id: sourceId });

    const preview = await previewFinalizeDesignAssembly({
      designId: DESIGN_ID,
      expectedDesignVersion: design.version,
    });
    const checksum = await computeChecksum(parseGenBankFull(PUC19_SOURCE).sequence);
    expect(preview.sources).toHaveLength(design.regions.length);
    expect(preview.sources.every((source) => source.checksum === checksum)).toBe(true);
    expect(preview.sources.every((source) => source.sourceConstructId === sourceId)).toBe(true);
    expect(mockReadAcceptedScientificFile).toHaveBeenCalledWith(
      '/workspace',
      'imports/pUC19/contents/pUC19.gb',
      Number.MAX_SAFE_INTEGER
    );
    expect(mockFs.readFile).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().sequences).toEqual({});
  });

  it('returns a short-lived exact fingerprint without writing or mutating the design', async () => {
    const before = useDesignStore.getState().designs[DESIGN_ID];
    const agentPreview = await execDesignContract(
      previewFinalizeDesignAssemblyOutputSchema,
      createPreviewFinalizeDesignAssemblyTool(),
      { designId: DESIGN_ID, expectedDesignVersion: before.version }
    );
    expect(agentPreview).toMatchObject({ ok: true, canFinalize: true });
    const preview = await previewFinalizeDesignAssembly({
      designId: DESIGN_ID,
      expectedDesignVersion: before.version,
      now: new Date('2026-08-05T18:00:00.000Z'),
    });

    expect(preview).toMatchObject({
      designId: DESIGN_ID,
      expectedDesignVersion: before.version,
      issuedAt: '2026-08-05T18:00:00.000Z',
      expiresAt: '2026-08-05T18:10:00.000Z',
      targetProductPath: '/workspace/assemblies/Real-Gibson-PCR-PCR-accepted.gb',
      blockers: [],
    });
    expect(preview.constructId).toEqual(expect.any(String));
    expect(preview.constructId).not.toBe(DESIGN_ID);
    expect(preview.previewFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preview.canonicalDraftChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(preview.sources).toHaveLength(2);
    const stored = getStoredFinalizationPreview(
      preview.previewFingerprint,
      new Date('2026-08-05T18:05:00.000Z')
    );
    expect(stored.preview).toEqual(preview);
    const candidate = await prepareFinalizationCandidate({
      designId: DESIGN_ID,
      expectedDesignVersion: before.version,
      acceptedAt: '2026-08-05T18:00:00.000Z',
    });
    expect(
      parseSequencePackageDocument(candidate.prepared.files.sidecarJsonContent).entity.schema
    ).toMatchObject({
      schemaRevisionId: 'schema-entity-plasmid-v7',
      displayName: 'Lab plasmid',
      baseKind: 'sequence',
      fields: [{ key: 'purpose', label: 'Purpose', type: 'text' }],
    });
    expect(mockFs.writeTextFile).not.toHaveBeenCalled();
    expect(useDesignStore.getState().designs[DESIGN_ID]).toBe(before);
  });

  it('refuses stale design versions before preparing any artifact', async () => {
    await expect(
      previewFinalizeDesignAssembly({
        designId: DESIGN_ID,
        expectedDesignVersion: 999,
      })
    ).rejects.toThrow(/version is stale/i);
    expect(mockFs.exists).not.toHaveBeenCalled();
    expect(mockFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('expires the approval fingerprint rather than reinterpreting it', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    const preview = await previewFinalizeDesignAssembly({
      designId: design.id,
      expectedDesignVersion: design.version,
      now: new Date('2026-08-05T18:00:00.000Z'),
    });
    expect(() =>
      getStoredFinalizationPreview(preview.previewFingerprint, new Date('2026-08-05T18:10:00.001Z'))
    ).toThrow(/expired/i);
  });

  it('rejects source drift after preview with zero writes', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    const preview = await previewFinalizeDesignAssembly({
      designId: design.id,
      expectedDesignVersion: design.version,
    });
    const sequenceState = useSequenceStore.getState();
    const [sourcePath, source] = Object.entries(sequenceState.sequences)[0];
    useSequenceStore.setState({
      sequences: {
        ...sequenceState.sequences,
        [sourcePath]: { ...source, sequence: `${source.sequence}A`, length: source.length + 1 },
      },
    });

    const tool = createFinalizeDesignAssemblyTool();
    if (!tool.execute) throw new Error('missing finalization executor');
    const result = await tool.execute(
      {
        designId: design.id,
        expectedDesignVersion: design.version,
        previewFingerprint: preview.previewFingerprint,
        idempotencyKey: 'drift-refusal',
      },
      { toolCallId: 'test', messages: [] }
    );

    expect(result).toMatchObject({ status: 'rejected', idempotencyKey: 'drift-refusal' });
    expect(result.error).toMatch(/source bytes.*changed|changed after preview/i);
    expect(mockFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('refuses to silently replace a drifted plasmid product on the same construct', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    const productPath = '/workspace/assemblies/Real-Gibson-PCR-PCR-accepted.gb';
    const acceptedBytes = 'LOCUS accepted\n//\n';
    const driftedBytes = 'LOCUS drifted\n//\n';
    const checksum = await computeChecksum(acceptedBytes);
    mockFs.exists.mockImplementation(
      async (path: string) =>
        path === '/workspace/assemblies/.forge/plasmid.json' || path === productPath
    );
    mockFs.readTextFile.mockImplementation(async (path: string) => {
      if (path.endsWith('plasmid.json')) {
        return serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'construct-existing',
            name: 'pX',
            product: { file: 'Real-Gibson-PCR-PCR-accepted.gb', genBankChecksum: checksum },
            assembly: {
              accepted: { artifacts: { productGenBankChecksum: checksum } },
            },
          })
        );
      }
      return driftedBytes;
    });

    await expect(
      prepareFinalizationCandidate({
        designId: design.id,
        expectedDesignVersion: design.version,
        targetProductPath: productPath,
      })
    ).rejects.toBeInstanceOf(ReplaceProductConfirmationRequired);
  });

  it('refuses silent replace when the picker selected the parent of a minted package', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    const logicalProductPath = '/workspace/assemblies/Real-Gibson-PCR-PCR-accepted.gb';
    const packageRoot = '/workspace/assemblies/Real-Gibson-PCR-PCR-accepted';
    const mintedProductPath = `${packageRoot}/Real-Gibson-PCR-PCR-accepted.gb`;
    const mintedMetaPath = `${packageRoot}/.forge/plasmid.json`;
    const acceptedBytes = 'LOCUS accepted\n//\n';
    const driftedBytes = 'LOCUS drifted\n//\n';
    const checksum = await computeChecksum(acceptedBytes);
    mockFs.exists.mockImplementation(
      async (path: string) => path === mintedMetaPath || path === mintedProductPath
    );
    mockFs.readTextFile.mockImplementation(async (path: string) => {
      if (path === mintedMetaPath) {
        return serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'construct-existing',
            name: 'pX',
            product: { file: 'Real-Gibson-PCR-PCR-accepted.gb', genBankChecksum: checksum },
            assembly: {
              accepted: { artifacts: { productGenBankChecksum: checksum } },
            },
          })
        );
      }
      return driftedBytes;
    });

    await expect(
      prepareFinalizationCandidate({
        designId: design.id,
        expectedDesignVersion: design.version,
        targetProductPath: logicalProductPath,
        overwrite: true,
      })
    ).rejects.toBeInstanceOf(ReplaceProductConfirmationRequired);
  });

  it('reuses the legacy package already bound to the design instead of inventing a second destination', async () => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    const legacyPackageId = '55f6f120-fbf5-4773-9b6b-31ab94aacacd';
    const legacyPackageRoot = '/workspace/puc19-araC-accepted';
    const legacyProductPath = `${legacyPackageRoot}/puc19-araC-accepted.gb`;
    const legacyMetaPath = `${legacyPackageRoot}/.forge/plasmid.json`;
    const proposedProductPath = '/workspace/sequences/puc19-araC-accepted/puc19-araC-accepted.gb';
    const productBytes =
      'LOCUS       puc19-araC-accepted  8 bp    DNA\nORIGIN\n        1 acgtacgt\n//\n';
    const productChecksum = await computeChecksum(productBytes);
    const currentDocument = buildSequencePackageDocument({
      id: legacyPackageId,
      name: 'puc19-araC',
      product: { file: 'puc19-araC-accepted.gb', genBankChecksum: productChecksum },
      assembly: {
        accepted: {
          designId: design.id,
          acceptedAssemblyVersionId: legacyPackageId,
          artifacts: { productGenBankChecksum: productChecksum },
        },
      },
    });
    const { formatVersion: _formatVersion, members: _members, ...legacyDocument } = currentDocument;

    mockGetCurrentCatalogFileForEntity.mockImplementation(async (entityId: string) =>
      entityId === design.id
        ? {
            id: 'catalog-file-legacy',
            entity_id: design.id,
            workspace_id: 1,
            path: legacyPackageRoot,
            relative_path: 'puc19-araC-accepted',
            file_kind: 'waypoint-plasmid',
            status: 'current',
          }
        : null
    );
    mockFs.exists.mockImplementation(
      async (path: string) => path === legacyMetaPath || path === legacyProductPath
    );
    mockFs.readTextFile.mockImplementation(async (path: string) => {
      if (path === legacyMetaPath) {
        return JSON.stringify({ ...legacyDocument, schema: 'waypoint.plasmid.v1' });
      }
      if (path === legacyProductPath) return productBytes;
      throw new Error(`ENOENT: ${path}`);
    });

    const candidate = await prepareFinalizationCandidate({
      designId: design.id,
      expectedDesignVersion: design.version,
      targetProductPath: proposedProductPath,
    });

    expect(candidate.constructId).toBe(legacyPackageId);
    expect(candidate.targetProductPath).toBe(legacyProductPath);
    expect(candidate.prepared.files.packageRoot).toBe(legacyPackageRoot);
    expect(candidate.overwrite).toBe(true);
    expect(mockFs.writeTextFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing marker',
      marker: null,
      productExists: true,
      error: /missing its metadata/i,
    },
    {
      name: 'corrupt marker',
      marker: '{not json',
      productExists: true,
      error: /cannot be opened.*invalid sequence package json/i,
    },
    {
      name: 'future package format',
      marker: JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'sequence',
        formatVersion: 99,
        id: 'legacy-package',
        product: { file: 'legacy.gb' },
      }),
      productExists: true,
      error: /cannot be opened.*newer/i,
    },
    {
      name: 'missing product',
      marker: JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'legacy-package',
        product: { file: 'legacy.gb' },
        assembly: { accepted: { designId: DESIGN_ID } },
      }),
      productExists: false,
      error: /missing its product/i,
    },
    {
      name: 'different accepted design',
      marker: JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'legacy-package',
        product: { file: 'legacy.gb' },
        assembly: { accepted: { designId: 'different-design' } },
      }),
      productExists: true,
      error: /legacy package design mismatch/i,
    },
  ])('fails closed with zero writes for a legacy binding with $name', async (testCase) => {
    const design = useDesignStore.getState().designs[DESIGN_ID];
    const packageRoot = '/workspace/legacy';
    const metaPath = `${packageRoot}/.forge/plasmid.json`;
    const productPath = `${packageRoot}/legacy.gb`;
    mockGetCurrentCatalogFileForEntity.mockImplementation(async (entityId: string) =>
      entityId === design.id
        ? {
            id: 'binding',
            entity_id: design.id,
            workspace_id: 1,
            path: packageRoot,
            relative_path: 'legacy',
            file_kind: 'waypoint-plasmid',
            status: 'current',
          }
        : null
    );
    mockFs.exists.mockImplementation(async (path: string) => {
      if (path === metaPath) return testCase.marker !== null;
      if (path === productPath) return testCase.productExists;
      return false;
    });
    mockFs.readTextFile.mockImplementation(async (path: string) => {
      if (path === metaPath && testCase.marker !== null) return testCase.marker;
      throw new Error(`ENOENT: ${path}`);
    });

    await expect(
      resolveBoundAcceptedPackageForDesign(design, useWorkspaceStore.getState().folders)
    ).rejects.toThrow(testCase.error);
    expect(mockFs.writeTextFile).not.toHaveBeenCalled();
  });

  it('fails closed when current construct and legacy design bindings disagree', async () => {
    const original = useDesignStore.getState().designs[DESIGN_ID];
    const design = { ...original, constructId: 'construct-current' };
    mockGetCurrentCatalogFileForEntity.mockImplementation(async (entityId: string) => {
      if (entityId === design.constructId) {
        return {
          path: '/workspace/current-package',
          file_kind: 'waypoint-sequence',
          status: 'current',
        };
      }
      if (entityId === design.id) {
        return {
          path: '/workspace/legacy-package',
          file_kind: 'waypoint-plasmid',
          status: 'current',
        };
      }
      return null;
    });

    await expect(
      resolveBoundAcceptedPackageForDesign(design, useWorkspaceStore.getState().folders)
    ).rejects.toThrow(/conflicting accepted package bindings/i);
    expect(mockFs.readTextFile).not.toHaveBeenCalled();
    expect(mockFs.writeTextFile).not.toHaveBeenCalled();
  });
});

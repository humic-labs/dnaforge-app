import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { createReferenceOutputSchema } from './genome-output-schemas';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';

const { mockPlatform, mockResolveSequenceDocument, mockLegacyDocument, mockDocument } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      exists: vi.fn(),
      readTextFile: vi.fn(),
      readDir: vi.fn(),
      stat: vi.fn(),
    },
  },
  mockResolveSequenceDocument: vi.fn(),
  mockLegacyDocument: vi.fn(),
  mockDocument: vi.fn(),
}));



vi.mock('../../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../../platform')>();

  await actual.initPlatform();
  return {
    ...actual,
    platform: () => ({
      ...actual.platform(),
      fs: mockPlatform.fs,
    }),
    initPlatform: actual.initPlatform,
  };
});

vi.mock('../../sequence/public/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sequence/public/sequence-document-repository')>()),
  resolveSequenceDocument: mockResolveSequenceDocument,
  resolveSequenceDocumentById: mockResolveSequenceDocument,
  resolveCanonicalSequenceDocumentById: mockResolveSequenceDocument,
}));
vi.mock('../../molecular-documents/public/references', () => ({
  resolveLegacyMolecularDocumentReference: mockLegacyDocument,
  resolveMolecularDocumentReference: mockDocument,
}));

import { createCreateReferenceTool, createReferenceSchemaForFolders } from './create-reference';
import { execTool as executeTool, resetCanvasStore, setCanvasTabs } from './test-helpers';
import { initializeTestSchema } from '../../../test/initializeTestSchema';
import { createEntityReference, getEntityReference } from '../../../db/entity-references';
import * as referenceDb from '../../../db/entity-references';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { molViewSpecColorGroups } from '../../page/public/embeds/structure3d/molstar/molViewSpecLegend';
import { coordinateDigest } from '../../page/public/embeds/structure3d/molecularView';
import {
  molecularDocumentReferenceFor,
  molecularDocumentReferenceHref,
} from '../../../shared/molecular-document-reference';
import type { MolecularView } from '../../../shared/molecular-view';

const WORKSPACE = '/mock/test/workspace';
const singleFolder: WorkspaceFolder[] = [{ name: 'workspace', path: WORKSPACE, addedAt: 1 }];
const DOCUMENT_ID = 'catalog-puc19';
const SEQUENCE_SOURCE_PATH = `${WORKSPACE}/plasmids/pUC19.gb`;

beforeEach(() => {
  mockResolveSequenceDocument
    .mockReset()
    .mockImplementation(async (input: string | { kind: 'catalog-sequence'; entityId: string }) => {
      const documentId = typeof input === 'string' ? input : input.entityId;
      return {
        documentId,
        sourcePath: SEQUENCE_SOURCE_PATH,
        ref: { kind: 'catalog-sequence', entityId: documentId },
        name: 'pUC19',
      };
    });
});

const live3OaaContext = {
  structureId: 'PDB:3OAA',
  attrs: {},
  selectedResidues: [],
  chains: [
    {
      chainId: 'A',
      chainLabel: 'Chain A',
      sequence: 'HDS',
      authAsymId: 'A',
      residues: [
        { position: 57, labelSeqId: 57, name: 'H', name3: 'HIS' },
        { position: 102, labelSeqId: 102, name: 'D', name3: 'ASP' },
        { position: 195, labelSeqId: 195, name: 'S', name3: 'SER' },
      ],
    },
  ],
};

const mockFeatures = [
  {
    displayName: 'AmpR',
    type: 'CDS',
    start: 1629,
    end: 2489,
    direction: 'forward',
    qualifiers: { gene: ['bla'], product: ['beta-lactamase'] },
    color: '#3B82F6',
  },
  {
    displayName: 'AmpR promoter',
    type: 'promoter',
    start: 2490,
    end: 2594,
    direction: 'forward',
    qualifiers: { label: ['AmpR promoter'] },
    color: '#22C55E',
  },
  {
    displayName: 'ori',
    type: 'rep_origin',
    start: 2315,
    end: 2686,
    direction: 'none',
    qualifiers: {},
    color: '#F97316',
  },
];

function setupGenBankMocks() {
  mockPlatform.fs.stat.mockResolvedValue({ size: 1024 } as any);
  mockPlatform.fs.readTextFile.mockResolvedValue(
    genBankContent('sequence-222046-', 2686, mockFeatures)
  );
}

describe('create_reference tool', () => {
  it('pins a named molecular selection to its saved view and exact story step', async () => {
    await initializeTestSchema();
    const text = 'HEADER    PINNED GROUP\nEND\n';
    const scene = JSON.stringify({
      root: {
        kind: 'root',
        children: [
          {
            kind: 'download',
            params: { url: 'structure.pdb' },
            children: [
              {
                kind: 'parse',
                params: { format: 'pdb' },
                children: [
                  {
                    kind: 'structure',
                    params: { type: 'model' },
                    children: [
                      {
                        kind: 'component',
                        params: { selector: { label_asym_id: 'C' } },
                        children: [
                          {
                            kind: 'representation',
                            params: { type: 'ball_and_stick' },
                            children: [
                              {
                                kind: 'color',
                                params: { color: '#e5b139' },
                                custom: { dnaforge_legend_label: 'Peptide and acetyl cap' },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      metadata: { version: '1', key: 'binding-detail' },
    });
    const view = {
      kind: 'molecular-view',
      version: 1,
      title: 'Pinned pocket',
      caption: 'Binding detail',
      scene,
      coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
      source: {},
      evidence: [],
      preview: 'data:image/png;base64,AAAA',
      createdAt: 1,
    };
    const parent = await createEntityReference({
      entityType: 'structure',
      displayLabel: view.title,
      locator: 'entity://structure/saved-view:pinned-group',
      deepLinkParams: null,
      data: view,
      source: 'ai',
    });
    const group = molViewSpecColorGroups(scene, 0).find(
      (g) => g.label === 'Peptide and acetyl cap'
    )!;
    expect(group).toBeDefined();
    const tool = createCreateReferenceTool([], {
      getStructureContext: vi.fn(() => {
        throw Error('Must use pinned identity');
      }),
    });
    const document = {
      schema: 'dnaforge.molecular-document.v2' as const,
      id: '40000000-0000-4000-8000-000000000001',
      name: view.title,
      currentReferenceId: parent.id,
      history: [{ referenceId: parent.id, snapshot: view as MolecularView }],
    };
    const documentReference = await molecularDocumentReferenceFor('project', document);
    const resolution = {
      documentReference, snapshot: view,
      saved: { workspaceRoot: '/project', path: '/project/Pocket.dnaforge-molecular.json', document },
    };
    mockLegacyDocument.mockRejectedValueOnce(Error('No verified molecular document owner.'));
    const orphan = await execTool(tool, {
      entityType: 'structure', displayLabel: 'orphan',
      selection: { kind: 'molecular_view_target', viewReferenceId: parent.id, snapshotIndex: 0, groupId: group.id },
    });
    expect(orphan).toMatchObject({ referenceId: null, stateChanged: false });
    mockLegacyDocument.mockResolvedValue(resolution);
    mockDocument.mockResolvedValue(resolution);
    const result = await execTool(tool, {
      entityType: 'structure',
      displayLabel: 'a guessed label',
      selection: {
        kind: 'molecular_view_target',
        viewReferenceId: parent.id,
        snapshotIndex: 0,
        groupId: group.id,
      },
    });
    expect(result.referenceId).toEqual(expect.any(String));
    const saved = await getEntityReference(result.referenceId);
    expect(saved?.display_label).toBe('Peptide and acetyl cap');
    const reused = await execTool(tool, {
      entityType: 'molecular-document', displayLabel: 'Same pinned selection',
      selection: { kind: 'existing_reference', referenceId: saved!.id },
    });
    expect(reused).toMatchObject({ referenceId: saved!.id, reused: true });

    expect(JSON.parse(saved!.data!)).toEqual({
      ...documentReference,
      viewId: 'binding-detail',
      groupId: group.id,
    });
    expect(saved!.entity_type).toBe('molecular-document');
    expect(result.inlineLink).toBe(molecularDocumentReferenceHref(result.documentReference));
    const missing = await execTool(tool, {
      entityType: 'structure',
      displayLabel: 'missing',
      selection: {
        kind: 'molecular_view_target',
        viewReferenceId: parent.id,
        snapshotIndex: 0,
        groupId: 'missing-group',
      },
    });
    expect(missing.referenceId).toBeNull();
    const stable = await execTool(tool, {
      entityType: 'structure',
      displayLabel: 'guessed name',
      selection: {
        kind: 'molecular_view_target',
        viewReferenceId: parent.id,
        viewId: 'binding-detail',
        groupId: group.id,
      },
    });
    const stableReference = await getEntityReference(stable.referenceId);
    expect(JSON.parse(stableReference!.data!)).toEqual({
      ...documentReference,
      viewId: 'binding-detail',
      groupId: group.id,
    });
  });
  beforeEach(async () => {
    mockLegacyDocument.mockReset();
    mockDocument.mockReset();
    await initializeTestSchema();
    resetCanvasStore();
    mockPlatform.fs.exists.mockReset();
    mockPlatform.fs.readTextFile.mockReset();
    mockPlatform.fs.readDir.mockReset();
    mockPlatform.fs.stat.mockReset();
  });

  it('uses the managed document name instead of a generic GenBank LOCUS label', async () => {
    setupGenBankMocks();

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'sequence',
      displayLabel: 'pUC19',
      documentId: DOCUMENT_ID,
      deepLinkParams: {},
    });

    expect(result.referenceId).toBeTruthy();

    const ref = await getEntityReference(result.referenceId);
    expect(ref).not.toBeNull();
    expect(ref!.entity_type).toBe('sequence');
    expect(ref!.display_label).toBe('pUC19');
    expect(ref!.locator).toBe(DOCUMENT_ID);
    expect(ref!.workspace_root_path).toBe(WORKSPACE);
    expect(JSON.parse(ref!.data!)).toMatchObject({ documentId: DOCUMENT_ID });
    expect(mockResolveSequenceDocument).toHaveBeenCalledWith(DOCUMENT_ID, [WORKSPACE]);
    expect(mockPlatform.fs.exists).not.toHaveBeenCalled();
  });

  it('resolves the live canary bare filename from one open logical sequence tab', async () => {
    setupGenBankMocks();
    setCanvasTabs([
      {
        id: 'puc19-tab',
        type: 'sequence',
        entityId: DOCUMENT_ID,
        label: 'pUC19',
        sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
      },
    ]);

    const input = {
      entityType: 'sequence' as const,
      displayLabel: 'pUC19',
      filePath: 'pUC19.gb',
    };
    expect(createReferenceSchemaForFolders(singleFolder).safeParse(input).success).toBe(true);

    const result = await execTool<{ referenceId: string; error?: string }>(
      createCreateReferenceTool(singleFolder),
      input
    );

    expect(result.error).toBeUndefined();
    const reference = await getEntityReference(result.referenceId);
    expect(reference).toMatchObject({
      entity_type: 'sequence',
      locator: DOCUMENT_ID,
      workspace_root_path: WORKSPACE,
    });
    expect(JSON.parse(reference!.data!)).toMatchObject({ documentId: DOCUMENT_ID });
  });

  it('canonicalizes a bare filename supplied as documentId from one open sequence tab', async () => {
    setupGenBankMocks();
    mockResolveSequenceDocument.mockImplementation(
      async (input: string | { kind: 'catalog-sequence'; entityId: string }) => {
        const documentId = typeof input === 'string' ? input : input.entityId;
        if (typeof input === 'string' && input === 'pUC19.gb') {
          throw new Error('Physical sequence paths are deprecated; use the stable document ID.');
        }
        return {
          documentId,
          sourcePath: SEQUENCE_SOURCE_PATH,
          ref: { kind: 'catalog-sequence', entityId: documentId },
          name: 'pUC19',
        };
      }
    );
    setCanvasTabs([
      {
        id: 'puc19-tab',
        type: 'sequence',
        entityId: DOCUMENT_ID,
        label: 'pUC19',
        sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
      },
    ]);

    const input = {
      entityType: 'sequence' as const,
      displayLabel: 'pUC19',
      documentId: 'pUC19.gb',
    };
    expect(createReferenceSchemaForFolders(singleFolder).safeParse(input).success).toBe(true);

    const result = await execTool<{ referenceId: string; error?: string }>(
      createCreateReferenceTool(singleFolder),
      input
    );

    expect(result.error).toBeUndefined();
    const reference = await getEntityReference(result.referenceId);
    expect(reference).toMatchObject({
      entity_type: 'sequence',
      locator: DOCUMENT_ID,
      workspace_root_path: WORKSPACE,
    });
    expect(JSON.parse(reference!.data!)).toMatchObject({ documentId: DOCUMENT_ID });
    expect(mockResolveSequenceDocument).not.toHaveBeenCalledWith('pUC19.gb', [WORKSPACE]);
  });

  it('does not canonicalize an ambiguous bare filename supplied as documentId', async () => {
    const secondDocumentId = 'catalog-puc19-copy';
    mockResolveSequenceDocument.mockImplementation(
      async (input: string | { kind: 'catalog-sequence'; entityId: string }) => {
        const documentId = typeof input === 'string' ? input : input.entityId;
        if (typeof input === 'string' && input === 'pUC19.gb') {
          throw new Error('Physical sequence paths are deprecated; use the stable document ID.');
        }
        return {
          documentId,
          sourcePath:
            documentId === DOCUMENT_ID
              ? `${WORKSPACE}/plasmids/pUC19.gb`
              : `${WORKSPACE}/archive/pUC19.gb`,
          ref: { kind: 'catalog-sequence', entityId: documentId },
          name: 'pUC19',
        };
      }
    );
    setCanvasTabs([
      {
        id: 'puc19-current-tab',
        type: 'sequence',
        entityId: DOCUMENT_ID,
        label: 'pUC19',
        sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
      },
      {
        id: 'puc19-archive-tab',
        type: 'sequence',
        entityId: secondDocumentId,
        label: 'pUC19 copy',
        sequenceDocument: { kind: 'catalog-sequence', entityId: secondDocumentId },
      },
    ]);

    const result = await execTool<{ referenceId: string | null; error?: string }>(
      createCreateReferenceTool(singleFolder),
      {
        entityType: 'sequence',
        displayLabel: 'pUC19',
        documentId: 'pUC19.gb',
      }
    );

    expect(result.referenceId).toBeNull();
    expect(result.error).toBe(
      'Failed to create reference: Physical sequence paths are deprecated; use the stable document ID.'
    );
  });

  it('rejects a bare sequence filename shared by two open logical sequence tabs', async () => {
    const secondDocumentId = 'catalog-puc19-copy';
    mockResolveSequenceDocument.mockImplementation(
      async (input: string | { kind: 'catalog-sequence'; entityId: string }) => {
        const documentId = typeof input === 'string' ? input : input.entityId;
        return {
          documentId,
          sourcePath:
            documentId === DOCUMENT_ID
              ? `${WORKSPACE}/plasmids/pUC19.gb`
              : `${WORKSPACE}/archive/pUC19.gb`,
          ref: { kind: 'catalog-sequence', entityId: documentId },
          name: 'pUC19',
        };
      }
    );
    setCanvasTabs([
      {
        id: 'puc19-current-tab',
        type: 'sequence',
        entityId: DOCUMENT_ID,
        label: 'pUC19',
        sequenceDocument: { kind: 'catalog-sequence', entityId: DOCUMENT_ID },
      },
      {
        id: 'puc19-archive-tab',
        type: 'sequence',
        entityId: secondDocumentId,
        label: 'pUC19 copy',
        sequenceDocument: { kind: 'catalog-sequence', entityId: secondDocumentId },
      },
    ]);

    const result = await execTool<{ referenceId: string | null; error?: string }>(
      createCreateReferenceTool(singleFolder),
      {
        entityType: 'sequence',
        displayLabel: 'pUC19',
        filePath: 'pUC19.gb',
      }
    );

    expect(result).toMatchObject({
      ok: false,
      referenceId: null,
      error:
        'A bare sequence filename must identify exactly one open sequence tab. Open the file or use its stable documentId.',
    });
  });

  it('returns error when documentId cannot be resolved', async () => {
    mockResolveSequenceDocument.mockRejectedValueOnce(
      new Error('The sequence source is no longer available in this project.')
    );

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'sequence',
      displayLabel: 'missing',
      documentId: 'catalog-missing',
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('sequence source is no longer available');
  });

  it('refuses inline primer fabrication before writing a reference', async () => {
    const write = vi.spyOn(referenceDb, 'createEntityReference');
    const resolvePrimerReference = vi.fn();
    const tool = createCreateReferenceTool(singleFolder, { resolvePrimerReference });
    const result = await execTool<{ referenceId: null; error: string }>(tool, {
      entityType: 'primer',
      displayLabel: 'GFP_F1',
      locator: 'entity://primer/new',
      deepLinkParams: { bindingStart: 1204, bindingEnd: 1228 },
      data: { sequence: 'ATGCGA', tm: 62.3, gc: 0.52 },
    });
    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('Inline data cannot define a primer');
    expect(resolvePrimerReference).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it.each([false, true])(
    'saves canonical primer identity with optional attachment=%s',
    async (attached) => {
      const resolved = {
        entityId: 'registry-oligo',
        registryEntityId: 'registry-oligo',
        primerId: 'different-library-id',
        bindingId: attached ? 'binding-1' : null,
        locator: 'entity://primer/registry-oligo',
        displayLabel: 'Canonical oligo',
        workspaceRoot: WORKSPACE,
        localOnly: false,
        data: {
          registryEntityId: 'registry-oligo',
          primerId: 'different-library-id',
          ...(attached ? { bindingId: 'binding-1', targetDocumentId: DOCUMENT_ID } : {}),
        },
        deepLinkParams: attached ? { bindingStart: 101, bindingEnd: 120 } : null,
      };
      const resolvePrimerReference = vi.fn(async () => resolved);
      const tool = createCreateReferenceTool(singleFolder, { resolvePrimerReference });
      const result = await execTool<{ referenceId: string; registryEntityId: string }>(tool, {
        entityType: 'primer',
        displayLabel: 'Invented label',
        primerId: 'registry-oligo',
        ...(attached ? { bindingId: 'binding-1' } : {}),
      });
      expect(result.registryEntityId).toBe('registry-oligo');
      expect(resolvePrimerReference).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'registry-oligo',
          bindingId: attached ? 'binding-1' : undefined,
        }),
        singleFolder
      );
      const ref = await getEntityReference(result.referenceId);
      expect(ref).toMatchObject({
        entity_type: 'primer',
        locator: resolved.locator,
        display_label: 'Canonical oligo',
        workspace_root_path: WORKSPACE,
      });
      expect(JSON.parse(ref!.data!)).toEqual(resolved.data);
      expect(ref!.deep_link_params ? JSON.parse(ref!.deep_link_params) : null).toEqual(
        resolved.deepLinkParams
      );
      const reused = await execTool<{ referenceId: string; reused: boolean }>(tool, {
        entityType: 'primer',
        displayLabel: 'Existing',
        selection: { kind: 'existing_reference', referenceId: result.referenceId },
      });
      expect(reused).toMatchObject({ referenceId: result.referenceId, reused: true });
      const stale = await createEntityReference({
        entityType: 'primer',
        displayLabel: 'Stale',
        locator: resolved.locator,
        data: resolved.data,
        source: 'ai',
        workspaceRootPath: WORKSPACE,
        deepLinkParams: { bindingStart: 2, bindingEnd: 5 },
      });
      expect(
        await execTool<{ referenceId: null; error: string }>(tool, {
          entityType: 'primer',
          displayLabel: 'Stale',
          selection: { kind: 'existing_reference', referenceId: stale.id },
        })
      ).toMatchObject({
        referenceId: null,
        error: expect.stringContaining('disagrees with its canonical'),
      });
    }
  );

  it('does not save a reference when canonical identity verification fails', async () => {
    const write = vi.spyOn(referenceDb, 'createEntityReference');
    const tool = createCreateReferenceTool(singleFolder, {
      resolvePrimerReference: async () => {
        throw new Error('No active canonical oligo');
      },
    });
    const result = await execTool<{ referenceId: null; error: string }>(tool, {
      entityType: 'primer',
      displayLabel: 'Missing',
      primerId: 'nonexistent',
    });
    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('No active canonical oligo');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('creates a protein reference with an entity:// locator ', async () => {
    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'protein',
      displayLabel: 'GFP',
      locator: 'entity://protein/aa-uuid-1',
    });

    expect(result.referenceId).toBeTruthy();
    const ref = await getEntityReference(result.referenceId);
    expect(ref!.entity_type).toBe('protein');
    expect(ref!.locator).toBe('entity://protein/aa-uuid-1');
  });

  it('returns error when a sequence has no documentId', async () => {
    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'sequence',
      displayLabel: 'NoPath',
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('A stable documentId or locator is required');
  });

  it('returns error when locator has invalid scheme', async () => {
    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'notebook',
      displayLabel: 'Bad',
      locator: 'http://evil.com/payload',
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('git:// or entity://');
  });

  it('rejects identity-incomplete region, primer, and annotation inputs before execution', () => {
    const schema = createReferenceSchemaForFolders(singleFolder);
    expect(
      schema.safeParse({
        entityType: 'sequence_region',
        displayLabel: 'missing range',
        documentId: DOCUMENT_ID,
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        entityType: 'primer',
        displayLabel: 'missing canonical identity',
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        entityType: 'annotation',
        displayLabel: 'missing feature',
        documentId: DOCUMENT_ID,
      }).success
    ).toBe(false);
  });

  it('accepts identity-complete region, primer, and annotation inputs', () => {
    const schema = createReferenceSchemaForFolders(singleFolder);
    expect(
      schema.safeParse({
        entityType: 'sequence_region',
        displayLabel: 'range',
        documentId: DOCUMENT_ID,
        deepLinkParams: { start: 120, end: 240 },
      }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        entityType: 'primer',
        displayLabel: 'primer',
        locator: 'entity://primer/p1',
        deepLinkParams: { bindingStart: 120, bindingEnd: 140 },
      }).success
    ).toBe(true);
    expect(
      schema.safeParse({
        entityType: 'annotation',
        displayLabel: 'ori',
        documentId: DOCUMENT_ID,
        featureName: 'ori',
      }).success
    ).toBe(true);
  });

  it('derives a canonical structure reference from one typed discontinuous selection', async () => {
    const tool = createCreateReferenceTool([], {
      getStructureContext: vi.fn().mockResolvedValue(live3OaaContext),
    });
    const result = await execTool<{ referenceId: string; error?: string }>(tool, {
      entityType: 'structure',
      displayLabel: '3OAA catalytic residues',
      selection: {
        kind: 'structure',
        structureRef: 'PDB:3OAA',
        residues: [
          { chain: 'A', authAsymId: 'A', authSeqId: 57, labelCompId: 'his' },
          { chain: 'A', authAsymId: 'A', authSeqId: 102, labelCompId: 'ASP' },
          { chain: 'A', authAsymId: 'A', authSeqId: 195, labelCompId: 'SER' },
        ],
      },
    });

    expect(result.error).toBeUndefined();
    const ref = await getEntityReference(result.referenceId);
    expect(ref).not.toBeNull();
    expect(ref!.entity_type).toBe('structure');
    expect(ref!.locator).toBe('entity://structure/PDB:3OAA');
    expect(JSON.parse(ref!.deep_link_params!)).toEqual({
      highlightGroups: [
        {
          id: 'agent-reference-selection',
          label: '3OAA catalytic residues',
          renderMode: 'selection',
          selections: [
            {
              chain: 'A',
              authAsymId: 'A',
              ranges: [
                [57, 57],
                [102, 102],
                [195, 195],
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.parse(ref!.data!)).toMatchObject({
      schemaVersion: 2,
      kind: 'structure',
      measured: {
        structureRef: 'PDB:3OAA',
        residueCount: 3,
        regionCount: 3,
        residues: [
          {
            chain: 'A',
            authAsymId: 'A',
            authSeqId: 57,
            labelCompId: 'HIS',
            oneLetterCode: 'H',
            identityStatus: 'known',
          },
          {
            chain: 'A',
            authAsymId: 'A',
            authSeqId: 102,
            labelCompId: 'ASP',
            oneLetterCode: 'D',
            identityStatus: 'known',
          },
          {
            chain: 'A',
            authAsymId: 'A',
            authSeqId: 195,
            labelCompId: 'SER',
            oneLetterCode: 'S',
            identityStatus: 'known',
          },
        ],
      },
    });
  });

  it('accepts a matching locator and empty projections for an authoritative staged structure', async () => {
    const source = await createEntityReference({
      entityType: 'structure',
      displayLabel: '3OAA chain A residues 57, 102, and 195',
      locator: 'entity://structure/data:3oaa',
      deepLinkParams: {
        highlightGroups: [
          {
            id: 'source-selection',
            label: 'Selected residues',
            selections: [
              {
                chain: 'A',
                ranges: [
                  [57, 57],
                  [102, 102],
                  [195, 195],
                ],
              },
            ],
          },
        ],
      },
      data: {
        schemaVersion: 2,
        kind: 'structure',
        label: '3OAA chain A residues 57, 102, and 195',
        locator: { path: 'data:3oaa' },
        coordinateSystem: 'auth_seq_id-1-indexed-inclusive',
        sourceVersion: 0,
        measured: {
          structureRef: 'data:3oaa',
          residueCount: 3,
          regionCount: 3,
          disjoint: true,
          selections: [],
          residues: [
            {
              chain: 'A',
              authSeqId: 57,
              labelCompId: 'GLY',
              oneLetterCode: 'G',
              identityStatus: 'known',
            },
            {
              chain: 'A',
              authSeqId: 102,
              labelCompId: 'GLY',
              oneLetterCode: 'G',
              identityStatus: 'known',
            },
            {
              chain: 'A',
              authSeqId: 195,
              labelCompId: 'TYR',
              oneLetterCode: 'Y',
              identityStatus: 'known',
            },
          ],
          residueOmittedCount: 0,
          residueIdentities: [],
          residueIdentityKnownCount: 3,
          residueIdentityUnknownCount: 0,
          residueIdentityOmittedCount: 0,
          visibleRepresentations: [],
        },
        fileText: {},
        bases: 'never',
        fetch: { tools: [] },
      },
      source: 'user',
    });
    const getStructureContext = vi.fn().mockRejectedValue(new Error('Mol* is not mounted'));
    const tool = createCreateReferenceTool([], { getStructureContext });

    const result = await execTool<{
      referenceId: string | null;
      reused?: boolean;
      error?: string;
    }>(tool, {
      entityType: 'structure',
      displayLabel: '3OAA selected residues',
      locator: 'entity://structure/data:3oaa',
      deepLinkParams: {},
      data: {},
      selection: { kind: 'existing_reference', referenceId: source.id },
    });

    expect(result).toMatchObject({ referenceId: source.id, reused: true });
    expect(result.error).toBeUndefined();
    expect(getStructureContext).not.toHaveBeenCalled();
  });

  it('rejects a locator assertion that conflicts with the staged reference', async () => {
    const source = await createEntityReference({
      entityType: 'assembly',
      displayLabel: 'qualification-assembly-1',
      locator: 'entity://assembly/qualification-assembly-1',
      deepLinkParams: null,
      data: null,
      source: 'user',
    });
    const tool = createCreateReferenceTool([]);

    const result = await execTool<{ referenceId: string | null; error?: string }>(tool, {
      entityType: 'assembly',
      displayLabel: 'qualification-assembly-1',
      locator: 'entity://assembly/wrong-target',
      selection: { kind: 'existing_reference', referenceId: source.id },
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toMatch(/locator does not match.*referenceId/iu);
  });

  it('reuses a matching staged assembly reference without inventing another locator', async () => {
    const source = await createEntityReference({
      entityType: 'assembly',
      displayLabel: 'qualification-assembly-1',
      locator: 'entity://assembly/qualification-assembly-1',
      deepLinkParams: null,
      data: null,
      source: 'user',
    });
    const tool = createCreateReferenceTool([]);

    const result = await execTool<{
      referenceId: string | null;
      reused?: boolean;
      error?: string;
    }>(tool, {
      entityType: 'assembly',
      displayLabel: 'qualification-assembly-1',
      selection: { kind: 'existing_reference', referenceId: source.id },
    });

    expect(result).toMatchObject({ referenceId: source.id, reused: true });
    expect(result.error).toBeUndefined();
  });

  it('rejects reuse of a staged reference that is not an identity-complete structure selection', async () => {
    const source = await createEntityReference({
      entityType: 'sequence',
      displayLabel: 'not a structure',
      locator: 'entity://sequence/not-a-structure',
      deepLinkParams: null,
      data: null,
      source: 'user',
    });
    const tool = createCreateReferenceTool([]);

    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'structure',
      displayLabel: 'wrong source type',
      selection: { kind: 'existing_reference', referenceId: source.id },
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toMatch(/identity-complete structure selection/i);
    expect(result).toMatchObject({
      ok: false,
      code: 'REFERENCE_REJECTED',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
  });

  it('rejects an agent-supplied residue identity that disagrees with the live structure', async () => {
    const tool = createCreateReferenceTool([], {
      getStructureContext: vi.fn().mockResolvedValue(live3OaaContext),
    });
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'structure',
      displayLabel: 'invented identity',
      selection: {
        kind: 'structure',
        structureRef: 'PDB:3OAA',
        residues: [{ chain: 'A', authAsymId: 'A', authSeqId: 57, labelCompId: 'GLY' }],
      },
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toMatch(/GLY.*HIS|identity.*live structure/i);
  });

  it('rejects coordinate-only structure selections before creating a reference', async () => {
    const tool = createCreateReferenceTool([]);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'structure',
      displayLabel: 'incomplete selection',
      selection: {
        kind: 'structure',
        structureRef: 'AFDB:P26218',
        residues: [{ chain: 'A', authSeqId: 402 }],
      },
    });
    expect(result.referenceId).toBeNull();
    expect(result.error).toMatch(/labelCompId|identity is missing/i);
  });

  it('derives a revision-pinned inline structure object from a durable saved selection', async () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-1',
      name: 'Catalytic pair',
      color: '#ef4444',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      structureRevisions: [
        {
          id: 'structure-revision-1',
          structureId: 'PDB:3OAA',
          coordinateDigestSha256: 'coordinate-digest',
        },
      ],
      members: [
        {
          id: 'member-1',
          selection: {
            target: {
              moleculeId: 'protein:sha256:protein-digest',
              moleculeKind: 'protein',
              coordinateSystem: 'residue',
              intervals: [
                { start: 56, end: 56 },
                { start: 101, end: 101 },
              ],
            },
            mappings: [
              {
                kind: 'structure',
                structureId: 'PDB:3OAA',
                chain: 'A',
                position: 57,
                residueStart: 57,
                residueEnd: 57,
              },
              {
                kind: 'structure',
                structureId: 'PDB:3OAA',
                chain: 'A',
                position: 102,
                residueStart: 102,
                residueEnd: 102,
              },
            ],
          },
          scope: {
            kind: 'structure-chain-instance',
            structureRevisionId: 'structure-revision-1',
            chain: { chain: 'A' },
          },
          polymerRevision: {
            moleculeId: 'protein:sha256:protein-digest',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'protein-digest',
          },
          residueIdentities: [
            {
              polymerIndex: 56,
              authSeqId: 57,
              labelSeqId: 57,
              labelCompId: 'HIS',
              oneLetterCode: 'H',
            },
            {
              polymerIndex: 101,
              authSeqId: 102,
              labelSeqId: 102,
              labelCompId: 'ASP',
              oneLetterCode: 'D',
            },
          ],
        },
      ],
    });
    mockPlatform.fs.exists.mockResolvedValue(true);
    mockPlatform.fs.readDir.mockResolvedValue([
      {
        name: 'Catalytic pair.selection-1.wpselection.json',
        isDirectory: false,
        isFile: true,
      },
    ]);
    mockPlatform.fs.readTextFile.mockResolvedValue(
      serializeSavedResidueSelectionDocument(document)
    );

    const result = await execTool<{ referenceId: string; error?: string }>(
      createCreateReferenceTool(singleFolder),
      {
        entityType: 'structure',
        displayLabel: 'Catalytic pair',
        selection: {
          kind: 'saved_residue_selection',
          selectionId: 'selection-1',
          revisionId: 'selection-revision-1',
        },
      }
    );

    expect(result.error).toBeUndefined();
    const ref = await getEntityReference(result.referenceId);
    expect(ref?.locator).toBe('entity://structure/PDB:3OAA');
    expect(JSON.parse(ref!.data!)).toMatchObject({
      kind: 'structure',
      measured: {
        structureRef: 'PDB:3OAA',
        residueCount: 2,
        savedSelectionRef: {
          selectionId: 'selection-1',
          revisionId: 'selection-revision-1',
        },
        residues: [
          expect.objectContaining({
            authSeqId: 57,
            labelCompId: 'HIS',
            oneLetterCode: 'H',
            identityStatus: 'known',
          }),
          expect.objectContaining({
            authSeqId: 102,
            labelCompId: 'ASP',
            oneLetterCode: 'D',
            identityStatus: 'known',
          }),
        ],
      },
    });
    expect(JSON.parse(ref!.deep_link_params!)).toMatchObject({
      highlightGroups: [
        {
          label: 'Catalytic pair',
          selections: [
            {
              chain: 'A',
              ranges: [
                [57, 57],
                [102, 102],
              ],
            },
          ],
        },
      ],
    });
  });

  it('rejects competing projections when a typed selection is supplied', async () => {
    const tool = createCreateReferenceTool([]);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'structure',
      displayLabel: 'Conflicting selection',
      locator: 'entity://structure/PDB:WRONG',
      deepLinkParams: { highlightGroups: [] },
      data: { kind: 'not-the-selection' },
      selection: {
        kind: 'structure',
        structureRef: 'PDB:3OAA',
        residues: [{ chain: 'A', authSeqId: 57, labelCompId: 'HIS' }],
      },
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('selection is the source of truth');
  });
});

describe('create_reference non-sequence files (multi-folder)', () => {
  const multiFolders: WorkspaceFolder[] = [
    { name: 'Lab Data', path: '/home/user/lab', addedAt: 1 },
    { name: 'Shared', path: '/shared/plasmids', addedAt: 2 },
  ];

  beforeEach(async () => {
    await initializeTestSchema();
    mockPlatform.fs.exists.mockReset();
    resetCanvasStore();
  });

  it('resolves a bare non-sequence filename to one exact open tab across multiple folders', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setCanvasTabs(
      [
        {
          id: 'open-protocol',
          type: 'file',
          entityId: '/shared/plasmids/protocol.md',
          label: 'Protocol',
        },
      ],
      'open-protocol'
    );

    const result = await execTool<{ referenceId: string | null; error?: string }>(
      createCreateReferenceTool(multiFolders),
      {
        entityType: 'notebook',
        displayLabel: 'Protocol',
        filePath: 'protocol.md',
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.referenceId).toBeTruthy();
    const reference = await getEntityReference(result.referenceId!);
    expect(reference?.locator).toBe('git://Shared/protocol.md');
    expect(mockPlatform.fs.exists).toHaveBeenCalledWith('/shared/plasmids/protocol.md');
  });

  it('keeps a bare filename ambiguous when two distinct open tabs match', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setCanvasTabs(
      [
        {
          id: 'lab-protocol',
          type: 'file',
          entityId: '/home/user/lab/protocol.md',
          label: 'Lab protocol',
        },
        {
          id: 'shared-protocol',
          type: 'file',
          entityId: '/shared/plasmids/protocol.md',
          label: 'Shared protocol',
        },
      ],
      'shared-protocol'
    );

    const result = await execTool<{ referenceId: string | null; error?: string }>(
      createCreateReferenceTool(multiFolders),
      {
        entityType: 'notebook',
        displayLabel: 'Protocol',
        filePath: 'protocol.md',
      }
    );

    expect(result.referenceId).toBeNull();
    expect(result.error).toMatch(/could not determine which folder/iu);
    expect(mockPlatform.fs.exists).not.toHaveBeenCalled();
  });

  it('uses folder name in locator hostname', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);

    const tool = createCreateReferenceTool(multiFolders);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'notebook',
      displayLabel: 'Protocol',
      filePath: 'Shared/protocol.md',
    });

    expect(result.referenceId).toBeTruthy();

    const ref = await getEntityReference(result.referenceId);
    expect(ref!.locator).toBe('git://Shared/protocol.md');
    expect(mockPlatform.fs.exists).toHaveBeenCalledWith('/shared/plasmids/protocol.md');
  });

  it('uses folder name for file in subfolder', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);

    const tool = createCreateReferenceTool(multiFolders);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'notebook',
      displayLabel: 'Protocol',
      filePath: 'Lab Data/protocols/cas9.md',
    });

    const ref = await getEntityReference(result.referenceId);
    expect(ref!.locator).toBe('git://Lab Data/protocols/cas9.md');
  });
});

describe('create_reference featureName resolution', () => {
  beforeEach(async () => {
    await initializeTestSchema();
    mockPlatform.fs.exists.mockReset();
    mockPlatform.fs.readTextFile.mockReset();
    mockPlatform.fs.stat.mockReset();
  });

  it('resolves single feature match to exact coordinates', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setupGenBankMocks();

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'annotation',
      displayLabel: 'ori',
      documentId: DOCUMENT_ID,
      featureName: 'ori',
    });

    expect(result.referenceId).toBeTruthy();
    const ref = await getEntityReference(result.referenceId);
    const params = JSON.parse(ref!.deep_link_params!);
    expect(params.featureName).toBe('ori');
    expect(params.start).toBe(2315);
    expect(params.end).toBe(2686);
  });

  it('resolves the MCP-advertised nested annotation featureName to exact coordinates', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setupGenBankMocks();

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'annotation',
      displayLabel: 'ori',
      documentId: DOCUMENT_ID,
      deepLinkParams: { featureName: 'ori' },
    });

    expect(result.referenceId).toBeTruthy();
    const ref = await getEntityReference(result.referenceId);
    expect(JSON.parse(ref!.deep_link_params!)).toMatchObject({
      featureName: 'ori',
      start: 2315,
      end: 2686,
    });
  });

  it('returns error for ambiguous match (multiple features)', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setupGenBankMocks();

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'annotation',
      displayLabel: 'AmpR',
      documentId: DOCUMENT_ID,
      featureName: 'AmpR',
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('Multiple features match');
    expect(result.error).toContain('AmpR');
    expect(result.error).toContain('AmpR promoter');
  });

  it('returns error for no feature match', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setupGenBankMocks();

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'annotation',
      displayLabel: 'GFP',
      documentId: DOCUMENT_ID,
      featureName: 'nonexistent',
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('No feature matching');
    expect(result.error).toContain('Available features');
  });

  it('returns error when featureName is provided without documentId', async () => {
    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string | null; error: string }>(tool, {
      entityType: 'annotation',
      displayLabel: 'ori',
      locator: 'entity://annotation/123',
      featureName: 'ori',
    });

    expect(result.referenceId).toBeNull();
    expect(result.error).toContain('requires a stable sequence documentId');
  });

  it('replaces competing annotation coordinates with the parsed feature identity', async () => {
    mockPlatform.fs.exists.mockResolvedValue(true);
    setupGenBankMocks();

    const tool = createCreateReferenceTool(singleFolder);
    const result = await execTool<{ referenceId: string }>(tool, {
      entityType: 'annotation',
      displayLabel: 'custom region',
      documentId: DOCUMENT_ID,
      featureName: 'ori',
      deepLinkParams: { start: 100, end: 200 },
    });

    expect(result.referenceId).toBeTruthy();
    const ref = await getEntityReference(result.referenceId);
    const params = JSON.parse(ref!.deep_link_params!);
    expect(params.featureName).toBe('ori');
    expect(params.start).toBe(2315);
    expect(params.end).toBe(2686);
  });
});

function genBankContent(
  name: string,
  length: number,
  features: Array<{
    displayName: string;
    type: string;
    start: number;
    end: number;
    direction: string;
    qualifiers?: Record<string, string[]>;
  }>
): string {
  const sequence = 'a'.repeat(length);
  const featureLines = features.flatMap((feature) => {
    const location =
      feature.direction === 'reverse'
        ? `complement(${feature.start}..${feature.end})`
        : `${feature.start}..${feature.end}`;
    const qualifiers = {
      ...feature.qualifiers,
      label: [feature.displayName],
    };
    return [
      `     ${feature.type.padEnd(15)} ${location}`,
      ...Object.entries(qualifiers).flatMap(([key, values]) =>
        (values as string[]).map((value) => `                     /${key}="${value}"`)
      ),
    ];
  });
  return [
    `LOCUS       ${name.padEnd(16)} ${String(length).padStart(7)} bp    DNA     circular SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    ...featureLines,
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(createReferenceOutputSchema, result);
  return result;
}

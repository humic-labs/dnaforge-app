import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
  type SavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import type { Structure3dAttrs } from '../../page/public/embeds/structure3d/types';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      exists: vi.fn(),
      readDir: vi.fn(),
      readTextFile: vi.fn(),
    },
    molecularDocuments: { read: vi.fn() },
  },
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
}));

import {
  createApplySavedResidueSelectionTool,
  createGetSavedResidueSelectionTool,
  createListSavedResidueSelectionsTool,
  createSaveActiveResidueSelectionTool,
  getSavedResidueSelectionSchema,
  saveActiveResidueSelectionSchema,
} from './saved-residue-selections';
import { execTool as executeTool } from './test-helpers';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { z } from 'zod';
import {
  listSavedResidueSelectionsOutputSchema,
  getSavedResidueSelectionOutputSchema,
  saveActiveResidueSelectionOutputSchema,
  applySavedResidueSelectionOutputSchema,
} from './saved-residue-selection-output-schemas';

const FOLDERS: WorkspaceFolder[] = [{ name: 'experiment', path: '/lab/experiment', addedAt: 1 }];

function selectionDocument(): SavedResidueSelectionDocument {
  return createSavedResidueSelectionDocument({
    id: 'selection-1',
    name: 'Catalytic residues',
    color: '#ef4444',
    revisionId: 'selection-revision-1',
    createdAt: '2026-07-14T12:00:00.000Z',
    actor: { kind: 'user' },
    structureRevisions: [
      {
        id: 'structure-revision-1',
        structureId: 'structure:1ABC',
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
              { start: 85, end: 85 },
              { start: 108, end: 108 },
            ],
          },
          mappings: [
            {
              kind: 'structure',
              structureId: 'structure:1ABC',
              chain: 'A',
              position: 86,
              residueStart: 86,
              residueEnd: 86,
            },
            {
              kind: 'structure',
              structureId: 'structure:1ABC',
              chain: 'A',
              position: 109,
              residueStart: 109,
              residueEnd: 109,
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
      },
    ],
  });
}

const viewForSelection = vi.fn(
  async ({ workspaceRoot, attrs }: { workspaceRoot: string; attrs: Structure3dAttrs }) => ({
    attrs: {
      ...attrs,
      molecularDocumentId: 'document-for-selection',
      molecularDocumentPath: `${workspaceRoot}/structure.dnaforge-molecular.json`,
      molecularDocumentRevision: 'r1',
      molecularDocumentSavedReferenceId: 'reference-1',
    },
    workspaceRoot,
  })
);

describe('saved residue selection agent tools', () => {
  beforeEach(() => {
    mockPlatform.fs.exists.mockReset().mockResolvedValue(true);
    mockPlatform.fs.readDir.mockReset().mockResolvedValue([
      {
        name: 'Catalytic residues.selection-1.wpselection.json',
        isDirectory: false,
        isFile: true,
      },
    ]);
    mockPlatform.fs.readTextFile
      .mockReset()
      .mockResolvedValue(serializeSavedResidueSelectionDocument(selectionDocument()));
  });

  it('lists and reads revision-pinned exact disjoint residue intervals from native artifacts', async () => {
    const listed = await execTool<{
      ok: boolean;
      selections: Array<{ selectionId: string; currentRevisionId: string }>;
    }>(createListSavedResidueSelectionsTool(FOLDERS), {});
    expect(listed).toMatchObject({
      ok: true,
      selections: [
        {
          selectionId: 'selection-1',
          currentRevisionId: 'selection-revision-1',
        },
      ],
    });

    const read = await execTool<{
      ok: boolean;
      revision: SavedResidueSelectionDocument['revisions'][number];
    }>(createGetSavedResidueSelectionTool(FOLDERS), {
      selectionId: 'selection-1',
      revisionId: 'selection-revision-1',
    });
    expect(read.revision.members[0].selection.target.intervals).toEqual([
      { start: 85, end: 85 },
      { start: 108, end: 108 },
    ]);
  });

  it('pages one saved-selection member and bounds exact interval output by default', async () => {
    const document = selectionDocument();
    const revision = document.revisions[0];
    revision.members[0].selection.target.intervals = Array.from({ length: 201 }, (_, index) => ({
      start: index * 2,
      end: index * 2,
    }));
    revision.members.push({
      ...structuredClone(revision.members[0]),
      id: 'member-2',
    });
    mockPlatform.fs.readTextFile.mockResolvedValue(
      serializeSavedResidueSelectionDocument(document)
    );

    const read = await execTool<{
      ok: boolean;
      revision: SavedResidueSelectionDocument['revisions'][number];
      page: {
        memberIndex: number;
        totalMembers: number;
        intervals: { returned: number; total: number; nextOffset: number | null };
      };
    }>(createGetSavedResidueSelectionTool(FOLDERS), {
      selectionId: 'selection-1',
    });

    expect(read.revision.members).toHaveLength(1);
    expect(read.revision.members[0].selection.target.intervals).toHaveLength(200);
    expect(read.page).toMatchObject({
      memberIndex: 0,
      totalMembers: 2,
      intervals: { returned: 200, total: 201, nextOffset: 200 },
    });
  });

  it('caps saved-selection page sizes at the schema boundary', () => {
    expect(
      getSavedResidueSelectionSchema.safeParse({
        selectionId: 'selection-1',
        intervalLimit: 1000,
        identityLimit: 1000,
      }).success
    ).toBe(true);
    expect(
      getSavedResidueSelectionSchema.safeParse({
        selectionId: 'selection-1',
        intervalLimit: 1001,
      }).success
    ).toBe(false);
  });

  it('saves the active discontinuous residue set without collapsing it to a span', async () => {
    const saveSelection = vi.fn().mockResolvedValue({
      ref: {
        selectionId: 'selection-2',
        revisionId: 'selection-revision-2',
        artifactPath: 'Selections/Catalytic.selection-2.wpselection.json',
        visible: true,
      },
      projection: { id: 'selection-2', label: 'Catalytic', selections: [] },
      structureArtifactRef: {
        entityId: 'structure-asset-1',
        revisionId: 'structure-revision-1',
        structureId: 'structure:1ABC',
        coordinateDigestSha256: 'coordinate-digest',
        artifactPath: 'Structures/1ABC.cif',
        format: 'mmcif',
      },
    });
    const updateStructureAttrs = vi.fn();
    const clearActiveSelection = vi.fn();
    const tool = createSaveActiveResidueSelectionTool(FOLDERS, {
      createViewForSelection: viewForSelection,
      getStructureContext: vi.fn().mockResolvedValue({
        registrationId: 'structure-view:1ABC',
        structureId: 'structure:1ABC',
        interactionKey: 'binding:sequence:1ABC',
        attrs: { source: 'pdb', sourceId: '1ABC' },
        chains: [],
        selectedResidues: [
          { chain: 'A', position: 86 },
          { chain: 'A', position: 109 },
        ],
      }),
      saveSelection,
      updateStructureAttrs,
      clearActiveSelection,
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });

    const result = await execTool<{ ok: boolean; selectionId: string; stateChanged: boolean }>(
      tool,
      {
        structureRef: 'structure:1ABC',
        name: 'Catalytic',
      }
    );

    expect(result).toMatchObject({
      ok: true,
      selectionId: 'selection-2',
      stateChanged: true,
    });
    expect(saveSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        group: expect.objectContaining({
          color: '#22c55e',
          selections: [
            {
              chain: 'A',
              ranges: [
                [86, 86],
                [109, 109],
              ],
            },
          ],
        }),
      })
    );
    expect(updateStructureAttrs).toHaveBeenCalledWith(
      'structure-view:1ABC',
      expect.objectContaining({
        savedSelectionRefs: [expect.objectContaining({ selectionId: 'selection-2' })],
      })
    );
    expect(clearActiveSelection).toHaveBeenCalledWith('binding:sequence:1ABC');
  });

  it('does not advertise arbitrary saved-selection colors', () => {
    expect(
      saveActiveResidueSelectionSchema.safeParse({
        structureRef: 'structure:1ABC',
        name: 'Catalytic',
        color: '#dc2626',
      }).success
    ).toBe(false);
  });

  it('reports a successful durable save with a warning when the disposable view projection fails', async () => {
    const clearActiveSelection = vi.fn();
    const tool = createSaveActiveResidueSelectionTool(FOLDERS, {
      createViewForSelection: viewForSelection,
      getStructureContext: vi.fn().mockResolvedValue({
        registrationId: 'structure-view:1ABC',
        structureId: 'structure:1ABC',
        interactionKey: 'binding:sequence:1ABC',
        attrs: { source: 'pdb', sourceId: '1ABC' },
        chains: [],
        selectedResidues: [{ chain: 'A', position: 86 }],
      }),
      saveSelection: vi.fn().mockResolvedValue({
        ref: {
          selectionId: 'selection-2',
          revisionId: 'selection-revision-2',
          artifactPath: 'Selections/Catalytic.selection-2.wpselection.json',
          visible: true,
        },
        projection: { id: 'selection-2', label: 'Catalytic', selections: [] },
        structureArtifactRef: {
          entityId: 'structure-asset-1',
          revisionId: 'structure-revision-1',
          structureId: 'structure:1ABC',
          coordinateDigestSha256: 'coordinate-digest',
          artifactPath: 'Structures/1ABC.cif',
          format: 'mmcif',
        },
      }),
      updateStructureAttrs: vi.fn(() => {
        throw new Error('view disappeared');
      }),
      clearActiveSelection,
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });

    const result = await execTool<{
      ok: boolean;
      stateChanged: boolean;
      warnings: Array<{ stage: string; error: string }>;
    }>(tool, { structureRef: 'structure:1ABC', name: 'Catalytic' });

    expect(result).toMatchObject({
      ok: true,
      stateChanged: true,
      warnings: [{ stage: 'structure-view', error: 'view disappeared' }],
    });
    expect(clearActiveSelection).not.toHaveBeenCalled();
  });

  it('saves a structure that is not a view yet as a view and stores the selection in it ', async () => {
    const attrs = { source: 'pdb' as const, sourceId: '1ABC', label: '1ABC' };
    const viewAttrs = {
      ...attrs,
      molecularDocumentId: 'document-1',
      molecularDocumentPath: '/lab/experiment/1ABC.dnaforge-molecular.json',
      molecularDocumentRevision: 'r1',
    };
    const saveViewBeforeSelection = vi.fn();
    const createViewForSelection = vi
      .fn()
      .mockResolvedValue({ attrs: viewAttrs, workspaceRoot: '/lab/experiment' });
    const saveSelection = vi.fn().mockResolvedValue({
      ref: {
        selectionId: 'selection-3',
        revisionId: 'selection-revision-3',
        artifactPath: '1ABC.dnaforge-molecular.json',
        visible: true,
      },
      projection: { id: 'selection-3', label: 'Pocket', selections: [] },
      molecularDocumentPath: viewAttrs.molecularDocumentPath,
      molecularDocumentRevision: 'r2',
    });
    const updateStructureAttrs = vi.fn();
    const tool = createSaveActiveResidueSelectionTool(FOLDERS, {
      getStructureContext: vi.fn().mockResolvedValue({
        registrationId: 'structure-view:1ABC',
        structureId: 'structure:1ABC',
        structureViewId: 'view-1',
        interactionKey: 'binding:sequence:1ABC',
        attrs,
        chains: [],
        selectedResidues: [{ chain: 'A', position: 86 }],
      }),
      saveSelection,
      saveViewBeforeSelection,
      createViewForSelection,
      recordSelectionInOpenViews: vi.fn().mockReturnValue(0),
      findViewStructureRef: vi.fn().mockResolvedValue(null),
      updateStructureAttrs,
      clearActiveSelection: vi.fn(),
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });

    const result = await execTool<{ ok: boolean; artifactPath: string }>(tool, {
      structureRef: 'structure:1ABC',
      name: 'Pocket',
    });

    expect(result).toMatchObject({
      ok: true,
      artifactPath: '1ABC.dnaforge-molecular.json',
      structureRef: 'structure:1ABC',
    });
    expect(saveViewBeforeSelection).not.toHaveBeenCalled();
    expect(createViewForSelection).toHaveBeenCalledWith({
      workspaceRoot: '/lab/experiment',
      attrs,
    });
    expect(saveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/lab/experiment', attrs: viewAttrs })
    );
    expect(updateStructureAttrs).toHaveBeenCalledWith(
      'structure-view:1ABC',
      expect.objectContaining({
        molecularDocumentId: 'document-1',
        molecularDocumentPath: '/lab/experiment/1ABC.dnaforge-molecular.json',
        molecularDocumentRevision: 'r2',
      })
    );
  });

  it('fails closed when applying to different coordinate bytes', async () => {
    const updateStructureAttrs = vi.fn();
    const clearActiveSelection = vi.fn();
    const tool = createApplySavedResidueSelectionTool(FOLDERS, {
      getStructureContext: vi.fn().mockResolvedValue({
        registrationId: 'structure-view:1ABC',
        structureId: 'structure:1ABC',
        interactionKey: 'binding:sequence:1ABC',
        attrs: {
          source: 'pdb',
          sourceId: '1ABC',
          structureArtifactRef: {
            entityId: 'structure-asset-2',
            revisionId: 'structure-revision-2',
            structureId: 'structure:1ABC',
            coordinateDigestSha256: 'different-coordinate-digest',
            artifactPath: 'Structures/1ABC.cif',
            format: 'mmcif',
          },
        },
        chains: [],
        selectedResidues: [],
      }),
      updateStructureAttrs,
      clearActiveSelection,
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });

    const result = await execTool<{ ok: boolean; code: string; error: string }>(tool, {
      selectionId: 'selection-1',
      revisionId: 'selection-revision-1',
      structureRef: 'structure:1ABC',
      visible: true,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'APPLY_FAILED',
      stateChanged: false,
      partialEffects: [],
    });
    expect(result.error).toContain('coordinate bytes differ');
    expect(updateStructureAttrs).not.toHaveBeenCalled();
    expect(clearActiveSelection).not.toHaveBeenCalled();
  });

  it('applies an exact pinned revision as a view ref without copying canonical members', async () => {
    const updateStructureAttrs = vi.fn();
    const clearActiveSelection = vi.fn();
    const structureArtifactRef = {
      entityId: 'structure-asset-1',
      revisionId: 'structure-revision-current',
      structureId: 'structure:1ABC',
      coordinateDigestSha256: 'coordinate-digest',
      artifactPath: 'Structures/1ABC.cif',
      format: 'mmcif' as const,
    };
    const tool = createApplySavedResidueSelectionTool(FOLDERS, {
      getStructureContext: vi.fn().mockResolvedValue({
        registrationId: 'structure-view:1ABC',
        structureId: 'structure:1ABC',
        interactionKey: 'binding:sequence:1ABC',
        attrs: { source: 'pdb', sourceId: '1ABC', structureArtifactRef },
        chains: [],
        selectedResidues: [],
      }),
      updateStructureAttrs,
      clearActiveSelection,
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });

    const result = await execTool<{ ok: boolean }>(tool, {
      selectionId: 'selection-1',
      revisionId: 'selection-revision-1',
      structureRef: 'structure:1ABC',
      visible: true,
    });

    expect(result).toMatchObject({ ok: true, stateChanged: true });
    expect(updateStructureAttrs).toHaveBeenCalledWith('structure-view:1ABC', {
      savedSelectionRefs: [
        {
          selectionId: 'selection-1',
          revisionId: 'selection-revision-1',
          artifactPath: 'Selections/Catalytic residues.selection-1.wpselection.json',
          visible: true,
        },
      ],
      structureArtifactRef,
    });
    expect(clearActiveSelection).toHaveBeenCalledWith('binding:sequence:1ABC');
  });

  it('reports durable partial effects when saving fails after coordinate materialization', async () => {
    const partialEffects = [
      {
        kind: 'structure-coordinate-artifact',
        path: 'Structures/1ABC.structure-asset-1.cif',
        entityId: 'structure-asset-1',
      },
    ];
    const error = Object.assign(new Error('selection artifact write failed'), { partialEffects });
    const tool = createSaveActiveResidueSelectionTool(FOLDERS, {
      createViewForSelection: viewForSelection,
      getStructureContext: vi.fn().mockResolvedValue({
        registrationId: 'structure-view:1ABC',
        structureId: 'structure:1ABC',
        interactionKey: 'binding:sequence:1ABC',
        attrs: { source: 'pdb', sourceId: '1ABC' },
        chains: [],
        selectedResidues: [{ chain: 'A', position: 86 }],
      }),
      saveSelection: vi.fn().mockRejectedValue(error),
      updateStructureAttrs: vi.fn(),
      clearActiveSelection: vi.fn(),
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });

    const result = await execTool<{
      ok: boolean;
      code: string;
      stateChanged: boolean;
      partialEffects: unknown[];
    }>(tool, {
      structureRef: 'structure:1ABC',
      name: 'Catalytic',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'SAVE_FAILED',
      stateChanged: true,
      partialEffects,
    });
  });
});

describe('selections stored in molecular view files ', () => {
  const VIEW = '/lab/experiment/1ABC.dnaforge-molecular.json';
  const viewAttrs = (path = VIEW) => ({
    source: 'file' as const,
    sourceId: 'coordinates',
    molecularDocumentPath: path,
    coordinateSha256: 'coordinate-digest',
  });
  const context = (path = VIEW) => ({
    registrationId: 'view-1',
    structureId: 'structure:1ABC',
    interactionKey: 'view-1',
    attrs: viewAttrs(path),
    chains: [],
    selectedResidues: [],
  });

  beforeEach(() => {
    mockPlatform.fs.exists.mockReset().mockResolvedValue(false);
    mockPlatform.molecularDocuments.read.mockReset().mockResolvedValue({
      path: VIEW,
      workspaceRoot: '/lab/experiment',
      revision: 'r1',
      document: { selections: [selectionDocument()] },
    });
    useStructure3dStore.setState({
      expandedStructures: { 'view-1': { label: '1ABC', data: viewAttrs() } },
    });
  });

  afterEach(() => {
    useStructure3dStore.setState({ expandedStructures: {} });
  });

  it('lists selections stored in an open view file', async () => {
    const result = await execTool<{
      ok: true;
      selections: Array<{ selectionId: string; relativePath: string }>;
    }>(createListSavedResidueSelectionsTool(FOLDERS), {});
    expect(result.selections).toEqual([
      expect.objectContaining({
        selectionId: 'selection-1',
        relativePath: '1ABC.dnaforge-molecular.json',
      }),
    ]);
  });

  it('applies a view-file selection to its own view without copying coordinates', async () => {
    const updateStructureAttrs = vi.fn();
    const tool = createApplySavedResidueSelectionTool(FOLDERS, {
      getStructureContext: vi.fn().mockResolvedValue(context()),
      updateStructureAttrs,
      clearActiveSelection: vi.fn(),
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });
    const result = await execTool<{ ok: boolean }>(tool, {
      selectionId: 'selection-1',
      structureRef: 'structure:1ABC',
      visible: true,
    });
    expect(result).toMatchObject({ ok: true, stateChanged: true });
    expect(updateStructureAttrs).toHaveBeenCalledWith('view-1', {
      savedSelectionRefs: [
        {
          selectionId: 'selection-1',
          revisionId: 'selection-revision-1',
          artifactPath: '1ABC.dnaforge-molecular.json',
          visible: true,
        },
      ],
    });
  });

  it('refuses to apply a view-file selection to another view', async () => {
    const updateStructureAttrs = vi.fn();
    const tool = createApplySavedResidueSelectionTool(FOLDERS, {
      getStructureContext: vi
        .fn()
        .mockResolvedValue(context('/lab/experiment/Other.dnaforge-molecular.json')),
      updateStructureAttrs,
      clearActiveSelection: vi.fn(),
      resolveWorkspaceRoot: vi.fn().mockReturnValue('/lab/experiment'),
    });
    const result = await execTool<{ ok: boolean }>(tool, {
      selectionId: 'selection-1',
      structureRef: 'structure:1ABC',
      visible: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'SELECTION_IN_OTHER_VIEW' });
    expect(updateStructureAttrs).not.toHaveBeenCalled();
  });
});

const successSchema = z.union([
  listSavedResidueSelectionsOutputSchema,
  getSavedResidueSelectionOutputSchema,
  saveActiveResidueSelectionOutputSchema,
  applySavedResidueSelectionOutputSchema,
]);
async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(successSchema, result);
  return result;
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBEntityReference } from '../../db/entity-references';
import {
  MOLECULAR_DOCUMENT_SCHEMA,
  molecularDocumentSchema,
} from '../../shared/molecular-document';
import { coordinateDigest, type MolecularView } from '../../shared/molecular-view';
import { savedSelectionRefsForDocument } from '../../shared/molecular-document';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  exists: vi.fn(),
  project: vi.fn(),
  identity: vi.fn(),
  importSnapshot: vi.fn(),
  getReference: vi.fn(),
  bump: vi.fn(),
  getFileBinding: vi.fn(),
  getWorkspaceRoot: vi.fn(),
  updateTab: vi.fn(),
  updateStructure: vi.fn(),
  readText: vi.fn(),
  trash: vi.fn(),
  markMissing: vi.fn(),
  workspace: {
    folders: [{ path: '/project', name: 'Project' }],
    selectedPath: null as string | null,
  },
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    molecularDocuments: { read: mocks.read, save: mocks.save },
    fs: { exists: mocks.exists, readTextFile: mocks.readText },
    shell: { trashItem: mocks.trash },
  }),
}));
vi.mock('../../db/entity-substrate/molecular-document-adapter', () => ({
  molecularDocumentAdapter: {
    identity: mocks.identity,
    writeProjection: mocks.project,
  },
}));
vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceScope: async () => 'project-scope',
  getCatalogFileForPath: mocks.getFileBinding,
  getWorkspaceRootById: mocks.getWorkspaceRoot,
  markCatalogPathMissing: mocks.markMissing,
  findWorkspaceRootForPath: (folders: { path: string }[], path?: string | null) =>
    folders.find((folder) => path?.startsWith(folder.path + '/'))?.path ?? null,
}));
vi.mock('../../db/entity-references', () => ({ getEntityReference: mocks.getReference }));
vi.mock('../page/public/embeds/structure3d/molecularPresentation', () => ({
  importMolecularPresentationSnapshot: mocks.importSnapshot,
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      ...mocks.workspace,
      bumpFileTreeRefresh: mocks.bump,
    }),
  },
}));
vi.mock('../../shared/registry-events', () => ({ emitRegistryChanged: vi.fn() }));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: { getState: () => ({ panels: {}, updateTab: mocks.updateTab }) },
}));
vi.mock('../page/public/embeds/structure3d/store', () => ({
  useStructure3dStore: {
    getState: () => ({ expandedStructures: {}, updateStructureData: mocks.updateStructure }),
  },
}));

import {
  saveMolecularDocumentResult,
  readMolecularDocument,
  readMolecularDocumentFollowingRename,
  renameMolecularDocument,
} from './services';
import { SavedDocumentCompletionError } from '../../services/saved-document-completion';

const firstId = '09d6eb0d-a5d8-4ae6-a8c5-681f93d217e1';
const secondId = '09d6eb0d-a5d8-4ae6-a8c5-681f93d217e2';
const documentId = '09d6eb0d-a5d8-4ae6-a8c5-681f93d217e3';
const snapshot: MolecularView = {
  kind: 'molecular-view',
  version: 1,
  title: 'Binding pocket',
  caption: '',
  scene: '{"kind":"single","root":{"kind":"root","children":[]}}',
  coordinates: { format: 'pdb', text: 'ATOM pinned', sha256: 'a'.repeat(64) },
  source: {},
  evidence: [],
  preview: 'data:image/png;base64,AAAA',
  createdAt: 1,
};
function reference(id: string, view = snapshot): DBEntityReference {
  return {
    id,
    entity_type: 'structure',
    display_label: view.title,
    locator: `entity://structure/saved-view:${id}`,
    data: JSON.stringify(view),
    deep_link_params: null,
    source: 'ai',
    status: 'created',
    workspace_scope: 'scope',
    workspace_root_path: '/project',
    created_at: view.createdAt,
    updated_at: view.createdAt,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.folders = [{ path: '/project', name: 'Project' }];
  mocks.workspace.selectedPath = null;
  mocks.exists.mockResolvedValue(false);
  mocks.identity.mockReturnValue('scoped-document');
  mocks.getReference.mockResolvedValue(null);
  mocks.getFileBinding.mockResolvedValue(null);
  mocks.getWorkspaceRoot.mockResolvedValue(null);
  mocks.project.mockResolvedValue(undefined);
  mocks.readText.mockReset();
  mocks.readText.mockRejectedValue(new Error('not found'));
  mocks.trash.mockReset();
  mocks.trash.mockResolvedValue(undefined);
  mocks.markMissing.mockReset();
  mocks.markMissing.mockResolvedValue({ updated: 1 });
  mocks.save.mockImplementation(async (request) => ({
    ...request.destination,
    document: request.document,
    revision: 'b'.repeat(64),
  }));
});
describe('project molecular documents and retained conversation results', () => {
  it('carries unfamiliar extension data into the native save when a bound view is edited', async () => {
    const extensions = {
      'org.example.future-annotations': {
        version: 4,
        data: { documentId, viewReferenceId: firstId, unknownFields: { label: 'Preserve this' } },
      },
    };
    mocks.read.mockResolvedValue({
      document: {
        schema: 'dnaforge.molecular-document.v2',
        id: documentId,
        name: 'Binding pocket',
        currentReferenceId: firstId,
        history: [{ referenceId: firstId, snapshot }],
        extensions,
      },
      path: '/project/pocket.dnaforge-molecular.json',
      workspaceRoot: '/project',
      revision: 'c'.repeat(64),
    });
    await saveMolecularDocumentResult(reference(secondId, { ...snapshot, createdAt: 2 }), {
      source: 'file',
      sourceId: snapshot.coordinates.text,
      molecularDocumentId: documentId,
      molecularDocumentPath: '/project/pocket.dnaforge-molecular.json',
      molecularDocumentRevision: 'c'.repeat(64),
      molecularDocumentSavedReferenceId: firstId,
    });
    const request = mocks.save.mock.calls[0][0];
    expect(request.document.extensions).toEqual(extensions);
    expect(request.document.history).toHaveLength(2);
    expect(request.destination.path).toBe('/project/pocket.dnaforge-molecular.json');
    expect(request.expectedRevision).toBe('c'.repeat(64));
  });

  it('renames through the native revision while preserving all scientific history', async () => {
    const saved = {
      document: {
        schema: MOLECULAR_DOCUMENT_SCHEMA,
        id: documentId,
        name: 'Binding pocket',
        currentReferenceId: firstId,
        history: [{ referenceId: firstId, snapshot }],
      },
      path: '/project/pocket.dnaforge-molecular.json',
      workspaceRoot: '/project',
      revision: 'c'.repeat(64),
    };
    mocks.save.mockImplementationOnce(async (request) => ({
      ...saved,
      document: molecularDocumentSchema.parse(request.document),
      revision: 'b'.repeat(64),
    }));
    mocks.project.mockRejectedValueOnce(new Error('Registry unavailable'));
    let failure: unknown;
    try {
      await renameMolecularDocument({ saved, name: 'Renamed pocket' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SavedDocumentCompletionError);
    const request = mocks.save.mock.calls[0][0];
    expect(request).toMatchObject({
      expectedRevision: saved.revision,
      destination: { path: saved.path, workspaceRoot: saved.workspaceRoot },
    });
    expect(request.document).toEqual({ ...saved.document, name: 'Renamed pocket' });
    mocks.read.mockResolvedValue({
      ...saved,
      document: request.document,
      revision: 'b'.repeat(64),
    });
    await (failure as SavedDocumentCompletionError).complete();
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.project).toHaveBeenLastCalledWith(
      request.document,
      'scoped-document',
      expect.any(Number),
      saved.path,
      expect.any(Object)
    );
    mocks.read.mockResolvedValue({ ...saved, revision: 'd'.repeat(64) });
    await expect((failure as SavedDocumentCompletionError).complete()).rejects.toThrow('changed');
    expect(mocks.project).toHaveBeenCalledTimes(2);
    expect(saved.document.name).toBe('Binding pocket');
  });
  it('saves a chat result into a new native artifact and projects it, leaving the source independent', async () => {
    const original = reference(firstId);
    const before = original.data;
    const result = await saveMolecularDocumentResult(original, {
      source: 'file',
      sourceId: snapshot.coordinates.text,
      coordinateFilePath: '/project/source.pdb',
    });
    const request = mocks.save.mock.calls[0][0];
    expect(request.expectedRevision).toBeNull();
    expect(request.destination.workspaceRoot).toBe('/project');
    expect(request.destination.path).toBe('/project/Binding pocket.dnaforge-molecular.json');
    expect(request.document.currentReferenceId).toBe(firstId);
    expect(request.document.history).toEqual([{ referenceId: firstId, snapshot }]);
    expect(mocks.project).toHaveBeenCalledOnce();
    expect(result.catalogEntityId).toBe('scoped-document');
    expect(result).toMatchObject({
      documentReference: {
        kind: 'molecular-document',
        version: 1,
        projectId: 'project-scope',
        documentId: result.document.id,
        revisionId: firstId,
      },
    });
    expect(original.data).toBe(before);
  });
  it('creates a new view beside its source file, named without the extension ', async () => {
    const titled = reference(firstId, { ...snapshot, title: '1FS0.pdb' });
    mocks.exists.mockImplementation(
      async (path: string) => path === '/project/structures/1FS0.dnaforge-molecular.json'
    );
    await saveMolecularDocumentResult(titled, {
      source: 'file',
      sourceId: snapshot.coordinates.text,
      coordinateFilePath: '/project/structures/1FS0.pdb',
    });
    const request = mocks.save.mock.calls[0][0];
    expect(request.destination.path).toBe('/project/structures/1FS0 2.dnaforge-molecular.json');
    expect(request.document.name).toBe('1FS0');
  });
  it('absorbs the loose source file into the new view so the project shows one entry ', async () => {
    const pinned = {
      ...snapshot,
      coordinates: { ...snapshot.coordinates, sha256: await coordinateDigest('ATOM pinned') },
    };
    mocks.readText.mockResolvedValue('ATOM pinned');
    await saveMolecularDocumentResult(reference(firstId, pinned), {
      source: 'file',
      sourceId: pinned.coordinates.text,
      coordinateFilePath: '/project/1FS0.pdb',
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.trash).toHaveBeenCalledWith('/project/1FS0.pdb');
    expect(mocks.markMissing).toHaveBeenCalledWith('/project/1FS0.pdb', 'absorbed-into-view');
  });

  it('keeps a source file whose bytes changed since the view captured them ', async () => {
    const pinned = {
      ...snapshot,
      coordinates: { ...snapshot.coordinates, sha256: await coordinateDigest('ATOM pinned') },
    };
    mocks.readText.mockResolvedValue('ATOM edited elsewhere');
    await saveMolecularDocumentResult(reference(firstId, pinned), {
      source: 'file',
      sourceId: pinned.coordinates.text,
      coordinateFilePath: '/project/1FS0.pdb',
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.trash).not.toHaveBeenCalled();
  });

  it('keeps the save and warns when the source file cannot be moved to the Trash ', async () => {
    const pinned = {
      ...snapshot,
      coordinates: { ...snapshot.coordinates, sha256: await coordinateDigest('ATOM pinned') },
    };
    mocks.readText.mockResolvedValue('ATOM pinned');
    mocks.trash.mockRejectedValue(new Error('locked'));
    const result = await saveMolecularDocumentResult(reference(firstId, pinned), {
      source: 'file',
      sourceId: pinned.coordinates.text,
      coordinateFilePath: '/project/1FS0.pdb',
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(result.warning).toMatch(/could not be moved to the Trash/);
  });

  it('advances the bound file with its expected revision and preserves previous results', async () => {
    const oldDocument = {
      schema: 'dnaforge.molecular-document.v1',
      id: documentId,
      name: 'Binding pocket',
      currentReferenceId: firstId,
      history: [{ referenceId: firstId, snapshot }],
    };
    mocks.read.mockResolvedValue({
      document: oldDocument,
      path: '/project/pocket.dnaforge-molecular.json',
      workspaceRoot: '/project',
      revision: 'c'.repeat(64),
    });
    const next = { ...snapshot, title: 'Closer pocket', createdAt: 2 };
    await saveMolecularDocumentResult(reference(secondId, next), {
      source: 'file',
      sourceId: snapshot.coordinates.text,
      molecularDocumentId: documentId,
      molecularDocumentPath: '/project/pocket.dnaforge-molecular.json',
      molecularDocumentRevision: 'c'.repeat(64),
      molecularDocumentSavedReferenceId: firstId,
    });
    const request = mocks.save.mock.calls[0][0];
    expect(request.expectedRevision).toBe('c'.repeat(64));
    expect(request.document.id).toBe(documentId);
    expect(request.document.history).toEqual([
      { referenceId: firstId, snapshot },
      { referenceId: secondId, snapshot: next },
    ]);
    expect(oldDocument.currentReferenceId).toBe(firstId);
  });
  it('does not overwrite an externally changed file with an old working version', async () => {
    mocks.read.mockResolvedValue({ document: { id: documentId }, revision: 'd'.repeat(64) });
    await expect(
      saveMolecularDocumentResult(reference(secondId), {
        source: 'file',
        sourceId: 'ATOM',
        molecularDocumentId: documentId,
        molecularDocumentPath: '/project/pocket.dnaforge-molecular.json',
        molecularDocumentRevision: 'c'.repeat(64),
      })
    ).rejects.toThrow(/changed|version/i);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('reconstructs exact history from the native artifact without reopening source paths', async () => {
    const doc = {
      schema: 'dnaforge.molecular-document.v1',
      id: documentId,
      name: 'Binding pocket',
      currentReferenceId: secondId,
      history: [
        { referenceId: firstId, snapshot },
        { referenceId: secondId, snapshot: { ...snapshot, createdAt: 2 } },
      ],
    };
    mocks.read.mockResolvedValue({
      document: doc,
      path: '/project/copy.dnaforge-molecular.json',
      workspaceRoot: '/project',
      revision: 'e'.repeat(64),
    });
    const result = await readMolecularDocument('/project/copy.dnaforge-molecular.json');
    expect(mocks.importSnapshot).toHaveBeenCalledTimes(2);
    expect(result.document.currentReferenceId).toBe(secondId);
    expect(mocks.exists).not.toHaveBeenCalled();
  });
  it('follows an extension-named view to its renamed file only for the same document ', async () => {
    const doc = {
      schema: 'dnaforge.molecular-document.v1',
      id: documentId,
      name: '1FS0',
      currentReferenceId: firstId,
      history: [{ referenceId: firstId, snapshot }],
    };
    const oldPath = '/project/Molecular views/1FS0.pdb.dnaforge-molecular.json';
    const newPath = '/project/Molecular views/1FS0.dnaforge-molecular.json';
    mocks.read.mockImplementation(async ({ path }: { path: string }) => {
      if (path === oldPath) throw new Error('ENOENT');
      return { document: doc, path: newPath, workspaceRoot: '/project', revision: 'e'.repeat(64) };
    });
    const followed = await readMolecularDocumentFollowingRename(oldPath, documentId);
    expect(followed.path).toBe(newPath);
    await expect(
      readMolecularDocumentFollowingRename(oldPath, '99999999-9999-4999-8999-999999999999')
    ).rejects.toThrow(/ENOENT/);
  });

  it('builds project-relative selection references for a view file ', () => {
    expect(
      savedSelectionRefsForDocument({
        path: '/project/views/1FS0.dnaforge-molecular.json',
        workspaceRoot: '/project/',
        document: { selections: [{ id: 'selection-1', currentRevisionId: 'revision-2' }] },
      })
    ).toEqual([
      {
        selectionId: 'selection-1',
        revisionId: 'revision-2',
        artifactPath: 'views/1FS0.dnaforge-molecular.json',
        visible: true,
      },
    ]);
  });

  it('retains the published file binding if its Registry projection needs repair', async () => {
    mocks.project.mockRejectedValueOnce(Error('Catalog temporarily unavailable'));
    const saved = await saveMolecularDocumentResult(reference(firstId), {
      source: 'file',
      sourceId: 'ATOM',
    });
    expect(saved.revision).toBe('b'.repeat(64));
    expect(saved.warning).toMatch(/saved.*Registry/i);
    expect(saved.path).toContain('.dnaforge-molecular.json');
  });
  it('opens an unmounted Registry document using its durable owning project', async () => {
    mocks.workspace.folders = [{ path: '/another-project', name: 'Another project' }];
    mocks.getFileBinding.mockResolvedValue({ workspace_id: 71 });
    mocks.getWorkspaceRoot.mockResolvedValue('/project');
    const path = '/project/Molecular views/pocket.dnaforge-molecular.json';
    mocks.read.mockResolvedValue({
      document: {
        schema: 'dnaforge.molecular-document.v1',
        id: documentId,
        name: 'Binding pocket',
        currentReferenceId: firstId,
        history: [{ referenceId: firstId, snapshot }],
      },
      path,
      workspaceRoot: '/project',
      revision: 'e'.repeat(64),
    });
    await readMolecularDocument(path);
    expect(mocks.read).toHaveBeenCalledWith({ path, workspaceRoot: '/project' });
    expect(mocks.getWorkspaceRoot).toHaveBeenCalledWith(71);
  });
  it('saves an unmounted bound document in its owner rather than a different mounted project', async () => {
    mocks.workspace.folders = [{ path: '/another-project', name: 'Another project' }];
    mocks.workspace.selectedPath = '/another-project';
    mocks.getFileBinding.mockResolvedValue({ workspace_id: 71 });
    mocks.getWorkspaceRoot.mockResolvedValue('/project');
    const path = '/project/Molecular views/pocket.dnaforge-molecular.json';
    mocks.read.mockResolvedValue({
      document: {
        schema: 'dnaforge.molecular-document.v1',
        id: documentId,
        name: 'Binding pocket',
        currentReferenceId: firstId,
        history: [{ referenceId: firstId, snapshot }],
      },
      path,
      workspaceRoot: '/project',
      revision: 'c'.repeat(64),
    });
    await saveMolecularDocumentResult(reference(secondId, { ...snapshot, createdAt: 2 }), {
      source: 'file',
      sourceId: snapshot.coordinates.text,
      molecularDocumentId: documentId,
      molecularDocumentPath: path,
      molecularDocumentRevision: 'c'.repeat(64),
      molecularDocumentSavedReferenceId: firstId,
    });
    expect(mocks.read).toHaveBeenCalledWith({ path, workspaceRoot: '/project' });
    expect(mocks.save.mock.calls[0][0].destination).toEqual({ path, workspaceRoot: '/project' });
  });
  it('does not guess a new owner for a bound document whose durable workspace is unavailable', async () => {
    mocks.getFileBinding.mockResolvedValue({ workspace_id: 71 });
    mocks.getWorkspaceRoot.mockResolvedValue(null);
    await expect(readMolecularDocument('/project/pocket.dnaforge-molecular.json')).rejects.toThrow(
      /owning|owner|project/i
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });
});

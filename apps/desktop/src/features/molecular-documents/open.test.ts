import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import type { MolecularView } from '../../shared/molecular-view';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  present: vi.fn(),
  getReference: vi.fn(),
  capture: vi.fn(),
  panels: {} as Record<
    string,
    {
      id: string;
      tabs: Array<{
        id: string;
        type: string;
        entityId: string;
        label: string;
        initialStructureAttrs?: Structure3dAttrs;
        isDirty?: boolean;
      }>;
    }
  >,
  structures: {} as Record<string, { data: Structure3dAttrs }>,
  cache: new Map<string, { container: HTMLDivElement; plugin: object | null }>(),
  updateStructure: vi.fn(),
  updateTab: vi.fn(),
}));
vi.mock('./services', () => ({ readMolecularDocument: mocks.read }));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      panels: mocks.panels,
      updateTab: mocks.updateTab,
    }),
  },
}));
vi.mock('../canvas/public/present-document', () => ({ presentDocument: mocks.present }));
vi.mock('../page/public/embeds/structure3d/store', () => ({
  useStructure3dStore: {
    getState: () => ({
      expandedStructures: mocks.structures,
      updateStructureData: mocks.updateStructure,
    }),
  },
}));
vi.mock('../../db/entity-references', () => ({ getEntityReference: mocks.getReference }));
vi.mock('../page/public/embeds/structure3d/molstar/cache', () => ({ viewerCache: mocks.cache }));
vi.mock('../page/public/embeds/structure3d/molstar/molViewSpec', () => ({
  captureMolViewSpecView: mocks.capture,
}));

import { openMolecularDocument } from './open';
import { molecularViewAttrs } from '../page/public/embeds/structure3d/molecularView';
import { molecularDocumentRevisionDigest } from '../../shared/molecular-document-reference';
import { prepareMolecularDataPublication } from '../page/public/embeds/structure3d/molecularData';
import {
  structureKeyOverrideForAttrs,
  structureSourceIdentityKey,
} from '../page/public/embeds/structure3d/utils/structureSourceIdentity';

const firstId = '09d6eb0d-a5d8-4ae6-a8c5-681f93d217e1';
const secondId = '09d6eb0d-a5d8-4ae6-a8c5-681f93d217e2';
const documentId = '09d6eb0d-a5d8-4ae6-a8c5-681f93d217e3';
const entityId = `molecular-document:scope::${documentId}`;
const oldPath = '/project/old.dnaforge-molecular.json';
const newPath = '/project/moved.dnaforge-molecular.json';
const baseline: MolecularView = {
  kind: 'molecular-view',
  version: 1,
  title: 'Pocket',
  caption: '',
  scene:
    '{"kind":"single","root":{"kind":"root","children":[{"kind":"camera","params":{"target":[0,0,0],"position":[0,0,10],"up":[0,1,0]}}]}}',
  cameraSnapshot: '{"position":[0,0,10]}',
  coordinates: { format: 'pdb', text: 'ATOM pinned', sha256: 'a'.repeat(64) },
  source: {},
  evidence: [],
  preview: 'data:image/png;base64,AAAA',
  createdAt: 1,
};
const changedScene = baseline.scene.replace('[0,0,10]', '[0,0,20]');

function setupTab(isDirty = false): Structure3dAttrs {
  const attrs = {
    ...molecularViewAttrs(entityId, baseline, undefined, firstId),
    molecularDocumentId: documentId,
    molecularDocumentPath: oldPath,
    molecularDocumentRevision: 'b'.repeat(64),
    molecularDocumentSavedReferenceId: firstId,
  };
  mocks.structures[entityId] = { data: attrs };
  mocks.panels.panel = {
    id: 'panel',
    tabs: [
      {
        id: 'tab',
        type: 'structure',
        entityId,
        label: 'Pocket',
        initialStructureAttrs: attrs,
        isDirty,
      },
    ],
  };
  return attrs;
}

function saved(path = newPath, revision = 'c'.repeat(64)) {
  return {
    path,
    workspaceRoot: '/project',
    revision,
    catalogEntityId: `scope::${documentId}`,
    documentReference: {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'scope',
      documentId,
      revisionId: secondId,
      revisionSha256: 'a'.repeat(64),
    },
    document: {
      schema: 'dnaforge.molecular-document.v1' as const,
      id: documentId,
      name: 'Pocket',
      currentReferenceId: secondId,
      history: [
        { referenceId: firstId, snapshot: baseline },
        { referenceId: secondId, snapshot: { ...baseline, scene: changedScene, createdAt: 2 } },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.panels = {};
  mocks.structures = {};
  mocks.cache.clear();
  document.body.replaceChildren();
  mocks.getReference.mockResolvedValue(null);
  mocks.present.mockReturnValue({
    status: 'presented',
    tabId: 'tab',
    panelId: 'panel',
    tabType: 'structure',
    disposition: 'reused',
    content: 'loading',
  });
  mocks.updateStructure.mockImplementation((id, data) => {
    if (mocks.structures[id]) mocks.structures[id].data = data;
  });
  mocks.updateTab.mockImplementation((panelId, tabId, updates) => {
    const tab = mocks.panels[panelId].tabs.find((tab) => tab.id === tabId);
    if (tab) Object.assign(tab, updates);
  });
});

describe('reopening current native molecular documents', () => {
  it('preserves published records that have not changed the native scene when the file changes', async () => {
    const attrs = setupTab();
    const publication = await prepareMolecularDataPublication({
      id: 'unapplied-results',
      name: 'Unapplied results',
      records: [{ chain: 'A', position: 1, score: 42 }],
      source: { label: 'Retained analysis output' },
      mapping: {
        coordinateSha256: baseline.coordinates.sha256,
        selectorColumns: { label_asym_id: 'chain', label_seq_id: 'position' },
      },
    });
    attrs.molecularData = {
      version: 1,
      datasets: [publication.dataset],
      mappings: [publication.mapping],
      layers: [],
    };
    const host = document.createElement('div');
    host.dataset.structureAgentHost = entityId;
    const container = document.createElement('div');
    host.append(container);
    document.body.append(host);
    mocks.cache.set('unchanged-native-scene', { container, plugin: {} });
    mocks.capture.mockReturnValue({
      scene: baseline.scene,
      coordinates: baseline.coordinates,
      pinnedAssets: [],
    });
    mocks.read.mockResolvedValue(saved(oldPath));

    const result = await openMolecularDocument(oldPath, {});

    expect(result.status).toBe('blocked');
    expect(mocks.structures[entityId].data).toEqual(attrs);
    expect(mocks.structures[entityId].data.molecularData?.datasets[0].records).toEqual([
      { chain: 'A', position: 1, score: 42 },
    ]);
    expect(mocks.present).not.toHaveBeenCalled();
  });

  it.each(['file', 'url'] as const)(
    'reuses the verified live %s coordinates when reopening the same saved revision',
    async (source) => {
      const attrs = setupTab();
      Object.assign(attrs, {
        source,
        sourceId: source === 'file' ? baseline.coordinates.text : 'https://example.org/3tyg.cif',
        coordinateSha256: undefined,
        molecularDocumentRevision: 'c'.repeat(64),
        molecularDocumentSavedReferenceId: secondId,
        molViewSpecSavedReferenceId: secondId,
        molViewSpec: changedScene,
      });
      const sourceIdentity = structureSourceIdentityKey(attrs);
      const structureKey = structureKeyOverrideForAttrs(attrs);
      const host = document.createElement('div');
      host.dataset.structureAgentHost = entityId;
      const container = document.createElement('div');
      host.append(container);
      document.body.append(host);
      mocks.cache.set('live-source', { container, plugin: {} });
      mocks.capture.mockReturnValue({
        scene: changedScene,
        coordinates: baseline.coordinates,
        pinnedAssets: [],
      });
      const native = saved();
      mocks.read.mockResolvedValue(native);
      const reference = {
        ...native.documentReference,
        revisionSha256: await molecularDocumentRevisionDigest(native.document.history[1].snapshot),
      };

      const result = await openMolecularDocument(newPath, { reference });

      expect(result.status).toBe('presented');
      expect(mocks.capture).toHaveBeenCalledOnce();
      const reopened = mocks.structures[entityId].data;
      expect(structureSourceIdentityKey(reopened)).toBe(sourceIdentity);
      expect(structureKeyOverrideForAttrs(reopened)).toBe(structureKey);
      expect(reopened).toMatchObject({
        molecularDocumentReference: reference,
        molecularDocumentPath: newPath,
        molViewSpec: changedScene,
        molViewSpecSavedReferenceId: secondId,
      });
      expect(mocks.present).toHaveBeenCalledWith(
        expect.objectContaining({ entityId, initialStructureAttrs: reopened }),
        undefined
      );
    }
  );

  it('refuses to reuse live coordinates that differ from the exact saved revision', async () => {
    const attrs = setupTab();
    Object.assign(attrs, {
      molecularDocumentRevision: 'c'.repeat(64),
      molecularDocumentSavedReferenceId: secondId,
      molViewSpec: changedScene,
    });
    const host = document.createElement('div');
    host.dataset.structureAgentHost = entityId;
    const container = document.createElement('div');
    host.append(container);
    document.body.append(host);
    mocks.cache.set('different-coordinates', { container, plugin: {} });
    mocks.capture.mockReturnValue({
      scene: changedScene,
      coordinates: { ...baseline.coordinates, text: 'ATOM different' },
      pinnedAssets: [],
    });
    const native = saved();
    mocks.read.mockResolvedValue(native);
    const reference = {
      ...native.documentReference,
      revisionSha256: await molecularDocumentRevisionDigest(native.document.history[1].snapshot),
    };

    const result = await openMolecularDocument(newPath, { reference });

    expect(result.status).toBe('blocked');
    expect(mocks.present).not.toHaveBeenCalled();
    expect(mocks.structures[entityId].data).toEqual(attrs);
  });

  it('opens an exact document revision after its dirty tab closed even while its former registration remains cached', async () => {
    const attrs = setupTab(true);
    attrs.molViewSpec = baseline.scene.replace('[0,0,10]', '[0,0,99]');
    mocks.panels = {};
    const native = saved();
    mocks.read.mockResolvedValue(native);
    const reference = {
      ...native.documentReference,
      revisionSha256: await molecularDocumentRevisionDigest(native.document.history[1].snapshot),
    };
    const result = await openMolecularDocument(newPath, { reference });
    expect(result.status).toBe('presented');
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({
        initialStructureAttrs: expect.objectContaining({
          molViewSpec: changedScene,
          source: 'file',
          sourceId: baseline.coordinates.text,
          coordinateSha256: baseline.coordinates.sha256,
        }),
      }),
      undefined
    );
  });
  it('opens an exact historical document revision with its file ownership retained', async () => {
    mocks.read.mockResolvedValue(saved(oldPath));
    const request = { revisionId: firstId };
    await openMolecularDocument(oldPath, request);
    expect(mocks.present).toHaveBeenCalledWith(
      expect.objectContaining({
        initialStructureAttrs: expect.objectContaining({
          molViewSpec: baseline.scene,
          molViewSpecSavedReferenceId: firstId,
          molecularDocumentId: documentId,
          molecularDocumentPath: oldPath,
          molecularDocumentRevision: 'c'.repeat(64),
          molecularDocumentHistoricalRevisionId: firstId,
        }),
      }),
      undefined
    );
    expect(mocks.read).toHaveBeenCalledWith(oldPath, undefined);
  });

  it('refuses a revision absent from the authoritative file instead of opening its current view', async () => {
    mocks.read.mockResolvedValue(saved(oldPath));
    const request = { revisionId: '00000000-0000-4000-8000-000000000099' };
    await expect(openMolecularDocument(oldPath, request)).rejects.toThrow(/revision/i);
    expect(mocks.present).not.toHaveBeenCalled();
  });

  it('restores the saved selections stored in the view file ', async () => {
    const file = saved(newPath);
    mocks.read.mockResolvedValue({
      ...file,
      document: {
        ...file.document,
        selections: [{ id: 'selection-1', currentRevisionId: 'selection-revision-2' }],
      },
    });
    const result = await openMolecularDocument(newPath, {});
    expect(result.status).toBe('presented');
    expect(mocks.present.mock.calls[0][0].initialStructureAttrs.savedSelectionRefs).toEqual([
      {
        selectionId: 'selection-1',
        revisionId: 'selection-revision-2',
        artifactPath: 'moved.dnaforge-molecular.json',
        visible: true,
      },
    ]);
  });

  it('updates a moved file binding without replacing the working scene or camera', async () => {
    const attrs = setupTab(true);
    attrs.molViewSpec = changedScene;
    attrs.cameraSnapshot = '{"position":[0,0,20]}';
    const moved = saved(newPath, 'b'.repeat(64));
    moved.document.currentReferenceId = firstId;
    moved.document.history = [{ referenceId: firstId, snapshot: baseline }];
    mocks.read.mockResolvedValue(moved);
    await openMolecularDocument(newPath, {});
    expect(mocks.structures[entityId].data).toMatchObject({
      molecularDocumentPath: newPath,
      molecularDocumentRevision: 'b'.repeat(64),
      molViewSpec: changedScene,
      cameraSnapshot: '{"position":[0,0,20]}',
    });
    expect(mocks.panels.panel.tabs[0].initialStructureAttrs?.molecularDocumentPath).toBe(newPath);
    expect(mocks.panels.panel.tabs[0].isDirty).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('reloads the authoritative current snapshot when the open tab is clean', async () => {
    setupTab();
    mocks.read.mockResolvedValue(saved(oldPath));
    const result = await openMolecularDocument(oldPath, {});
    expect(result.status).toBe('presented');
    expect(mocks.structures[entityId].data).toMatchObject({
      molecularDocumentRevision: 'c'.repeat(64),
      molecularDocumentSavedReferenceId: secondId,
      molViewSpecSavedReferenceId: secondId,
      molViewSpec: changedScene,
    });
    expect(mocks.panels.panel.tabs[0].initialStructureAttrs).toEqual(
      mocks.structures[entityId].data
    );
    expect(mocks.panels.panel.tabs[0].isDirty).toBe(false);
  });

  it('reports a changed-file conflict and preserves unsaved working content', async () => {
    const attrs = setupTab(true);
    attrs.molViewSpec = changedScene.replace('[0,0,20]', '[0,0,30]');
    mocks.read.mockResolvedValue(saved(oldPath));
    const result = await openMolecularDocument(oldPath, {});
    expect(result).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/changed.*unsaved|unsaved.*changed/i),
    });
    expect(mocks.present).not.toHaveBeenCalled();
    expect(mocks.structures[entityId].data).toEqual(attrs);
    expect(mocks.structures[entityId].data.molecularDocumentRevision).toBe('b'.repeat(64));
  });

  it('detects native camera edits even when stored attrs and the tab dirty flag still match the baseline', async () => {
    const attrs = setupTab();
    const host = document.createElement('div');
    host.dataset.structureAgentHost = entityId;
    const container = document.createElement('div');
    host.append(container);
    document.body.append(host);
    mocks.cache.set('connected-host', { container, plugin: {} });
    mocks.capture.mockReturnValue({
      scene: changedScene,
      coordinates: baseline.coordinates,
      pinnedAssets: [],
    });
    mocks.read.mockResolvedValue(saved(oldPath));
    const result = await openMolecularDocument(oldPath, {});
    expect(result.status).toBe('blocked');
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.structures[entityId].data).toEqual(attrs);
    expect(mocks.present).not.toHaveBeenCalled();
  });

  it('does not use another molecular viewer as the current document dirty oracle', async () => {
    setupTab();
    const host = document.createElement('div');
    host.dataset.structureAgentHost = 'another-structure';
    const container = document.createElement('div');
    host.append(container);
    document.body.append(host);
    mocks.cache.set('unrelated-host', { container, plugin: {} });
    mocks.read.mockResolvedValue(saved(oldPath));
    expect((await openMolecularDocument(oldPath, {})).status).toBe('presented');
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

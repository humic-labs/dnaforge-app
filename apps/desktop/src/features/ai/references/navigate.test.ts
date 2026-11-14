import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBEntityReference } from '../../../db/entity-references';
import type { SequenceDocumentRef } from '../../../shared/managed-sequence-document';
import { useCanvasStore } from '../../canvas/store';
import { useStructure3dStore } from '../../page/embeds/structure3d/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { presentResolvedReference as navigateToReference } from './navigate';
import { coordinateDigest } from '../../page/public/embeds/structure3d/molecularView';
import { initializeTestSchema } from '../../../test/initializeTestSchema';
import { createEntityReference } from '../../../db/entity-references';
import {
  molecularDocumentRevisionDigest,
  type MolecularDocumentReference,
} from '../../../shared/molecular-document-reference';
import type { MolecularView } from '../../../shared/molecular-view';
import { initPlatform, platform } from '../../../platform';
import * as documentOpening from '../../document-opening/public/open-document';
import { openDesignDocument } from '../../design/public/open-design-document';
import { useDesignStore } from '../../design/public/store';

type NavigationDocumentFixture = {
  documentReference: MolecularDocumentReference;
  snapshot: MolecularView;
  catalogEntityId: string;
  saved: {
    path: string;
    workspaceRoot: string;
    document: { currentReferenceId: string };
  };
};

type OpenSequenceDocumentOptions = {
  label: string;
  strategy?: { kind: 'focused' | 'smart' } | { kind: 'panel'; panelId: string };
};

const TEST_SEQUENCE_DOCUMENT_ID = 'catalog-sequence:puc19';
const mocks = vi.hoisted(() => ({
  resolveSequenceDocumentById: vi.fn(),
  openSequenceDocument: vi.fn(),
  openSequenceFile: vi.fn(),
  resolveExactNativeCatalogDestination: vi.fn(),
  resolveLegacyMolecularDocumentReference: vi.fn(),
  openMolecularDocument: vi.fn(),
  documents: new Map<string, NavigationDocumentFixture>(),
}));

vi.mock('../../workspace-loader/public/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: async () => [],
}));

vi.mock('../../../services/native-catalog-destination', () => ({
  resolveExactNativeCatalogDestination: mocks.resolveExactNativeCatalogDestination,
}));

vi.mock('../../sequence/public/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sequence/public/sequence-document-repository')>()),
  resolveSequenceDocumentById: mocks.resolveSequenceDocumentById,
}));

vi.mock('../../document-opening/public/compat', () => ({
  openSequenceDocument: mocks.openSequenceDocument,
  openSequenceFile: mocks.openSequenceFile,
}));

vi.mock('../../molecular-documents/public/references', () => ({
  resolveLegacyMolecularDocumentReference: mocks.resolveLegacyMolecularDocumentReference,
}));
vi.mock('../../molecular-documents/public/open', () => ({
  openMolecularDocument: mocks.openMolecularDocument,
}));

function resetCanvasStore() {
  useCanvasStore.setState({
    panels: {
      main: { id: 'main', tabs: [], activeTabId: null },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
}

function sequenceRegionReference(overrides: Partial<DBEntityReference> = {}): DBEntityReference {
  return {
    id: 'ref-1',
    entity_type: 'sequence_region',
    display_label: 'AmpR promoter',
    locator: `entity://sequence/${TEST_SEQUENCE_DOCUMENT_ID}`,
    deep_link_params: JSON.stringify({ start: 1179, end: 1283 }),
    data: JSON.stringify({ documentId: TEST_SEQUENCE_DOCUMENT_ID }),
    source: 'ai',
    status: 'created',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const STRUCTURE_HIGHLIGHT_GROUPS = [
  {
    id: 'ask-ai-selection',
    label: 'Selected residues',
    color: '#ff6699',
    selections: [
      {
        chain: 'G',
        ranges: [
          [57, 57],
          [102, 102],
          [195, 195],
        ],
      },
    ],
  },
];

function structureReference(overrides: Partial<DBEntityReference> = {}): DBEntityReference {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    entity_type: 'structure',
    display_label: '1FS0 chain G residues 57, 102, 195',
    locator: 'structure:1FS0',
    deep_link_params: JSON.stringify({ highlightGroups: STRUCTURE_HIGHLIGHT_GROUPS }),
    data: null,
    source: 'user',
    status: 'created',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('resolved reference presentation', () => {
  beforeEach(() => {
    resetCanvasStore();
    mocks.documents.clear();
    mocks.resolveLegacyMolecularDocumentReference
      .mockReset()
      .mockImplementation(async (reference: DBEntityReference, snapshot: MolecularView) => {
        const documentReference: MolecularDocumentReference = {
          kind: 'molecular-document',
          version: 1,
          projectId: 'project',
          documentId: '10000000-0000-4000-8000-000000000001',
          revisionId: reference.id,
          revisionSha256: await molecularDocumentRevisionDigest(snapshot),
        };
        const resolved = {
          documentReference,
          snapshot,
          catalogEntityId: `project::${documentReference.documentId}`,
          saved: {
            path: '/workspace/lab/Molecular views/Verified.dnaforge-molecular.json',
            workspaceRoot: '/workspace/lab',
            document: { currentReferenceId: '30000000-0000-4000-8000-000000000001' },
          },
        };
        mocks.documents.set(resolved.saved.path, resolved);
        return resolved;
      });
    mocks.openMolecularDocument.mockReset().mockImplementation(
      async (
        path: string,
        options: {
          reference: MolecularDocumentReference;
          placement: { kind: 'panel'; panelId: string };
        }
      ) => {
        const document = mocks.documents.get(path);
        if (!document) throw Error('The opener received an unverified fixture document path.');
        const entityId = `molecular-document:${document.catalogEntityId}@${options.reference.revisionId}`;
        const panelId = options.placement.panelId;
        const existing = useCanvasStore.getState().findTab('structure', entityId);
        const tabId =
          existing?.tabId ??
          useCanvasStore.getState().openTab(panelId, {
            type: 'structure',
            entityId,
            label: document.snapshot.title,
          });
        return {
          status: 'presented',
          panelId,
          tabId,
          disposition: existing ? 'reused' : 'created',
        };
      }
    );
    mocks.openSequenceFile.mockReset();
    mocks.resolveExactNativeCatalogDestination.mockReset();
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace/lab', name: 'lab', addedAt: 0 }],
      activeWorkspaceFile: null,
    });
    useStructure3dStore.setState({
      expandedStructures: {},
      interactionState: {},
      selectionAnchor: {},
      selectionRangeBase: {},
    });
    const ref: SequenceDocumentRef = {
      kind: 'catalog-sequence',
      entityId: TEST_SEQUENCE_DOCUMENT_ID,
    };
    mocks.resolveSequenceDocumentById.mockReset().mockResolvedValue({
      ref,
      documentId: TEST_SEQUENCE_DOCUMENT_ID,
      sourcePath: '/workspace/lab/plasmids/pUC19.gb',
    });
    mocks.openSequenceDocument
      .mockReset()
      .mockImplementation(
        async (document: SequenceDocumentRef, options: OpenSequenceDocumentOptions) => {
          const existing = useCanvasStore.getState().findTab('sequence', TEST_SEQUENCE_DOCUMENT_ID);
          if (existing) {
            useCanvasStore.getState().retargetTab(existing.panelId, existing.tabId, {
              type: 'sequence',
              sequenceDocument: document,
            });
            return existing.tabId;
          }
          const panelId = options.strategy?.kind === 'panel' ? options.strategy.panelId : 'main';
          return useCanvasStore.getState().openTab(panelId, {
            type: 'sequence',
            entityId: TEST_SEQUENCE_DOCUMENT_ID,
            label: options.label,
            sequenceDocument: document,
          });
        }
      );
  });

  it('accepts a saved unbound oligo while its real editor loads and retains its artifact owner', async () => {
    const path = '/workspace/lab/primers/standalone.primer.json';
    await initPlatform();
    vi.spyOn(platform().fs, 'stat').mockResolvedValueOnce({
      canonicalPath: path,
      size: 2,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
      mtimeNs: '1000000',
      ctimeNs: '1000000',
    });
    mocks.resolveExactNativeCatalogDestination.mockResolvedValue({
      entityId: 'canonical-primer',
      locator: { kind: 'workspace_path', absolutePath: path },
    });
    const result = await navigateToReference(
      sequenceRegionReference({
        entity_type: 'primer',
        display_label: 'Standalone',
        locator: 'entity://primer/canonical-primer',
        deep_link_params: null,
        workspace_root_path: '/workspace/lab',
        data: JSON.stringify({ primerId: 'canonical-primer' }),
      })
    );
    expect(result).toMatchObject({ tabType: 'primer', entityId: path, created: true });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([
      expect.objectContaining({
        type: 'primer',
        entityId: path,
        artifactDocument: expect.objectContaining({
          workspaceRoot: '/workspace/lab',
          artifactPath: path,
          persistence: 'persisted',
        }),
      }),
    ]);
  });

  it('opens a saved-file assembly reference through the native design owner', async () => {
    await initPlatform();
    const id = useDesignStore.getState().createDesign('TamB expression construct');
    const design = useDesignStore.getState().designs[id];
    useDesignStore.setState({ designs: {}, activeDesignId: null });
    const path = '/workspace/lab/TamB expression construct.wpdesign.json';
    const exists = vi.spyOn(platform().fs, 'exists').mockResolvedValueOnce(true);
    const open = vi.spyOn(documentOpening, 'openDocument').mockImplementationOnce(async (request) =>
      openDesignDocument({
        artifact: {
          schema: 'waypoint.design.v1',
          kind: 'assembly-design',
          id,
          name: design.name,
          design,
          raw: {},
        },
        entityId: id,
        label: request.label,
        placement: request.placement,
      })
    );
    try {
      const result = await navigateToReference(
        sequenceRegionReference({
          entity_type: 'assembly',
          display_label: design.name,
          locator: 'git://lab/TamB expression construct.wpdesign.json',
          workspace_root_path: '/workspace/lab',
          deep_link_params: JSON.stringify({ designId: id, projectId: 'lab-project' }),
          data: JSON.stringify({ designId: id, projectId: 'lab-project', version: design.version }),
        })
      );
      expect(result).toMatchObject({ tabType: 'design', entityId: id, created: true });
      expect(open).toHaveBeenCalledWith({
        target: { kind: 'file', path, tabType: 'design' },
        label: design.name,
        placement: { kind: 'panel', panelId: 'main' },
      });
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([
        expect.objectContaining({ type: 'design', entityId: id, label: design.name }),
      ]);
      expect(useDesignStore.getState().designs[id]).toEqual(design);
      expect(useDesignStore.getState().designs[path]).toBeUndefined();
    } finally {
      open.mockRestore();
      exists.mockRestore();
    }
  });

  it('refuses a missing saved-file assembly without opening an empty design tab', async () => {
    await initPlatform();
    const exists = vi.spyOn(platform().fs, 'exists').mockResolvedValueOnce(false);
    const open = vi.spyOn(documentOpening, 'openDocument');
    try {
      await expect(
        navigateToReference(
          sequenceRegionReference({
            entity_type: 'assembly',
            display_label: 'Missing saved assembly',
            locator: 'git://lab/Missing.wpdesign.json',
            workspace_root_path: '/workspace/lab',
            deep_link_params: null,
            data: null,
          })
        )
      ).rejects.toThrow('unavailable');
      expect(open).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    } finally {
      open.mockRestore();
      exists.mockRestore();
    }
  });

  it('restores a historical view from pinned bytes and MVS beside the originating chat', async () => {
    const text = 'HEADER PINNED VIEW\nEND\n';
    const entityId = 'saved-view:original';
    const ref = structureReference({
      locator: `entity://structure/${entityId}`,
      deep_link_params: null,
      data: JSON.stringify({
        kind: 'molecular-view',
        version: 1,
        title: 'Saved pocket',
        caption: 'Original framing',
        scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
        coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
        source: { source: 'pdb', sourceId: '1IEP' },
        evidence: [],
        preview: 'data:image/png;base64,AAAA',
        createdAt: 1,
      }),
    });
    useCanvasStore.getState().openTab('main', { type: 'chat', entityId: 'chat-1', label: 'Chat' });
    const opened = await navigateToReference(ref, { sourceChatConversationId: 'chat-1' });
    const tab = useCanvasStore
      .getState()
      .panels[opened.panelId].tabs.find((t) => t.id === opened.tabId)!;
    expect(opened.panelId).not.toBe('main');
    expect(tab.entityId).toBe(
      `molecular-document:project::10000000-0000-4000-8000-000000000001@${ref.id}`
    );
    expect(mocks.openMolecularDocument).toHaveBeenCalledWith(
      '/workspace/lab/Molecular views/Verified.dnaforge-molecular.json',
      expect.objectContaining({
        revisionId: ref.id,
        reference: expect.objectContaining({ documentId: '10000000-0000-4000-8000-000000000001' }),
        placement: { kind: 'panel', panelId: opened.panelId },
      })
    );
    expect(mocks.resolveLegacyMolecularDocumentReference).toHaveBeenCalledWith(
      ref,
      JSON.parse(ref.data!),
      { sourceChatConversationId: 'chat-1' }
    );
    useStructure3dStore
      .getState()
      .registerStructure(
        entityId,
        { source: 'pdb', sourceId: '1FS0', molViewSpec: 'newer scene' },
        'newer view'
      );
    await navigateToReference(ref, { sourceChatConversationId: 'chat-1' });
    expect(useStructure3dStore.getState().expandedStructures[entityId].data).toMatchObject({
      sourceId: '1FS0',
      molViewSpec: 'newer scene',
    });
    expect(useCanvasStore.getState().findTab('structure', entityId)).toBeNull();
    const openCount = mocks.openMolecularDocument.mock.calls.length;
    mocks.resolveLegacyMolecularDocumentReference.mockRejectedValueOnce(
      Error('This legacy molecular view has no verified document owner.')
    );
    await expect(navigateToReference(ref)).rejects.toThrow('no verified document owner');
    expect(mocks.openMolecularDocument).toHaveBeenCalledTimes(openCount);
  });

  it('opens the chat-selected story step without mutating the saved initial step', async () => {
    const text = 'HEADER STORY VIEW\nEND\n';
    const data = {
      kind: 'molecular-view',
      version: 1,
      title: 'Saved story',
      caption: '',
      scene: JSON.stringify({
        kind: 'multiple',
        snapshots: [
          { root: { kind: 'root' }, metadata: { title: 'Overview' } },
          { root: { kind: 'root' }, metadata: { title: 'Detail' } },
        ],
      }),
      initialSnapshotIndex: 1,
      coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
      source: {},
      evidence: [],
      preview: 'data:image/png;base64,AAAA',
      createdAt: 1,
    };
    const ref = structureReference({
      locator: 'entity://structure/saved-view:story',
      data: JSON.stringify(data),
    });
    useCanvasStore.getState().openTab('main', { type: 'chat', entityId: 'chat-1', label: 'Chat' });
    const selected = await navigateToReference(ref, {
      sourceChatConversationId: 'chat-1',
      snapshotIndex: 0,
    });
    expect(mocks.openMolecularDocument).toHaveBeenLastCalledWith(
      '/workspace/lab/Molecular views/Verified.dnaforge-molecular.json',
      expect.objectContaining({ snapshotIndex: 0, revisionId: ref.id })
    );
    await navigateToReference(ref, { sourceChatConversationId: 'chat-1' });
    expect(mocks.openMolecularDocument).toHaveBeenLastCalledWith(
      '/workspace/lab/Molecular views/Verified.dnaforge-molecular.json',
      expect.objectContaining({ snapshotIndex: undefined, revisionId: ref.id })
    );
    expect(useCanvasStore.getState().panels[selected.panelId].tabs).toHaveLength(1);
    expect(JSON.parse(ref.data!).initialSnapshotIndex).toBe(1);
  });

  it('opens a stable-ID-only view target at its exact saved position after reordering', async () => {
    await initializeTestSchema();
    const text = 'HEADER STABLE VIEW\nEND\n';
    const parent = await createEntityReference({
      entityType: 'structure',
      displayLabel: 'Reordered scene',
      locator: `entity://structure/saved-view:${crypto.randomUUID()}`,
      deepLinkParams: null,
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
      data: {
        kind: 'molecular-view',
        version: 1,
        title: 'Reordered scene',
        caption: '',
        scene: JSON.stringify({
          kind: 'multiple',
          snapshots: [
            { metadata: { key: 'detail', title: 'Detail' }, root: { kind: 'root' } },
            { metadata: { key: 'overview', title: 'Overview' }, root: { kind: 'root' } },
          ],
        }),
        coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
        source: {},
        evidence: [],
        preview: 'data:image/png;base64,AAAA',
        createdAt: 1,
      },
    });
    const target = await createEntityReference({
      entityType: 'structure',
      displayLabel: 'Overview',
      locator: `entity://molecular-view-target/${parent.id}/overview/view`,
      deepLinkParams: null,
      data: {
        kind: 'molecular-view-target',
        version: 1,
        viewReferenceId: parent.id,
        viewId: 'overview',
      },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    const opened = await navigateToReference(target);
    expect(opened.entityId).toMatch(/^molecular-document:/);
    expect(mocks.openMolecularDocument).toHaveBeenCalledWith(
      '/workspace/lab/Molecular views/Verified.dnaforge-molecular.json',
      expect.objectContaining({ viewId: 'overview', snapshotIndex: 1, revisionId: parent.id })
    );
    expect(JSON.parse(parent.data!).initialSnapshotIndex).toBeUndefined();
    const invalid = {
      ...target,
      locator: `entity://molecular-view-target/${parent.id}/missing/view`,
      data: JSON.stringify({ ...JSON.parse(target.data!), viewId: 'missing', snapshotIndex: 0 }),
    };
    await expect(navigateToReference(invalid)).rejects.toThrow(/missing|ambiguous|exist/i);
  });

  it('blocks invalid historical view data before creating a tab', async () => {
    await expect(
      navigateToReference(
        structureReference({
          locator: 'entity://structure/saved-view:broken',
          data: '{"kind":"molecular-view","version":2}',
        })
      )
    ).rejects.toThrow('unsupported');
    expect(useCanvasStore.getState().findTab('structure', 'saved-view:broken')).toBeNull();
  });

  it('opens a thin whole-view chat attachment from the durable saved snapshot', async () => {
    await initializeTestSchema();
    const text = 'HEADER CHAT CONTEXT\nEND\n';
    const locator = 'entity://structure/saved-view:chat-context';
    const params = {
      entityType: 'structure',
      displayLabel: 'Chat context',
      locator,
      deepLinkParams: null,
      source: 'user',
      workspaceScope: null,
      workspaceRootPath: null,
    };
    await createEntityReference({
      ...params,
      data: {
        kind: 'molecular-view',
        version: 1,
        title: 'Original view',
        caption: '',
        scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
        coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
        source: {},
        evidence: [],
        preview: 'data:image/png;base64,AAAA',
        createdAt: 1,
      },
    });

    const attachment = structureReference({ ...params, data: null, entity_type: 'structure' });
    const opened = await navigateToReference(attachment);
    expect(opened.entityId).toMatch(/^molecular-document:/);
    expect(opened.label).toBe('Original view');
    expect(mocks.resolveLegacyMolecularDocumentReference).toHaveBeenCalledWith(
      expect.objectContaining({ locator }),
      expect.objectContaining({
        title: 'Original view',
        coordinates: expect.objectContaining({ text }),
      }),
      {}
    );
  });

  it('keeps a source notebook open while opening its structure view in an adjacent panel', async () => {
    useCanvasStore.getState().openTab('main', {
      type: 'page',
      entityId: 'benchmark-notebook',
      label: 'Structure benchmarks',
    });
    const opened = await navigateToReference(structureReference(), {
      sourceNotebookPageId: 'benchmark-notebook',
    });
    expect(opened.panelId).not.toBe('main');
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([
      expect.objectContaining({ type: 'page', entityId: 'benchmark-notebook' }),
    ]);
    expect(useCanvasStore.getState().panels[opened.panelId].tabs).toEqual([
      expect.objectContaining({ type: 'structure', entityId: opened.entityId }),
    ]);
  });

  it('opens a new tab with pending deep-link state', async () => {
    const result = await navigateToReference(sequenceRegionReference());

    expect(result.created).toBe(true);
    expect(result.entityId).toBe(TEST_SEQUENCE_DOCUMENT_ID);
    expect(result.tab).toMatchObject({
      id: result.tabId,
      type: 'sequence',
      entityId: TEST_SEQUENCE_DOCUMENT_ID,
      label: 'AmpR promoter',
      viewState: {
        scrollPosition: 1179,
        highlightRange: { start: 1178, end: 1282 },
      },
    });
  });

  it('restricts a saved sequence origin to its owning project', async () => {
    const savedOrigin = '/workspace/saved-origin';

    await navigateToReference(
      sequenceRegionReference({
        workspace_root_path: savedOrigin,
      })
    );

    expect(mocks.resolveSequenceDocumentById).toHaveBeenCalledWith(TEST_SEQUENCE_DOCUMENT_ID, [
      savedOrigin,
    ]);
  });

  it('splits a chat-only canvas and opens the reference outside chat', async () => {
    const chatTabId = useCanvasStore.getState().openTab('main', {
      type: 'chat',
      entityId: 'conversation-1',
      label: 'Chat',
    });

    const result = await navigateToReference(sequenceRegionReference());
    const state = useCanvasStore.getState();

    expect(result.created).toBe(true);
    expect(result.panelId).not.toBe('main');
    expect(state.panels.main.tabs.map((tab) => tab.id)).toEqual([chatTabId]);
    expect(state.panels[result.panelId].tabs[0]).toMatchObject({
      id: result.tabId,
      type: 'sequence',
    });
  });

  it('splits first and moves an already-open asset out of the sole full-chat pane', async () => {
    const chatTabId = useCanvasStore.getState().openTab('main', {
      type: 'chat',
      entityId: 'conversation-1',
      label: 'Chat',
    });
    const existingTabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: TEST_SEQUENCE_DOCUMENT_ID,
      label: 'pUC19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: TEST_SEQUENCE_DOCUMENT_ID },
    });
    useCanvasStore.getState().setActiveTab('main', chatTabId);

    const result = await navigateToReference(sequenceRegionReference(), {
      sourceChatConversationId: 'conversation-1',
    });
    const state = useCanvasStore.getState();

    expect(result.created).toBe(false);
    expect(result.tabId).toBe(existingTabId);
    expect(result.movedFromPanelId).toBe('main');
    expect(result.panelId).not.toBe('main');
    expect(Object.keys(state.panels)).toHaveLength(2);
    expect(state.panels.main.tabs.map((tab) => tab.id)).toEqual([chatTabId]);
    expect(state.panels.main.activeTabId).toBe(chatTabId);
    expect(state.panels[result.panelId].activeTabId).toBe(existingTabId);
  });

  it('moves a legacy path reference after the file boundary resolves an already-open document', async () => {
    const chatTabId = useCanvasStore.getState().openTab('main', {
      type: 'chat',
      entityId: 'conversation-1',
      label: 'Chat',
    });
    const existingTabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: TEST_SEQUENCE_DOCUMENT_ID,
      label: 'pUC19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: TEST_SEQUENCE_DOCUMENT_ID },
    });
    useCanvasStore.getState().setActiveTab('main', chatTabId);
    mocks.openSequenceFile.mockImplementation(async () => {
      useCanvasStore.getState().setActiveTab('main', existingTabId);
      return existingTabId;
    });

    const result = await navigateToReference(
      sequenceRegionReference({
        locator: 'git://lab/plasmids/pUC19.gb',
        data: null,
      }),
      { sourceChatConversationId: 'conversation-1' }
    );
    const state = useCanvasStore.getState();

    expect(result.panelId).not.toBe('main');
    expect(result.created).toBe(false);
    expect(result.entityId).toBe(TEST_SEQUENCE_DOCUMENT_ID);
    expect(result.tabId).toBe(existingTabId);
    expect(result.movedFromPanelId).toBe('main');
    expect(state.panels.main.tabs.map((tab) => tab.id)).toEqual([chatTabId]);
    expect(state.panels.main.activeTabId).toBe(chatTabId);
    expect(state.panels[result.panelId].activeTabId).toBe(existingTabId);
    expect(result.tab?.viewState?.highlightRange).toEqual({ start: 1178, end: 1282 });
    expect(mocks.openSequenceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/workspace/lab/plasmids/pUC19.gb',
      })
    );
  });

  it('uses the exact source conversation instead of the first chat tab', async () => {
    const secondPanelId = useCanvasStore.getState().splitPanel('main', 'vertical');
    useCanvasStore.getState().openTab('main', {
      type: 'chat',
      entityId: 'conversation-1',
      label: 'First chat',
    });
    const sourceChatTabId = useCanvasStore.getState().openTab(secondPanelId, {
      type: 'chat',
      entityId: 'conversation-2',
      label: 'Second chat',
    });
    const existingTabId = useCanvasStore.getState().openTab(secondPanelId, {
      type: 'sequence',
      entityId: TEST_SEQUENCE_DOCUMENT_ID,
      label: 'pUC19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: TEST_SEQUENCE_DOCUMENT_ID },
    });
    useCanvasStore.getState().setActiveTab(secondPanelId, sourceChatTabId);

    const result = await navigateToReference(sequenceRegionReference(), {
      sourceChatConversationId: 'conversation-2',
    });
    const state = useCanvasStore.getState();

    expect(result.created).toBe(false);
    expect(result.tabId).toBe(existingTabId);
    expect(result.movedFromPanelId).toBe(secondPanelId);
    expect(result.panelId).toBe('main');
    expect(state.panels[secondPanelId].activeTabId).toBe(sourceChatTabId);
    expect(state.panels.main.activeTabId).toBe(existingTabId);
  });

  it('focuses an existing tab and applies deep-link state without duplicating it', async () => {
    const existingTabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: TEST_SEQUENCE_DOCUMENT_ID,
      label: 'pUC19',
      sequenceDocument: { kind: 'catalog-sequence', entityId: TEST_SEQUENCE_DOCUMENT_ID },
    });

    const result = await navigateToReference(sequenceRegionReference());
    const state = useCanvasStore.getState();

    expect(result.created).toBe(false);
    expect(result.tabId).toBe(existingTabId);
    expect(state.panels.main.tabs).toHaveLength(1);
    expect(state.panels.main.activeTabId).toBe(existingTabId);
    expect(state.panels.main.tabs[0].viewState).toEqual({
      scrollPosition: 1179,
      highlightRange: { start: 1178, end: 1282 },
    });
    expect(mocks.resolveSequenceDocumentById).toHaveBeenCalledWith(TEST_SEQUENCE_DOCUMENT_ID, [
      '/workspace/lab',
    ]);
    expect(mocks.openSequenceDocument).toHaveBeenCalled();
  });

  it('applies a resolved structure reference highlight to the live structure store', async () => {
    useStructure3dStore
      .getState()
      .registerStructure(
        'structure:1FS0',
        { source: 'file', sourceId: '1FS0', label: '1FS0', highlightGroups: [] },
        '1FS0'
      );
    useCanvasStore.getState().openTab('main', {
      type: 'structure',
      entityId: 'structure:1FS0',
      label: '1FS0',
    });

    await navigateToReference(structureReference());

    expect(
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups
    ).toEqual(STRUCTURE_HIGHLIGHT_GROUPS);
  });

  it('replaces stale transient residue selection before applying a structure reference', async () => {
    useStructure3dStore
      .getState()
      .registerStructure(
        'structure:1FS0',
        { source: 'file', sourceId: '1FS0', label: '1FS0', highlightGroups: [] },
        '1FS0'
      );
    useStructure3dStore.getState().setSelected('structure:1FS0', [
      {
        chain: 'G',
        position: 58,
        authAsymId: 'G',
        labelAsymId: 'G',
      },
    ]);
    useCanvasStore.getState().openTab('main', {
      type: 'structure',
      entityId: 'structure:1FS0',
      label: '1FS0',
    });

    await navigateToReference(structureReference());

    expect(useStructure3dStore.getState().interactionState['structure:1FS0']?.selected).toEqual([]);
    expect(
      useStructure3dStore.getState().expandedStructures['structure:1FS0']?.data.highlightGroups
    ).toEqual(STRUCTURE_HIGHLIGHT_GROUPS);
  });

  it('carries structure highlight deep links into a newly opened tab payload', async () => {
    useStructure3dStore
      .getState()
      .registerStructure(
        'structure:1FS0',
        { source: 'file', sourceId: '1FS0', label: '1FS0', highlightGroups: [] },
        '1FS0'
      );

    const result = await navigateToReference(structureReference());
    const tab = useCanvasStore
      .getState()
      .panels[result.panelId]?.tabs.find((candidate) => candidate.id === result.tabId);

    expect(tab?.initialStructureAttrs).toMatchObject({
      source: 'file',
      sourceId: '1FS0',
      highlightGroups: STRUCTURE_HIGHLIGHT_GROUPS,
    });
  });
});

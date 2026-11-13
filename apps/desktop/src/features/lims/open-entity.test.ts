import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsOpenTarget } from './open-target';

const mocks = vi.hoisted(() => ({
  resolveLimsEntityOpenTarget: vi.fn(),
  getLimsEntityById: vi.fn(),
  getCurrentCatalogFileForEntity: vi.fn(),
  resolveProteinEntityArtifactRevision: vi.fn(),
  openSequenceDocument: vi.fn(),
  openSequenceFile: vi.fn(),
  resolveSequenceDocumentById: vi.fn(),
  openManagedSequenceDocument: vi.fn(),
  resolveManagedSequenceDocument: vi.fn(),
  findManagedSequenceById: vi.fn(),
  setTabViewState: vi.fn(),
  openDocument: vi.fn(),
  getCatalogFilesForEntity: vi.fn(),
  getWorkspaceRootById: vi.fn(),
  readPrimerArtifactAtPath: vi.fn(),
  openWithSmartPlacement: vi.fn(),

  canvasState: { panels: {} as Record<string, { id: string; tabs: Array<{ id: string }> }> },
}));

vi.mock('../document-opening/open-document', () => ({ openDocument: mocks.openDocument }));

vi.mock('../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-catalog')>()),
  getCatalogFilesForEntity: mocks.getCatalogFilesForEntity,
  getWorkspaceRootById: mocks.getWorkspaceRootById,
  getCurrentCatalogFileForEntity: mocks.getCurrentCatalogFileForEntity,
}));

vi.mock('../primers/primer-services', () => ({
  primerServices: { persistence: { readArtifactAtPath: mocks.readPrimerArtifactAtPath } },
}));

vi.mock('../document-opening/compat', () => ({
  openSequenceDocument: mocks.openSequenceDocument,
  openManagedSequenceDocument: mocks.openManagedSequenceDocument,
  openSequenceFile: mocks.openSequenceFile,
}));

vi.mock('../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mocks.resolveSequenceDocumentById,
}));

vi.mock('../sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    resolve: mocks.resolveManagedSequenceDocument,
    findById: mocks.findManagedSequenceById,
  },
}));

vi.mock('./open-target', () => ({
  resolveLimsEntityOpenTarget: mocks.resolveLimsEntityOpenTarget,
  getLimsEntityById: mocks.getLimsEntityById,
}));

vi.mock('../proteins/save-protein-sequence', () => ({
  resolveProteinEntityArtifactRevision: mocks.resolveProteinEntityArtifactRevision,
}));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ folders: [{ path: '/workspace' }] }),
  },
}));

vi.mock('../canvas/store', () => ({
  useCanvasStore: {
    getState: () => ({
      panels: mocks.canvasState.panels,
      setTabViewState: mocks.setTabViewState,
      openWithSmartPlacement: mocks.openWithSmartPlacement,
    }),
  },
}));

import { isLimsEntityOpened, openLimsEntity } from './open-entity';
import { PrimerPublicationPendingError } from '../primers/public/primer-artifact-service';
import { primerBindingToViewState } from '../sequence/primer-binding-viewstate';

describe('openLimsEntity', () => {
  beforeEach(() => {
    mocks.resolveLimsEntityOpenTarget.mockReset();
    mocks.getLimsEntityById.mockReset();
    mocks.getCurrentCatalogFileForEntity.mockReset();
    mocks.resolveProteinEntityArtifactRevision.mockReset();
    mocks.openSequenceDocument.mockReset();
    mocks.openSequenceFile.mockReset();
    mocks.resolveSequenceDocumentById.mockReset();
    mocks.openManagedSequenceDocument.mockReset();
    mocks.resolveManagedSequenceDocument.mockReset();
    mocks.findManagedSequenceById.mockReset();
    mocks.setTabViewState.mockReset();
    mocks.openDocument.mockReset();
    mocks.getCatalogFilesForEntity.mockReset();
    mocks.getWorkspaceRootById.mockReset();
    mocks.readPrimerArtifactAtPath.mockReset();
    mocks.openWithSmartPlacement.mockReset();
    mocks.canvasState.panels = {};
    mocks.resolveSequenceDocumentById.mockImplementation(async (documentId: string) => ({
      documentId,
      sourcePath: '/fixtures/pUC19.gb',
      ref: { kind: 'catalog-sequence', entityId: documentId },
    }));
  });

  it('routes a saved generic record through the verified document opener without changing identity', async () => {
    const controller = new AbortController();
    const target = {
      kind: 'record_file',
      entityId: 'saved-record',
      entityKind: 'strain',
      label: 'Saved record',
      workspaceId: 7,
      artifactRelativePath: 'records/saved.entity.json',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValue(target);
    mocks.openDocument.mockResolvedValue({ status: 'presented', tabId: 'record-tab' });
    const result = await openLimsEntity({ entityId: target.entityId, signal: controller.signal });
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'record', tabType: 'record', entityId: target.entityId },
      label: target.label,
      placement: { kind: 'focused' },
      signal: controller.signal,
    });
    expect(result).toEqual({ status: 'opened_record', tabId: 'record-tab', target });
    expect(isLimsEntityOpened(result)).toBe(true);
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('does not look up or open a request that was already cancelled', async () => {
    const controller = new AbortController();
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce({
      kind: 'record_file',
      entityId: 'saved-record',
      entityKind: 'strain',
      label: 'Saved record',
      workspaceId: 7,
      artifactRelativePath: 'records/saved.entity.json',
    });
    mocks.openDocument.mockResolvedValueOnce({ status: 'presented', tabId: 'record-tab' });
    controller.abort();

    const result = await openLimsEntity({ entityId: 'saved-record', signal: controller.signal });

    expect(result).toEqual({ status: 'not_opened', target: null, message: 'Opening cancelled.' });
    expect(isLimsEntityOpened(result)).toBe(false);
    expect(mocks.resolveLimsEntityOpenTarget).not.toHaveBeenCalled();
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it('does not present a notebook when its context is cancelled during target lookup', async () => {
    const controller = new AbortController();
    const target: LimsOpenTarget = {
      kind: 'notebook',
      entityId: 'ws1::page-1',
      entityKind: 'notebook',
      label: 'Miniprep',
      filePath: '/lab/Miniprep',
    };
    let finishLookup!: (target: LimsOpenTarget) => void;
    mocks.resolveLimsEntityOpenTarget.mockReturnValueOnce(
      new Promise<LimsOpenTarget>((resolve) => {
        finishLookup = resolve;
      })
    );
    const opening = openLimsEntity({ entityId: target.entityId, signal: controller.signal });

    controller.abort();
    finishLookup(target);

    await expect(opening).resolves.toEqual({
      status: 'not_opened',
      target,
      message: 'Opening cancelled.',
    });
    expect(mocks.openWithSmartPlacement).not.toHaveBeenCalled();
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it('stops primer preparation when cancelled while its current file binding is loading', async () => {
    const controller = new AbortController();
    const target: LimsOpenTarget = {
      kind: 'primer',
      entityId: 'saved-primer',
      entityKind: 'oligo',
      label: 'Saved primer',
      workspaceId: 7,
      artifactRelativePath: 'saved.primer.json',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    let finishBindings!: (bindings: []) => void;
    mocks.getCatalogFilesForEntity.mockReturnValueOnce(
      new Promise<[]>((resolve) => {
        finishBindings = resolve;
      })
    );
    mocks.getWorkspaceRootById.mockResolvedValueOnce('/workspace');
    mocks.readPrimerArtifactAtPath.mockResolvedValueOnce({
      artifact: { id: 'saved-primer', registry: { entityId: 'saved-primer' } },
    });
    mocks.openDocument.mockResolvedValueOnce({ status: 'presented', tabId: 'primer-tab' });
    const opening = openLimsEntity({ entityId: target.entityId, signal: controller.signal });
    await vi.waitFor(() => expect(mocks.getCatalogFilesForEntity).toHaveBeenCalledOnce());

    controller.abort();
    finishBindings([]);

    await expect(opening).resolves.toEqual({
      status: 'not_opened',
      target,
      message: 'Opening cancelled.',
    });
    expect(mocks.getWorkspaceRootById).not.toHaveBeenCalled();
    expect(mocks.readPrimerArtifactAtPath).not.toHaveBeenCalled();
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it('reports saved-record opening refusal without claiming a tab opened', async () => {
    const target = {
      kind: 'record_file',
      entityId: 'saved-record',
      entityKind: 'strain',
      label: 'Saved record',
      workspaceId: 7,
      artifactRelativePath: 'records/saved.entity.json',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValue(target);
    mocks.openDocument.mockResolvedValue({
      status: 'blocked',
      message: 'The saved file identity does not match.',
    });
    const result = await openLimsEntity({ entityId: target.entityId });
    expect(result).toEqual({
      status: 'not_opened',
      target,
      message: 'The saved file identity does not match.',
    });
    expect(isLimsEntityOpened(result)).toBe(false);
  });

  it('opens the current saved primer artifact through the common opener, preserving its identity', async () => {
    const target = {
      kind: 'primer',
      entityId: 'saved-primer',
      entityKind: 'oligo',
      label: 'Saved primer',
      workspaceId: 7,
      artifactRelativePath: 'old/location.primer.json',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.getCatalogFilesForEntity.mockResolvedValueOnce([
      {
        entity_id: 'saved-primer',
        workspace_id: 7,
        path: '/workspace/moved.primer.json',
        file_kind: 'primer-artifact',
        status: 'current',
      },
    ]);
    mocks.getWorkspaceRootById.mockResolvedValue('/workspace');
    mocks.readPrimerArtifactAtPath.mockResolvedValue({
      artifact: { id: 'saved-primer', registry: { entityId: 'saved-primer' } },
    });
    mocks.openDocument.mockResolvedValueOnce({ status: 'presented', tabId: 'primer-tab' });

    const result = await openLimsEntity({
      entityId: 'saved-primer',
      strategy: { kind: 'focused' },
    });

    expect(result).toMatchObject({ status: 'opened_primer', tabId: 'primer-tab', target });
    expect(isLimsEntityOpened(result)).toBe(true);
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/workspace/moved.primer.json', tabType: 'primer' },
      label: 'Saved primer',
      placement: { kind: 'focused' },
    });
  });

  it.each([true, false])(
    'only opens pending primer recovery for the matching current identity (%s)',
    async (sameIdentity) => {
      const entityId = '10000000-0000-4000-8000-000000000045';
      mocks.resolveLimsEntityOpenTarget.mockResolvedValue({
        kind: 'primer',
        entityId,
        entityKind: 'oligo',
        label: 'Saved primer',
        workspaceId: 7,
        artifactRelativePath: 'old.primer.json',
      });
      mocks.getCatalogFilesForEntity.mockResolvedValue([
        {
          entity_id: entityId,
          workspace_id: 7,
          path: '/workspace/moved.primer.json',
          file_kind: 'primer-artifact',
          status: 'current',
        },
      ]);
      mocks.getWorkspaceRootById.mockResolvedValue('/workspace');
      mocks.readPrimerArtifactAtPath.mockRejectedValue(
        new PrimerPublicationPendingError({
          state: 'pending',
          entityId: sameIdentity ? entityId : '10000000-0000-4000-8000-000000000046',
          operationId: '20000000-0000-4000-8000-000000000045',
          workspaceId: 7,
          relativePath: 'moved.primer.json',
          name: 'Saved primer',
          artifactRevision: 2,
        })
      );
      mocks.openDocument.mockResolvedValue({ status: 'presented', tabId: 'primer-retry-tab' });
      const result = await openLimsEntity({ entityId });
      if (sameIdentity) {
        expect(result).toMatchObject({ status: 'opened_primer', tabId: 'primer-retry-tab' });
        expect(mocks.openDocument).toHaveBeenCalledWith({
          target: { kind: 'file', path: '/workspace/moved.primer.json', tabType: 'primer' },
          label: 'Saved primer',
          placement: { kind: 'focused' },
        });
      } else {
        expect(result.status).toBe('not_opened');
        expect(mocks.openDocument).not.toHaveBeenCalled();
      }
    }
  );

  it('refuses a mismatched primer file instead of opening an unrelated record', async () => {
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce({
      kind: 'primer',
      entityId: 'saved-primer',
      entityKind: 'oligo',
      label: 'Saved primer',
      workspaceId: 7,
      artifactRelativePath: 'saved.primer.json',
    });
    mocks.getCatalogFilesForEntity.mockResolvedValueOnce([]);
    mocks.getWorkspaceRootById.mockResolvedValueOnce('/workspace');
    mocks.readPrimerArtifactAtPath.mockResolvedValueOnce({
      artifact: { id: 'other-primer', registry: { entityId: 'other-primer' } },
    });

    const result = await openLimsEntity({ entityId: 'saved-primer' });

    expect(result).toMatchObject({
      status: 'not_opened',
      message: expect.stringMatching(/identity/i),
    });
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it('opens file-backed LIMS entities through the guarded sequence file opener', async () => {
    const target = sequenceFileTarget();
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openSequenceDocument.mockResolvedValueOnce('tab-puc19');

    const result = await openLimsEntity({
      entityId: 'demo-dna509-plasmid-puc19',
      strategy: { kind: 'focused' },
    });

    expect(result).toEqual({
      status: 'opened',
      tabId: 'tab-puc19',
      target,
    });
    expect(mocks.resolveLimsEntityOpenTarget).toHaveBeenCalledWith('demo-dna509-plasmid-puc19');
    expect(mocks.openSequenceDocument).toHaveBeenCalledWith(
      { kind: 'catalog-sequence', entityId: target.documentId },
      {
        label: 'pUC19',
        strategy: { kind: 'focused' },
      }
    );
  });

  it('catalogs a persisted file source when the logical document has no binding yet', async () => {
    const target = sequenceFileTarget();
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.resolveSequenceDocumentById.mockRejectedValueOnce(new Error('not cataloged'));
    mocks.getLimsEntityById.mockResolvedValueOnce({
      id: target.entityId,
      kind: 'plasmid',
      name: target.label,
      tombstone: false,
      fields: {
        sequence: {
          mode: 'file',
          documentId: target.documentId,
          relPath: '/fixtures/pUC19.gb',
        },
      },
    });
    mocks.openSequenceFile.mockResolvedValueOnce('tab-puc19');

    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toEqual({
      status: 'opened',
      tabId: 'tab-puc19',
      target,
    });
    expect(mocks.openSequenceFile).toHaveBeenCalledWith({
      filePath: '/fixtures/pUC19.gb',
      label: 'pUC19',
      strategy: { kind: 'focused' },
      sourceSurface: 'menu',
    });
  });

  it('focuses the opened plasmid tab on the primer binding site when a focus is passed', async () => {
    const target = sequenceFileTarget();
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openSequenceDocument.mockResolvedValueOnce('tab-puc19');

    mocks.canvasState.panels = { 'panel-1': { id: 'panel-1', tabs: [{ id: 'tab-puc19' }] } };

    const result = await openLimsEntity({
      entityId: target.entityId,
      strategy: { kind: 'focused' },
      focus: primerBindingToViewState(118, 137),
    });

    expect(result.status).toBe('opened');

    expect(mocks.openSequenceDocument).toHaveBeenCalledWith(
      { kind: 'catalog-sequence', entityId: target.documentId },
      {
        label: 'pUC19',
        strategy: { kind: 'focused' },
      }
    );

    expect(mocks.setTabViewState).toHaveBeenCalledTimes(1);
    const [panelId, tabId, viewState] = mocks.setTabViewState.mock.calls[0];
    expect(panelId).toBe('panel-1');
    expect(tabId).toBe('tab-puc19');
    expect(viewState).toMatchObject({
      scrollPosition: 118,
      highlightRange: { start: 117, end: 136 },
    });
    expect(typeof viewState.sequenceNavigationRequestId).toBe('number');
  });

  it('does not touch view state when no focus is passed', async () => {
    const target = sequenceFileTarget();
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openSequenceDocument.mockResolvedValueOnce('tab-puc19');
    mocks.canvasState.panels = { 'panel-1': { id: 'panel-1', tabs: [{ id: 'tab-puc19' }] } };

    await openLimsEntity({ entityId: target.entityId });

    expect(mocks.setTabViewState).not.toHaveBeenCalled();
  });

  it('opens a Registry sequence through its managed package identity', async () => {
    const target: LimsOpenTarget = {
      kind: 'managed_sequence',
      entityId: 'managed-sequence-1',
      entityKind: 'sequence',
      label: 'Logical sequence name',
      registrationStatus: 'tracked',
      document: {
        kind: 'managed-sequence',
        packageId: 'managed-sequence-1',
        packageRoot: '/workspace/Package',
      },
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.resolveManagedSequenceDocument.mockResolvedValueOnce({ ref: target.document });
    mocks.openManagedSequenceDocument.mockResolvedValueOnce('tab-managed');

    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toEqual({
      status: 'opened',
      tabId: 'tab-managed',
      target,
    });
    expect(mocks.openManagedSequenceDocument).toHaveBeenCalledWith(target.document, {
      label: 'Logical sequence name',
      strategy: { kind: 'focused' },
    });
    expect(mocks.openSequenceDocument).not.toHaveBeenCalled();
  });

  it('reports not_opened when the sequence opener declines the file', async () => {
    const target = sequenceFileTarget();
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openSequenceDocument.mockResolvedValueOnce(null);

    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toEqual({
      status: 'not_opened',
      target,
      message: 'Could not open pUC19.',
    });
  });

  it('opens a relocated portable record through its current native catalog binding', async () => {
    const target: LimsOpenTarget = {
      kind: 'record_detail',
      entityId: 'portable-record',
      entityKind: 'strain',
      label: 'Reviewed reagent',
      reason: 'strain_evidence',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.getLimsEntityById.mockResolvedValueOnce({
      id: target.entityId,
      workspaceId: 7,
      fields: { artifact: { relativePath: 'old.entity.json' } },
    });
    mocks.getCurrentCatalogFileForEntity.mockResolvedValueOnce({
      workspace_id: 7,
      path: '/workspace/Reviewed records/new.entity.json',
    });
    mocks.openDocument.mockResolvedValueOnce({ status: 'presented', tabId: 'record-tab' });
    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toMatchObject({
      status: 'opened_record',
      tabId: 'record-tab',
    });
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/workspace/Reviewed records/new.entity.json' },
      label: target.label,
      placement: { kind: 'smart' },
    });
  });

  it('does not use a portable record field or another project binding as an opening authority', async () => {
    const target: LimsOpenTarget = {
      kind: 'record_detail',
      entityId: 'portable-record',
      entityKind: 'strain',
      label: 'Reviewed reagent',
      reason: 'strain_evidence',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.getLimsEntityById.mockResolvedValueOnce({
      id: target.entityId,
      workspaceId: 7,
      fields: { artifact: { relativePath: '../other-project/private.entity.json' } },
    });
    mocks.getCurrentCatalogFileForEntity.mockResolvedValueOnce({
      workspace_id: 9,
      path: '/other-project/private.entity.json',
    });
    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toMatchObject({
      status: 'unsupported',
    });
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it('does not invent tabs for detail-only LIMS records', async () => {
    const target: LimsOpenTarget = {
      kind: 'record_detail',
      entityId: 'demo-dna509-strain-argf',
      entityKind: 'strain',
      label: 'Demo argF deletion strain',
      reason: 'strain_evidence',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);

    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toEqual({
      status: 'unsupported',
      target,
      message:
        'Demo argF deletion strain is a strain record; the strain detail tab is not implemented yet.',
    });
    expect(mocks.openSequenceDocument).not.toHaveBeenCalled();
  });

  it('opens a protein_sequence target as a protein tab via smart placement, never openSequenceFile', async () => {
    const target: LimsOpenTarget = {
      kind: 'protein_sequence',
      entityId: 'protein-uuid-1',
      entityKind: 'protein',
      label: 'GFP',
      filePath: 'proteins/GFP-abcd1234.faa',
      registrationStatus: 'registered',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openDocument.mockResolvedValueOnce({ status: 'presented', tabId: 'tab-gfp' });

    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toEqual({
      status: 'opened_protein',
      tabId: 'tab-gfp',
      target,
    });
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'record', tabType: 'protein', entityId: 'protein-uuid-1' },
      label: 'GFP',
      placement: { kind: 'smart' },
    });
    expect(mocks.openSequenceDocument).not.toHaveBeenCalled();
  });

  it('retires a package-backed protein before opening when its authority disappeared', async () => {
    const target: LimsOpenTarget = {
      kind: 'protein_sequence',
      entityId: 'protein-package-1',
      entityKind: 'protein',
      label: 'Gone protein',
      registrationStatus: 'registered',
    };
    const entity = {
      id: target.entityId,
      kind: 'protein',
      name: target.label,
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'MPEPTIDE', length: 8 },
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'proteins/Gone.entity.json' },
      },
      tombstone: false,
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.getLimsEntityById.mockResolvedValueOnce(entity);
    mocks.resolveProteinEntityArtifactRevision.mockResolvedValueOnce({
      status: 'missing-authority',
    });

    await expect(openLimsEntity({ entityId: target.entityId })).resolves.toEqual({
      status: 'not_found',
      target: {
        kind: 'missing_entity',
        entityId: target.entityId,
        label: target.label,
        reason: 'not_found',
      },
      message: `LIMS entity not found: ${target.entityId}`,
    });
    expect(mocks.resolveProteinEntityArtifactRevision).toHaveBeenCalledWith({
      entity,
      workspaceRoots: ['/workspace'],
    });
    expect(mocks.openDocument).not.toHaveBeenCalled();
  });

  it('opens notebook entities as page tabs', async () => {
    const target: LimsOpenTarget = {
      kind: 'notebook',
      entityId: 'ws1::page-1',
      entityKind: 'notebook',
      label: 'Miniprep',
      filePath: '/lab/Miniprep',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openWithSmartPlacement.mockReturnValueOnce('tab-notebook');

    await expect(openLimsEntity({ entityId: 'ws1::page-1' })).resolves.toEqual({
      status: 'opened_notebook',
      tabId: 'tab-notebook',
      target,
    });
    expect(mocks.openWithSmartPlacement).toHaveBeenCalledWith('page', 'ws1::page-1', 'Miniprep');
    expect(mocks.openSequenceDocument).not.toHaveBeenCalled();
  });

  it('opens a file-backed Track view from its Registry row', async () => {
    const target: LimsOpenTarget = {
      kind: 'track_view',
      entityId: 'track-view-1',
      entityKind: 'track-view',
      label: 'Yeast detail',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openDocument.mockResolvedValueOnce({
      status: 'presented',
      tabId: 'tab-track-view',
      panelId: 'main',
      tabType: 'sequence',
      disposition: 'created',
      content: 'loading',
    });

    const result = await openLimsEntity({
      entityId: target.entityId,
      strategy: { kind: 'smart' },
    });

    expect(result).toEqual({
      status: 'opened_track_view',
      tabId: 'tab-track-view',
      target,
    });
    expect(isLimsEntityOpened(result)).toBe(true);
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'track-view', id: target.entityId },
      label: target.label,
      placement: { kind: 'smart' },
    });
  });

  it('classifies opened_notebook as a successful open so callers can read message only on failures', async () => {
    const target: LimsOpenTarget = {
      kind: 'notebook',
      entityId: 'ws1::page-1',
      entityKind: 'notebook',
      label: 'Miniprep',
      filePath: '/lab/Miniprep',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);
    mocks.openWithSmartPlacement.mockReturnValueOnce('tab-notebook');
    const result = await openLimsEntity({ entityId: 'ws1::page-1' });
    expect(isLimsEntityOpened(result)).toBe(true);
    if (!isLimsEntityOpened(result)) {
      expect(result.message).toBeDefined();
    }
  });

  it('surfaces missing registry entities without calling the file opener', async () => {
    const target: LimsOpenTarget = {
      kind: 'missing_entity',
      entityId: 'missing-entity',
      label: 'missing-entity',
      reason: 'not_found',
    };
    mocks.resolveLimsEntityOpenTarget.mockResolvedValueOnce(target);

    await expect(openLimsEntity({ entityId: 'missing-entity' })).resolves.toEqual({
      status: 'not_found',
      target,
      message: 'LIMS entity not found: missing-entity',
    });
    expect(mocks.openSequenceDocument).not.toHaveBeenCalled();
  });
});

function sequenceFileTarget(): LimsOpenTarget {
  return {
    kind: 'sequence_file',
    entityId: 'demo-dna509-plasmid-puc19',
    entityKind: 'plasmid',
    label: 'pUC19',
    filePath: '/fixtures/pUC19.gb',
    documentId: 'demo-dna509-plasmid-puc19',
    registrationStatus: 'registered',
    sequence: {
      relPath: '/fixtures/pUC19.gb',
      documentId: 'demo-dna509-plasmid-puc19',
      topology: 'circular',
      length: 2686,
      contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceFormat: 'gb',
    },
  };
}

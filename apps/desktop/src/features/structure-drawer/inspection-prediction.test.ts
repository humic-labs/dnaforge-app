import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { resolveSequenceDocumentById } from '../sequence/public/sequence-document-repository';
vi.mock('../sequence/public/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSequenceDocumentById: vi.fn(),
}));
import { useCanvasStore } from '../canvas/public/store';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { openStructureInspection, structureInspectionId } from './structure-inspection';
import {
  prepareInspectionPrediction,
  listInspectionPredictions,
  attachInspectionPrediction,
  inspectionPredictionWorkspaceRoot,
} from './inspection-prediction';

vi.mock('./inspection-continuation', () => ({
  createInspectionContinuation: vi.fn(async () => undefined),
  saveInspectionContinuation: vi.fn(async () => {}),
  loadInspectionContinuation: vi.fn(),
  openContinuationSource: vi.fn(),
}));

const documentId = 'sequence-document:prediction-test';
const request = {
  entityId: documentId,
  translation: 'MAG',
  hints: {},
  identityRequestKey: 'cds-1',
  sourceWorkspaceRoot: '/reference-project',
};
beforeEach(() => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: documentId,
    label: 'Reference',
    sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
  });
  openStructureInspection(request);
});

describe('prediction destination', () => {
  it('reports missing protein context for discovery without treating it as failed attachment', async () => {
    const before = useCanvasStore.getState().panels;
    await expect(listInspectionPredictions('uninspected-document')).resolves.toMatchObject({
      status: 'protein-required',
      documentId: 'uninspected-document',
      message: expect.stringContaining('proteinSequence'),
    });
    expect(useCanvasStore.getState().panels).toBe(before);
    await expect(
      prepareInspectionPrediction({ document_id: 'uninspected-document' }, { sequence: 'MAG' })
    ).rejects.toThrow(/Open the reference mutation inspection/);
  });

  it('resolves a VCF inspection’s document binding instead of the first mounted workspace', async () => {
    openStructureInspection({ ...request, sourceWorkspaceRoot: undefined });
    useWorkspaceStore.setState({
      folders: [
        { path: '/unrelated', name: 'Unrelated', addedAt: 1 },
        { path: '/reference-project', name: 'Reference', addedAt: 2 },
      ],
    });
    vi.mocked(resolveSequenceDocumentById).mockResolvedValue({
      documentId,
      ref: { kind: 'catalog-sequence', entityId: documentId },
      sourcePath: '/reference-project/ref.gb',
    });
    expect(await inspectionPredictionWorkspaceRoot(documentId)).toBe('/reference-project');
    expect(resolveSequenceDocumentById).toHaveBeenCalledWith(documentId, [
      '/unrelated',
      '/reference-project',
    ]);
  });
  it('binds exact reference sequence, rejects a different submitted sequence and stale requested protein', async () => {
    const target = await prepareInspectionPrediction(
      { document_id: documentId },
      { sequence: 'MAG' }
    );
    expect(await inspectionPredictionWorkspaceRoot(documentId)).toBe('/reference-project');
    expect(target.proteinSequenceSha256).toBe(await coordinateDigest('MAG'));
    await expect(
      prepareInspectionPrediction({ document_id: documentId }, { sequence: 'MWG' })
    ).rejects.toThrow(/sequence/);
    await expect(
      prepareInspectionPrediction(
        { document_id: documentId, protein_key: 'old' },
        { sequence: 'MAG' }
      )
    ).rejects.toThrow(/changed/);
  });

  it('attaches a completed result to its retained protein after restart, without changing the currently selected protein', async () => {
    const target = await prepareInspectionPrediction(
      { document_id: documentId },
      { sequence: 'MAG' }
    );
    openStructureInspection({ ...request, identityRequestKey: 'cds-2', translation: 'MWG' });
    useCanvasStore.setState({
      panels: JSON.parse(JSON.stringify(useCanvasStore.getState().panels)),
    });
    const artifact = {
      jobRecordId: 'job1',
      provider: 'tamarind',
      remoteId: 'remote1',
      toolId: 'esmfold',
      workspaceRoot: '/ws',
      filePath: '/ws/compute/m.pdb',
      format: 'pdb' as const,
      sha256: 'b'.repeat(64),
      proteinSequenceSha256: target.proteinSequenceSha256,
      metrics: {},
      provenance: {},
    };
    await attachInspectionPrediction(target, artifact);
    const location = useCanvasStore
      .getState()
      .findTab('structure', structureInspectionId(documentId))!;
    const current = () =>
      useCanvasStore.getState().panels[location.panelId].tabs.find((t) => t.id === location.tabId)!
        .structureInspection!;
    expect(current().prediction).toBeUndefined();
    openStructureInspection(request);
    expect(current().prediction).toEqual(artifact);
    expect(current().candidateId).toBe('prediction:job1:' + artifact.sha256);
    useCanvasStore.getState().updateTab(location.panelId, location.tabId, {
      structureInspection: { ...current(), savedViewReferenceId: 'scientist-customized-view' },
    });
    await attachInspectionPrediction(target, artifact);
    expect(current().savedViewReferenceId).toBe('scientist-customized-view');
    openStructureInspection({ ...request, translation: 'MAGA' });
    expect(current().prediction).toBeUndefined();
  });
});

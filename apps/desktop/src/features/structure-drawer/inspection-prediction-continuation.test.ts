import { beforeEach, expect, it, vi } from 'vitest';
import { updateEntityReference } from '../../db/entity-references';
import { saveInspectionContinuation } from './inspection-continuation';
import type { DBEntityReference } from '../../db/entity-references';
const fixture = vi.hoisted(() => ({ rows: new Map<string, DBEntityReference>(), content: '' }));
vi.mock('../../db/entity-references', () => ({
  createEntityReference: vi.fn(async (params) => {
    const row = { id: crypto.randomUUID(), data: JSON.stringify(params.data) } as DBEntityReference;
    fixture.rows.set(row.id, row);
    return row;
  }),
  getEntityReference: vi.fn(async (id) => fixture.rows.get(id) ?? null),
  updateEntityReference: vi.fn(async (id, changes) => {
    const row = fixture.rows.get(id)!;
    fixture.rows.set(id, { ...row, data: JSON.stringify(changes.data) });
  }),
}));
vi.mock('../sequence/public/sequence-document-repository', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSequenceDocumentById: vi.fn(async (documentId) => ({
    documentId,
    ref: { kind: 'catalog-sequence', entityId: documentId },
    sourcePath: '/reference/ref.gb',
  })),
}));
vi.mock('../scientific-document/services/desktop-scientific-documents', () => ({
  readDesktopScientificDocument: vi.fn(async () => ({
    ok: true,
    document: { content: fixture.content },
  })),
}));
vi.mock('../document-opening/public/open-document', () => ({
  openDocument: vi.fn(async () => {
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'ref',
      label: 'Reference',
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'ref' },
    });
    return {
      status: 'presented',
      tabId,
      panelId: 'main',
      tabType: 'sequence',
      content: 'loading',
      disposition: 'created',
    };
  }),
}));
import { parseTextSequenceFileAsAnnotated } from '../../shared/parse-sequence-file';
import { useCanvasStore } from '../canvas/public/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { buildStructureDrawerRequestFromCds } from './api/build-structure-request';
import {
  inspectionProteinKey,
  openStructureInspection,
  structureInspectionId,
} from './structure-inspection';
import { attachInspectionPrediction, prepareInspectionPrediction } from './inspection-prediction';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';

const genbank = `LOCUS       reference                 12 bp    DNA     linear   SYN 01-JAN-2026
DEFINITION  Minimal prediction continuation reference.
FEATURES             Location/Qualifiers
     CDS             1..12
                     /gene="test"
                     /translation="MAG"
ORIGIN
        1 atggctggttaa
//
`;
const sequence = parseTextSequenceFileAsAnnotated(genbank, '/reference/ref.gb').sequence;
const request = buildStructureDrawerRequestFromCds({
  sequence,
  cds: sequence.annotations![0],
  entityId: 'ref',
})!;
const selection = [
  {
    target: {
      ...request.residueMolecule!,
      coordinateSystem: 'residue' as const,
      intervals: [{ start: 1, end: 1 }],
    },
  },
];
const locate = () => useCanvasStore.getState().findTab('structure', structureInspectionId('ref'))!;
function closeAll() {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
}
beforeEach(() => {
  fixture.rows.clear();
  fixture.content = genbank;
  closeAll();
  useWorkspaceStore.setState({ folders: [{ path: '/reference', name: 'Reference', addedAt: 1 }] });
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'ref',
    label: 'Reference',
    sequenceDocument: { kind: 'catalog-sequence', entityId: 'ref' },
  });
  openStructureInspection(request, selection);
});
it('records a durable continuation before submission and restores a closed source with its exact selection', async () => {
  const target = await prepareInspectionPrediction({ document_id: 'ref' }, { sequence: 'MAG' });
  expect(target).toHaveProperty('continuationReferenceId', expect.any(String));
  const referenceId = (target as typeof target & { continuationReferenceId: string })
    .continuationReferenceId;
  expect(JSON.parse(fixture.rows.get(referenceId)!.data!)).toMatchObject({
    kind: 'protein-inspection-continuation',
    proteinKey: inspectionProteinKey(request),
    sourceSha256: await coordinateDigest(genbank),
  });
  closeAll();
  const artifact = {
    jobRecordId: 'job1',
    provider: 'tamarind',
    remoteId: 'remote1',
    toolId: 'esmfold',
    workspaceRoot: '/reference',
    filePath: '/reference/result.cif',
    format: 'cif' as const,
    sha256: 'b'.repeat(64),
    proteinSequenceSha256: target.proteinSequenceSha256,
    metrics: {},
    provenance: {},
  };
  await attachInspectionPrediction(target, artifact);
  const location = locate();
  const inspection = useCanvasStore
    .getState()
    .panels[location.panelId].tabs.find((tab) => tab.id === location.tabId)!.structureInspection!;
  expect(inspection.request.translation).toBe('MAG');
  expect(inspection.selections).toMatchObject(selection);
  expect(inspection.prediction).toEqual(artifact);
  expect(JSON.parse(fixture.rows.get(referenceId)!.data!)).toMatchObject({ prediction: artifact });
  expect(useCanvasStore.getState().findTab('sequence', 'ref')).toBeTruthy();
});
it('refuses a changed reference before opening either pane', async () => {
  const target = await prepareInspectionPrediction({ document_id: 'ref' }, { sequence: 'MAG' });
  closeAll();
  fixture.content = genbank.replace('atggct', 'atggat');
  await expect(
    attachInspectionPrediction(target, {
      jobRecordId: 'j',
      provider: 't',
      remoteId: 'r',
      toolId: 'e',
      workspaceRoot: '/reference',
      filePath: '/reference/r.cif',
      format: 'cif',
      sha256: 'b'.repeat(64),
      proteinSequenceSha256: target.proteinSequenceSha256,
      metrics: {},
      provenance: {},
    })
  ).rejects.toThrow(/reference.*changed/i);
  expect(Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)).toEqual(
    []
  );
});

it('reopens the DNA source when only that tab was closed', async () => {
  const target = await prepareInspectionPrediction({ document_id: 'ref' }, { sequence: 'MAG' });
  const original = locate();
  const originalInspection = useCanvasStore
    .getState()
    .panels[original.panelId].tabs.find((tab) => tab.id === original.tabId)!.structureInspection!;
  useCanvasStore.getState().updateTab(original.panelId, original.tabId, {
    structureInspection: { ...originalInspection, savedViewReferenceId: 'old-reference-scene' },
  });
  const state = useCanvasStore.getState();
  useCanvasStore.setState({
    panels: Object.fromEntries(
      Object.entries(state.panels).map(([key, panel]) => [
        key,
        {
          ...panel,
          tabs: panel.tabs.filter((tab) => tab.type !== 'sequence'),
          activeTabId: panel.tabs.find((tab) => tab.type === 'structure')?.id ?? null,
        },
      ])
    ),
  });
  await attachInspectionPrediction(target, {
    jobRecordId: 'j',
    provider: 't',
    remoteId: 'r',
    toolId: 'e',
    workspaceRoot: '/reference',
    filePath: '/reference/r.cif',
    format: 'cif',
    sha256: 'b'.repeat(64),
    proteinSequenceSha256: target.proteinSequenceSha256,
    metrics: {},
    provenance: {},
  });
  expect(useCanvasStore.getState().findTab('sequence', 'ref')).toBeTruthy();
  const location = locate();
  expect(
    useCanvasStore
      .getState()
      .panels[location.panelId].tabs.find((tab) => tab.id === location.tabId)!.structureInspection!
      .savedViewReferenceId
  ).toBeUndefined();
});
it('stores explicit saved-scene identity and selection without copying the scene or coordinates', async () => {
  const target = await prepareInspectionPrediction({ document_id: 'ref' }, { sequence: 'MAG' });
  await saveInspectionContinuation({
    request,
    continuationReferenceId: target.continuationReferenceId,
    selections: [{ target: { ...selection[0].target, intervals: [{ start: 2, end: 2 }] } }],
    savedViewReferenceId: 'canonical-scene',
  });
  const saved = JSON.parse(fixture.rows.get(target.continuationReferenceId!)!.data!);
  expect(saved).toMatchObject({
    savedViewReferenceId: 'canonical-scene',
    selections: [{ target: { intervals: [{ start: 2, end: 2 }] } }],
  });
  expect(saved.scene).toBeUndefined();
  expect(saved.coordinates).toBeUndefined();
  vi.mocked(updateEntityReference).mockRejectedValueOnce(new Error('write failed'));
  await expect(
    saveInspectionContinuation({
      request,
      continuationReferenceId: target.continuationReferenceId,
      savedViewReferenceId: 'unpersisted',
    })
  ).rejects.toThrow('write failed');
  expect(
    JSON.parse(fixture.rows.get(target.continuationReferenceId!)!.data!).savedViewReferenceId
  ).toBe('canonical-scene');
});

it('persists and rebuilds an allele prediction after closing both tabs without substituting the reference product', async () => {
  const { buildMutationProteinContext } =
    await import('../alignment-manager/public/mutation-protein-context');
  const { selectInspectionProteinProduct } = await import('./inspection-allele');
  const built = buildMutationProteinContext({
    sequence,
    documentId: 'ref',
    trackId: 'sample',
    trackLabel: 'Sample',
    mutation: {
      id: 'g4t',
      type: 'substitution',
      position: 4,
      referenceBase: 'G',
      alternateBase: 'T',
      length: 1,
    },
  });
  if (!built.ok) throw new Error(built.reason);
  openStructureInspection(built.request, built.selections, {
    savedViewReferenceId: 'pinned-reference',
    candidateId: 'reference-model',
  });
  selectInspectionProteinProduct('ref', 'allele');
  await expect(
    prepareInspectionPrediction({ document_id: 'ref' }, { sequence: 'MAG' })
  ).rejects.toThrow(/exactly/);
  const target = await prepareInspectionPrediction({ document_id: 'ref' }, { sequence: 'MSG' });
  closeAll();
  const { loadInspectionContinuation } = await import('./inspection-continuation');
  const loaded = await loadInspectionContinuation(target);
  expect(loaded.request.translation).toBe('MSG');
  expect(loaded.request.alleleOf?.translation).toBe('MAG');
  expect(loaded.request.variantContext?.product).toMatchObject({
    status: 'complete',
    sequence: 'MSG',
  });
  expect(loaded.request.hints).toEqual({});
  expect(loaded.request.cdsBounds).toBeUndefined();
  expect(await coordinateDigest(loaded.request.translation)).toBe(target.proteinSequenceSha256);
  expect(loaded.context.selections?.[0].target.moleculeId).toBe(
    loaded.request.residueMolecule?.moleculeId
  );
  await attachInspectionPrediction(target, {
    jobRecordId: 'allele-job',
    provider: 'fixture',
    remoteId: 'remote',
    toolId: 'fold',
    workspaceRoot: '/reference',
    filePath: '/reference/allele.pdb',
    format: 'pdb',
    sha256: 'a'.repeat(64),
    proteinSequenceSha256: target.proteinSequenceSha256,
    metrics: {},
    provenance: {},
  });
  selectInspectionProteinProduct('ref', 'reference');
  const location = locate();
  const restoredReference = useCanvasStore
    .getState()
    .panels[location.panelId].tabs.find((t) => t.id === location.tabId)!.structureInspection!;
  expect(restoredReference.savedViewReferenceId).toBe('pinned-reference');
  expect(restoredReference.candidateId).toBe('reference-model');
});

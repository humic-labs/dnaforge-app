vi.mock('../structure-drawer/inspection-continuation', () => ({
  createInspectionContinuation: vi.fn(async () => undefined),
  saveInspectionContinuation: vi.fn(async () => {}),
  loadInspectionContinuation: vi.fn(),
  openContinuationSource: vi.fn(),
}));
import { beforeEach, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import { openStructureInspection } from '../structure-drawer/public/structure-inspection';
import { prepareInspectionPrediction } from '../structure-drawer/public/inspection-prediction';
import { importComputeResult } from './import-result';

const pdb = `ATOM      1  CA  MET A   1       0.000   0.000   0.000  1.00 90.00           C  
ATOM      2  CA  ALA A   2       3.800   0.000   0.000  1.00 90.00           C  
ATOM      3  CA  GLY A   3       7.600   0.000   0.000  1.00 90.00           C  
END
`;
const id = 'sequence-document:prediction-import';
beforeEach(() => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: id,
    label: 'Reference',
    sequenceDocument: { kind: 'catalog-sequence', entityId: id },
  });
  openStructureInspection({ entityId: id, translation: 'MAG', hints: {} });
});

it('imports matching coordinates through the shared writer and targets inspection, refusing mismatched, test-mode and stale results before writes', async () => {
  const target = await prepareInspectionPrediction({ document_id: id }, { sequence: 'MAG' });
  const bundle = {
    provider: 'tamarind',
    remoteId: 'r1',
    toolId: 'esmfold',
    outputKind: 'structure',
    files: [
      {
        name: 'model.pdb',
        media_type: 'chemical/x-pdb',
        size_bytes: null,
        content: pdb,
        url: null,
      },
    ],
    metrics: { plddt: 90 },
    provenance: { fixture: 'coordinate-import-test' },
    inspectionDestination: { target, jobRecordId: 'j1', recordedAt: '2026-10-06T00:00:00.000Z' },
  };
  const deps = {
    writePackage: vi.fn(
      async ({ directory, name }: { directory: string; name: string }) =>
        `${directory}/${name}.dnaforge-molecular.json`
    ),
    writeOutputFile: vi.fn(async () => ''),
    registerFile: vi.fn(async () => {}),
    openStructure: vi.fn(async () => {}),
    attachPrediction: vi.fn(async () => {}),
  };
  const folders = [{ path: '/ws', name: 'Workspace', addedAt: 1 }];
  const options = { preferredRoot: '/ws', deps };
  const result = await importComputeResult(bundle, folders, options);
  expect(result).toMatchObject({ ok: true, inspectionAttached: true, opened: [] });
  expect(deps.openStructure).not.toHaveBeenCalled();
  expect(deps.attachPrediction).toHaveBeenCalledWith(
    target,
    expect.objectContaining({
      filePath: '/ws/esmfold prediction.dnaforge-molecular.json',
      proteinSequenceSha256: target.proteinSequenceSha256,
      metrics: { plddt: 90 },
    })
  );
  expect(result).toMatchObject({
    importDetails: { receipt: { inspectionDestination: bundle.inspectionDestination } },
  });
  deps.writePackage.mockClear();
  await expect(
    importComputeResult(
      { ...bundle, files: [{ ...bundle.files[0], content: pdb.replace('ALA', 'TRP') }] },
      folders,
      options
    )
  ).rejects.toThrow(/protein/);
  await expect(
    importComputeResult({ ...bundle, provenance: { livemode: 'false' } }, folders, options)
  ).rejects.toThrow(/test-mode/);
  useCanvasStore.setState({ panels: {} });
  await expect(importComputeResult(bundle, folders, options)).rejects.toThrow(/Open the reference/);
  expect(deps.writePackage).not.toHaveBeenCalled();
});

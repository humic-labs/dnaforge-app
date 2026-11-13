import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { useCanvasStore } from '../canvas/public/store';
import { buildMutationProteinContext } from '../alignment-manager/public/mutation-protein-context';
import {
  alleleStructureRequest,
  selectInspectionProteinProduct,
  inspectionProteinProductSummary,
  waitForInspectionProteinProduct,
} from './inspection-allele';
import { getStructureInspectionSession } from './state/structure-inspection-sessions';
import {
  openStructureInspection,
  inspectionProteinKey,
  structureInspectionId,
} from './structure-inspection';
const sequence = {
  name: 'P',
  sequence: 'ATGAAAGGTTAA',
  circular: false,
  annotations: [{ id: 'cds', name: 'P', type: 'CDS', start: 1, end: 12, direction: 1 as const }],
} as AnnotatedSequence;
function reference(position = 5, alternateBase = 'G') {
  const result = buildMutationProteinContext({
    sequence,
    documentId: 'ref',
    trackId: 'sample',
    trackLabel: 'Sample',
    mutation: {
      id: 'm',
      position,
      referenceBase: 'A',
      alternateBase,
      type: 'substitution',
      length: 1,
    },
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
}
beforeEach(() => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    recentlyClosed: [],
  });
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'ref',
    label: 'Reference',
    sequenceDocument: { kind: 'catalog-sequence', entityId: 'ref' },
  });
});
afterEach(() => vi.useRealTimers());

function inspectionRuntime() {
  const ref = reference();
  openStructureInspection(ref.request, ref.selections);
  const where = useCanvasStore.getState().findTab('structure', structureInspectionId('ref'))!;
  const store = getStructureInspectionSession(where.tabId, inspectionProteinKey(ref.request));
  store.setState({ request: ref.request, status: 'resolving' });
  return { ref, where, store };
}

it('reports native inspection readiness rather than permanently calling every reference resolving', () => {
  const { store } = inspectionRuntime();
  store.setState({ status: 'ready' });
  expect(inspectionProteinProductSummary('ref').structureStatus).toBe('ready');
  store.setState({ status: 'no_match' });
  expect(inspectionProteinProductSummary('ref').structureStatus).toBe('no_match');
});

it('waits through lookup and rendering and returns the same native-ready inspection', async () => {
  vi.useFakeTimers();
  const { store } = inspectionRuntime();
  let settled = false;
  const pending = waitForInspectionProteinProduct('ref').then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(500);
  store.setState({ status: 'rendering' });
  expect(settled).toBe(false);
  store.setState({ status: 'ready' });
  expect(await pending).toMatchObject({ proteinProduct: 'reference', structureStatus: 'ready' });
  expect(vi.getTimerCount()).toBe(0);
});

it('retains pending as pending at the bounded wait deadline', async () => {
  vi.useFakeTimers();
  inspectionRuntime();
  const pending = waitForInspectionProteinProduct('ref');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toMatchObject({ structureStatus: 'resolving' });
  expect(vi.getTimerCount()).toBe(0);
});

it('does not replace a pending reference lookup with an unavailable-structure claim', async () => {
  vi.useFakeTimers();
  const { store } = inspectionRuntime();
  const pending = waitForInspectionProteinProduct('ref');
  store.setState({ status: 'no_match' });
  expect(await pending).toMatchObject({ structureStatus: 'no_match' });
});

it('cancels observation without closing the structure lookup', async () => {
  vi.useFakeTimers();
  const { store } = inspectionRuntime();
  const controller = new AbortController();
  const existingTimers = vi.getTimerCount();
  const pending = waitForInspectionProteinProduct('ref', controller.signal);
  const rejected = expect(pending).rejects.toThrow(/stopped waiting/i);
  controller.abort();
  await rejected;
  expect(store.getState().status).toBe('resolving');
  expect(vi.getTimerCount()).toBe(existingTimers);
});
it('gives an allele its actual sequence and distinct identity without borrowing reference hints or DNA bounds', () => {
  const ref = reference().request;
  const alt = alleleStructureRequest({ ...ref, hints: { dbXrefs: ['UniProtKB:P00001'] } });
  expect(alt.translation).toBe('MRG');
  expect(alt.hints).toEqual({});
  expect(alt.cdsBounds).toBeUndefined();
  expect(alt.residueMolecule?.moleculeId).not.toBe(ref.residueMolecule?.moleculeId);
  expect(inspectionProteinKey(alt)).not.toBe(inspectionProteinKey(ref));
  expect(alt.proteinIdentity?.sequence.source).toBe('allele_translation');
});
it('retains the reference scene when opening the allele and restores it when returning', () => {
  const ref = reference();
  openStructureInspection(ref.request, ref.selections, {
    candidateId: 'reference-model',
    savedViewReferenceId: 'reference-scene',
  });
  const where = useCanvasStore.getState().findTab('structure', structureInspectionId('ref'))!;
  const current = () =>
    useCanvasStore.getState().panels[where.panelId].tabs.find((t) => t.id === where.tabId)!
      .structureInspection!;
  selectInspectionProteinProduct('ref', 'allele');
  expect(current().request.translation).toBe('MRG');
  expect(current().savedViewReferenceId).toBeUndefined();
  expect(current().selections?.[0].target.intervals).toEqual([{ start: 1, end: 1 }]);
  selectInspectionProteinProduct('ref', 'reference');
  expect(current().candidateId).toBe('reference-model');
  expect(current().savedViewReferenceId).toBe('reference-scene');
  expect(current().request.translation).toBe('MKG');
});
it('does not select a reference stop position on a shorter alternate product', () => {
  const ref = reference(4, 'T');
  openStructureInspection(ref.request, ref.selections);
  selectInspectionProteinProduct('ref', 'allele');
  const where = useCanvasStore.getState().findTab('structure', structureInspectionId('ref'))!;
  const inspection = useCanvasStore
    .getState()
    .panels[where.panelId].tabs.find((t) => t.id === where.tabId)!.structureInspection!;
  expect(inspection.request.translation).toBe('M');
  expect(inspection.selections).toEqual([]);
});

it('restores the last selection in each product when switching the comparison', () => {
  const ref = reference();
  openStructureInspection(ref.request, ref.selections);
  selectInspectionProteinProduct('ref', 'allele');
  const where = useCanvasStore.getState().findTab('structure', structureInspectionId('ref'))!;
  const current = () =>
    useCanvasStore.getState().panels[where.panelId].tabs.find((t) => t.id === where.tabId)!
      .structureInspection!;
  const selected = [
    {
      target: {
        ...current().request.residueMolecule!,
        coordinateSystem: 'residue' as const,
        intervals: [{ start: 2, end: 2 }],
      },
    },
  ];
  useCanvasStore.getState().updateTab(where.panelId, where.tabId, {
    structureInspection: { ...current(), selections: selected },
  });
  selectInspectionProteinProduct('ref', 'reference');
  selectInspectionProteinProduct('ref', 'allele');
  expect(current().selections).toEqual(selected);
});

import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import {
  clearStructureInspection,
  openStructureInspection,
  structureInspectionId,
} from './structure-inspection';
import type { StructureDrawerRequest } from './types/structure-drawer';

const documentId = 'sequence-document:inspection-test';
const request: StructureDrawerRequest = {
  entityId: documentId,
  translation: 'MAG',
  cdsLabel: 'Protein',
  hints: {},
  variantContext: {
    trackId: 'clone-7',
    trackLabel: 'Clone 7',
    mutationId: 'm1',
    position: 4,
    referenceBase: 'G',
    alternateBase: 'A',
    residueIndices: [1],
  },
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
});

describe('linked structure inspection placement', () => {
  it('keeps the same request object for a repeated identical inspection so pending lookup is not restarted', () => {
    openStructureInspection(request);
    const tab = useCanvasStore.getState().findTab('structure', structureInspectionId(documentId))!;
    const current = () =>
      useCanvasStore.getState().panels[tab.panelId].tabs.find((item) => item.id === tab.tabId)!
        .structureInspection!;
    const first = current().request;
    openStructureInspection(JSON.parse(JSON.stringify(request)));
    expect(current().request).toBe(first);
    const changed = {
      ...request,
      variantContext: { ...request.variantContext!, mutationId: 'm2', position: 7 },
    };
    openStructureInspection(changed);
    expect(current().request).toBe(changed);
  });
  it('requests framing for an explicit mutation but not a saved-view restoration', () => {
    const selections = [
      {
        target: {
          moleculeId: 'protein',
          moleculeKind: 'protein' as const,
          coordinateSystem: 'residue' as const,
          intervals: [{ start: 1, end: 1 }],
        },
      },
    ];
    openStructureInspection(request, selections);
    const tab = useCanvasStore.getState().findTab('structure', structureInspectionId(documentId))!;
    const current = () =>
      useCanvasStore.getState().panels[tab.panelId].tabs[0].structureInspection!;
    expect(current().focusSelectionId).toEqual(expect.any(String));
    const first = current().focusSelectionId;
    openStructureInspection(request, selections);
    expect(current().focusSelectionId).not.toBe(first);
    openStructureInspection(request, selections, { savedViewReferenceId: 'saved' });
    expect(current().focusSelectionId).toBeUndefined();
  });

  it('retains a protein view through clone changes but does not apply it to another protein', () => {
    openStructureInspection(request);
    const canvas = useCanvasStore.getState();
    const tab = canvas.findTab('structure', structureInspectionId(documentId))!;
    const viewSettings = { candidateId: 'alphafold:P39702:all', showSequenceViewer: false };
    canvas.updateTab(tab.panelId, tab.tabId, {
      structureInspection: { request, candidateId: viewSettings.candidateId, viewSettings },
    });
    const current = () =>
      useCanvasStore.getState().panels[tab.panelId].tabs[0].structureInspection!;
    clearStructureInspection(documentId, 'Choose another clone.');
    expect(current().viewSettings).toEqual(viewSettings);
    openStructureInspection({
      ...request,
      variantContext: { ...request.variantContext!, mutationId: 'm2' },
    });
    expect(current().viewSettings).toEqual(viewSettings);
    openStructureInspection({ ...request, translation: 'MQW', cdsLabel: 'Another protein' });
    expect(current().viewSettings).toBeUndefined();
    expect(current().candidateId).toBeUndefined();
    openStructureInspection(request);
    expect(current().candidateId).toBe(viewSettings.candidateId);
    expect(current().viewSettings).toEqual(viewSettings);
  });

  it('keeps a separate chosen view for each protein after a persisted-state round trip', () => {
    const second = { ...request, translation: 'MQW', cdsLabel: 'Another protein' };
    openStructureInspection(request);
    const canvas = useCanvasStore.getState();
    const tab = canvas.findTab('structure', structureInspectionId(documentId))!;
    const current = () =>
      useCanvasStore.getState().panels[tab.panelId].tabs.find((item) => item.id === tab.tabId)!
        .structureInspection!;
    const choose = (candidateId: string, showSequenceViewer: boolean) => {
      canvas.updateTab(tab.panelId, tab.tabId, {
        structureInspection: {
          ...current(),
          candidateId,
          viewSettings: { candidateId, showSequenceViewer },
        },
      });
    };
    choose('alphafold:first', false);
    openStructureInspection(second);
    choose('alphafold:second', true);
    const panels = JSON.parse(JSON.stringify(useCanvasStore.getState().panels));
    useCanvasStore.setState({ panels });
    openStructureInspection(request);
    expect(current().candidateId).toBe('alphafold:first');
    expect(current().viewSettings).toMatchObject({ showSequenceViewer: false });
    openStructureInspection(second);
    expect(current().candidateId).toBe('alphafold:second');
    expect(current().viewSettings).toMatchObject({ showSequenceViewer: true });
    openStructureInspection({ ...second, translation: 'MQWA' });
    expect(current().candidateId).toBeUndefined();
    expect(current().viewSettings).toBeUndefined();
  });

  it('retains the pinned scene reference with its protein across restart', () => {
    openStructureInspection(request);
    const canvas = useCanvasStore.getState();
    const tab = canvas.findTab('structure', structureInspectionId(documentId))!;
    const current = () =>
      useCanvasStore.getState().panels[tab.panelId].tabs[0].structureInspection!;
    canvas.updateTab(tab.panelId, tab.tabId, {
      structureInspection: {
        ...current(),
        candidateId: 'alphafold:first',
        savedViewReferenceId: 'pinned-scene-1',
      },
    });
    openStructureInspection({ ...request, translation: 'MQW' });
    expect(current().savedViewReferenceId).toBeUndefined();
    useCanvasStore.setState({
      panels: JSON.parse(JSON.stringify(useCanvasStore.getState().panels)),
    });
    openStructureInspection(request);
    expect(current().savedViewReferenceId).toBe('pinned-scene-1');
    openStructureInspection({ ...request, translation: 'MAGA' });
    expect(current().savedViewReferenceId).toBeUndefined();
  });

  it('keeps the source active, opens beside it, and reuses the pane on the next mutation', () => {
    const source = useCanvasStore.getState().findTab('sequence', documentId)!;
    expect(openStructureInspection(request)).toBeUndefined();
    const first = useCanvasStore
      .getState()
      .findTab('structure', structureInspectionId(documentId))!;
    expect(first.panelId).not.toBe(source.panelId);
    const next = {
      ...request,
      variantContext: { ...request.variantContext!, mutationId: 'm2', residueIndices: [2] },
    };
    openStructureInspection(next);
    const state = useCanvasStore.getState();
    expect(state.findTab('structure', structureInspectionId(documentId))).toEqual(first);
    expect(Object.keys(state.panels)).toHaveLength(2);
    expect(state.panels[source.panelId].activeTabId).toBe(source.tabId);
    expect(state.focusedPanelId).toBe(source.panelId);
    expect(state.panels[first.panelId].tabs[0].structureInspection?.request).toEqual(next);
  });

  it('moves a reused inspection tab out of the source pane instead of hiding the sequence', () => {
    openStructureInspection(request);
    const canvas = useCanvasStore.getState();
    const tab = canvas.findTab('structure', structureInspectionId(documentId))!;
    canvas.moveTab(tab.panelId, 'main', tab.tabId);
    openStructureInspection(request);
    const state = useCanvasStore.getState();
    expect(state.findTab('structure', structureInspectionId(documentId))?.panelId).not.toBe('main');
    expect(state.panels.main.activeTabId).toBe(state.findTab('sequence', documentId)?.tabId);
    expect(
      Object.values(state.panels)
        .flatMap((p) => p.tabs)
        .filter((t) => t.type === 'structure')
    ).toHaveLength(1);
  });

  it('clears old evidence while retaining neutral reference context for the next clone', () => {
    openStructureInspection(request);
    clearStructureInspection(documentId, 'Select a mutation from Clone 8.');
    const state = useCanvasStore.getState();
    const tab = state.findTab('structure', structureInspectionId(documentId))!;
    const inspection = state.panels[tab.panelId].tabs[0].structureInspection!;
    expect(inspection.request.variantContext).toBeUndefined();
    expect(inspection.request.translation).toBe('MAG');
    expect(inspection.message).toBe('Select a mutation from Clone 8.');
    clearStructureInspection(documentId, inspection.message!);
    expect(useCanvasStore.getState()).toBe(state);
  });
});

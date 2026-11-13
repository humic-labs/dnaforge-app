import { describe, it, expect, afterEach } from 'vitest';
import { useCanvasStore } from '../../features/canvas/store';
import { useSequenceStore } from '../../features/sequence/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { applyScenario, resetAllStores } from './apply';
import { typicalSession, freshSession, editingSession } from './presets';
import { withPUC19, withGFP, PUC19 } from './sequences';
import { withStandardWorkspace } from './workspace';
import { withChatTab, withSplitLayout } from './canvas';
import { sidecarScenarios } from './sidecar';

const PUC19_DOCUMENT_ID = 'fixture:sequence:puc19';
const GFP_DOCUMENT_ID = 'fixture:sequence:gfp';

afterEach(() => {
  resetAllStores();
});

describe('applyScenario integration', () => {
  it('typicalSession hydrates all stores', () => {
    applyScenario(typicalSession());

    const canvas = useCanvasStore.getState();
    const allTabs = Object.values(canvas.panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(1);
    expect(allTabs[0].entityId).toBe(PUC19_DOCUMENT_ID);

    const seq = useSequenceStore.getState().sequences[PUC19_DOCUMENT_ID];
    expect(seq).toBeDefined();
    expect(seq.name).toBe('pUC19');

    expect(useWorkspaceStore.getState().folders).toHaveLength(2);

    expect(global.fetch).toBeDefined();
  });

  it('freshSession has only sidecar mocked', () => {
    applyScenario(freshSession());

    const canvas = useCanvasStore.getState();
    expect(canvas.panels.main.tabs).toHaveLength(0);

    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(0);

    expect(useWorkspaceStore.getState().folders).toHaveLength(0);

    expect(global.fetch).toBeDefined();
  });

  it('editingSession has pUC19 but no workspace', () => {
    applyScenario(editingSession());

    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(1);
    expect(useSequenceStore.getState().sequences[PUC19_DOCUMENT_ID]).toBeDefined();
    expect(useWorkspaceStore.getState().folders).toHaveLength(0);
  });

  it('modifiers compose without mutation', () => {
    const base = freshSession();
    const modified = withPUC19(base);

    expect(base.sequences).toBeUndefined();
    expect(base.canvas).toBeUndefined();

    expect(modified.sequences).toBeDefined();
    expect(modified.canvas?.tabs).toHaveLength(1);
  });

  it('multiple sequences compose', () => {
    const scenario = withGFP(withPUC19({ sidecar: sidecarScenarios.fullyReady() }));
    applyScenario(scenario);

    const seqs = useSequenceStore.getState().sequences;
    expect(Object.keys(seqs)).toHaveLength(2);
    expect(seqs[PUC19_DOCUMENT_ID]).toBeDefined();
    expect(seqs[GFP_DOCUMENT_ID]).toBeDefined();

    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(2);
  });

  it('split layout creates two panels', () => {
    const scenario = withSplitLayout(
      withGFP(withPUC19({ sidecar: sidecarScenarios.fullyReady() })),
      'split-vertical'
    );
    applyScenario(scenario);

    const canvas = useCanvasStore.getState();
    const panelIds = Object.keys(canvas.panels);
    expect(panelIds.length).toBe(2);
    expect(canvas.layout.type).toBe('split');
  });

  it('workspace + chat tab compose', () => {
    const scenario = withChatTab(withStandardWorkspace({ sidecar: sidecarScenarios.fullyReady() }));
    applyScenario(scenario);

    const allTabs = Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs);
    expect(allTabs).toHaveLength(1);
    expect(allTabs[0].type).toBe('chat');

    expect(useWorkspaceStore.getState().folders).toHaveLength(2);
  });

  it('resetAllStores clears everything', () => {
    applyScenario(typicalSession());

    expect(
      Object.values(useCanvasStore.getState().panels).flatMap((p) => p.tabs).length
    ).toBeGreaterThan(0);

    resetAllStores();

    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
    expect(useSequenceStore.getState().sequences).toEqual({});
    expect(useWorkspaceStore.getState().folders).toHaveLength(0);
  });

  it('sequential applyScenario calls are independent', () => {
    applyScenario(typicalSession());
    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(1);

    applyScenario(freshSession());
    expect(Object.keys(useSequenceStore.getState().sequences)).toHaveLength(0);
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });
});

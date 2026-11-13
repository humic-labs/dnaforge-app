import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './store';
import { presentDocument } from './present-document';

describe('document presentation through the real canvas', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
  });

  const notebook = { type: 'page', entityId: 'workspace-a::notebook', label: 'Notes' } as const;

  it('reports actual creation/reuse and preserves separate focused-panel copies', () => {
    const first = presentDocument(notebook, { kind: 'focused' });
    expect(first).toMatchObject({ status: 'presented', disposition: 'created', panelId: 'main' });
    expect(presentDocument(notebook, { kind: 'focused' })).toMatchObject({
      ...first,
      disposition: 'reused',
    });
    const right = useCanvasStore.getState().splitPanel('main', 'vertical');
    const second = presentDocument(notebook, { kind: 'panel', panelId: right });
    expect(second).toMatchObject({ status: 'presented', disposition: 'created', panelId: right });
    expect(useCanvasStore.getState().panels[right].tabs).toHaveLength(1);
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expect(presentDocument(notebook, { kind: 'smart' })).toMatchObject({
      ...first,
      disposition: 'reused',
    });
  });

  it('keeps equal labels with different scoped identities separate', () => {
    presentDocument(notebook);
    presentDocument({ ...notebook, entityId: 'workspace-b::notebook' });
    expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.entityId)).toEqual([
      'workspace-a::notebook',
      'workspace-b::notebook',
    ]);
  });

  it('reports absent destination panels without claiming a presentation', () => {
    expect(presentDocument(notebook, { kind: 'panel', panelId: 'removed' })).toMatchObject({
      status: 'failed',
    });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });

  it('distinguishes loading, missing and error views from ready content', () => {
    for (const content of ['loading', 'missing', 'error', 'ready'] as const) {
      expect(presentDocument(notebook, { kind: 'focused' }, content)).toMatchObject({
        status: 'presented',
        content,
      });
    }
  });
});

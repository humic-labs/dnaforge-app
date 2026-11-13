import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { describe, it, expect, beforeEach } from 'vitest';
import { closeTabTool } from './close-tab';
import { useCanvasStore } from '../../canvas/store';
import { resetCanvasStore, mockUUID, execTool as executeTool } from './test-helpers';

mockUUID();

beforeEach(() => {
  resetCanvasStore();
});

describe('close_tab tool', () => {
  it('closes active tab in focused panel', async () => {
                       
    const store = useCanvasStore.getState();
    store.openInFocusedPanel('sequence', 'sequence-test', 'Test', {
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-test' },
    });
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);

    const result = await execTool<{ closed: boolean }>(closeTabTool, {});

    expect(result.closed).toBe(true);
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('reports a successful no-op when no panel is focused', async () => {
    useCanvasStore.setState({ focusedPanelId: null });

    const result = await execTool<{ closed: boolean; message?: string }>(closeTabTool, {});

    expect(result.closed).toBe(false);
    expect(result.message).toMatch(/no panel/i);
  });

  it('reports a successful no-op when the panel has no active tab', async () => {
    const result = await execTool<{ closed: boolean; message?: string }>(closeTabTool, {});

    expect(result.closed).toBe(false);
    expect(result.message).toMatch(/no tab/i);
  });

  it('closes only active tab when multiple open', async () => {
    const store = useCanvasStore.getState();
    store.openInFocusedPanel('sequence', 'sequence-a', 'A', {
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-a' },
    });
    store.openInFocusedPanel('sequence', 'sequence-b', 'B', {
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-b' },
    });
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(2);

    await execTool(closeTabTool, {});

    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
  });

  it('requests confirmation instead of directly closing a dirty tab', async () => {
    const store = useCanvasStore.getState();
    store.openInFocusedPanel('sequence', 'sequence-dirty', 'Dirty', {
      sequenceDocument: { kind: 'catalog-sequence', entityId: 'sequence-dirty' },
    });
    const tab = useCanvasStore.getState().panels.main.tabs[0];
    store.updateTab('main', tab.id, { isDirty: true });

    const closeRequests: Array<{ panelId: string; tabIds: string[] }> = [];
    const listener = (event: WindowEventMap['artifact-document-close-request']) => {
      closeRequests.push(event.detail);
    };
    window.addEventListener('artifact-document-close-request', listener);

    try {
      const result = await execTool<{
        closed: boolean;
        confirmationRequired?: boolean;
      }>(closeTabTool, {});

      expect(result).toMatchObject({ closed: false, confirmationRequired: true });
      expect(closeRequests).toEqual([{ panelId: 'main', tabIds: [tab.id] }]);
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    } finally {
      window.removeEventListener('artifact-document-close-request', listener);
    }
  });

  it('requests confirmation for the dirty content tab while the chat panel is focused', async () => {
    const store = useCanvasStore.getState();
    const contentTabId = store.openTab('main', {
      type: 'sequence',
      entityId: 'track-view-unsaved',
      label: 'Unsaved view',
      isDirty: true,
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'track-view-unsaved' },
    });
    const chatPanelId = store.splitPanel('main', 'vertical');
    store.openTab(chatPanelId, { type: 'chat', entityId: 'conversation', label: 'Chat' });
    store.focusPanel(chatPanelId);

    const closeRequests: Array<{ panelId: string; tabIds: string[] }> = [];
    const listener = (event: WindowEventMap['artifact-document-close-request']) => {
      closeRequests.push(event.detail);
    };
    window.addEventListener('artifact-document-close-request', listener);

    try {
      const result = await execTool<{
        closed: boolean;
        confirmationRequired?: boolean;
      }>(closeTabTool, {});

      expect(result).toMatchObject({ closed: false, confirmationRequired: true });
      expect(closeRequests).toEqual([{ panelId: 'main', tabIds: [contentTabId] }]);
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    } finally {
      window.removeEventListener('artifact-document-close-request', listener);
    }
  });
});

import { closeTabOutputSchema } from './close-tab';

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
    assertMcpOutput(closeTabOutputSchema, result);
  }
  return result;
}

import { describe, expect, it } from 'vitest';
import { partializeCanvasState, useCanvasStore } from './store';

describe('native molecular document canvas persistence', () => {
  it('retains a document pointer while leaving scene and source bytes in their authoritative file', () => {
    const attrs = {
      source: 'file' as const,
      sourceId: 'ATOM full source bytes',
      label: 'Pocket',
      molViewSpec: '{"kind":"single","root":{"kind":"root"}}',
      molViewSpecSavedReferenceId: 'result',
      molecularDocumentId: 'document',
      molecularDocumentPath: '/project/Pocket.dnaforge-molecular.json',
      molecularDocumentRevision: 'revision',
      molecularDocumentSavedReferenceId: 'result',
    };
    const live = useCanvasStore.getState();
    const state = {
      ...live,
      panels: {
        main: {
          id: 'main',
          activeTabId: 'tab',
          tabs: [
            {
              id: 'tab',
              type: 'structure' as const,
              entityId: 'molecular-document:document',
              label: 'Pocket',
              initialStructureAttrs: attrs,
              structureRenderError: 'The renderer failed.',
            },
          ],
        },
      },
      layout: { type: 'panel' as const, panelId: 'main' },
      focusedPanelId: 'main',
    };
    const durable = partializeCanvasState(state);
    const tab = durable.panels.main.tabs[0];
    expect(tab).not.toHaveProperty('structureRenderError');
    const pointer = tab.initialStructureAttrs!;
    expect(pointer.molecularDocumentPath).toBe(attrs.molecularDocumentPath);
    expect(pointer.molecularDocumentId).toBe('document');
    expect(pointer.molViewSpec).toBeUndefined();
    expect(pointer.sourceId).toBe('');
    expect(state.panels.main.tabs[0].initialStructureAttrs.sourceId).toBe('ATOM full source bytes');
  });
});

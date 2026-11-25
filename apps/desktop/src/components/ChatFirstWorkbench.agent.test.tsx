import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { expect, it, vi } from 'vitest';
import { ChatFirstOutputBoundary } from './ChatFirstWorkbench';
import { registerNotebookEditorControl } from '../features/page/public/notebook-editor-control';
import { createNotebookDocumentTool } from '../features/ai/tools/notebook-document';
import { execTool } from '../features/ai/tools/test-helpers';

const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../features/page/public/store', () => ({ usePageStore: { getState: state.get } }));
vi.mock('../features/page/public/resolve-owning-root-for-page', () => ({
  resolveOwningRootForPage: async () => '/synthetic-project',
}));

it('edits and saves through the actual notebook agent tool while its mounted output stays inert', async () => {
  const pageId = 'ws1::11111111-1111-4111-8111-111111111111';
  const content = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initial result' }] }],
  };
  const page = { id: pageId, title: 'Synthetic result', content };
  state.get.mockReturnValue({
    pages: { [pageId]: page },
    fetchPage: async () => page,
    dirtyIds: new Set(),
  });
  const editor = new Editor({ extensions: [StarterKit], content });
  const save = vi.fn(async () => true);
  const unregister = registerNotebookEditorControl(pageId, { editor, save });
  const mounted = render(
    <ChatFirstOutputBoundary conversation={false}>
      <div data-testid="native-output" />
    </ChatFirstOutputBoundary>
  );
  const host = screen.getByTestId('native-output');
  host.append(editor.view.dom);
  try {
    const tool = createNotebookDocumentTool([
      { path: '/synthetic-project', name: 'Synthetic project', addedAt: 1 },
    ]);
    const inspected = await execTool<{ revision: string }>(tool, {
      pageId,
      operation: { kind: 'inspect', offset: 0, limit: 20 },
    });
    await act(async () => {
      const edited = await execTool(tool, {
        pageId,
        expectedRevision: inspected.revision,
        operation: {
          kind: 'splice-blocks',
          index: 0,
          deleteCount: 1,
          blocks: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Agent produced this result' }] },
          ],
        },
      });
      expect(edited).toMatchObject({ changed: true });
    });
    expect(screen.getByText('Agent produced this result')).toBeTruthy();
    expect(editor.isEditable).toBe(true);
    expect(host.parentElement?.getAttribute('data-ai-input-region')).toBe('output');
    const current = await execTool<{ revision: string }>(tool, {
      pageId,
      operation: { kind: 'inspect', offset: 0, limit: 20 },
    });
    await execTool(tool, {
      pageId,
      expectedRevision: current.revision,
      operation: { kind: 'save' },
    });
    expect(save).toHaveBeenCalledOnce();
  } finally {
    unregister();
    editor.destroy();
    mounted.unmount();
  }
});

import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotebookColumn, NotebookColumns } from './notebook-layout';
import { EmbedNode } from './embed-node';
import { embedRegistry } from '../../embeds/registry';
import { TableRenderer } from '../../embeds/table/Renderer';

vi.mock('../../../../lib/analytics', async (original) => ({
  ...(await original<typeof import('../../../../lib/analytics')>()),
  isAnalyticsCaptureReady: () => false,
  captureAnalyticsOptionalOrigin: () => null,
}));
vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  return { usePageStore: create(() => ({ dirtyIds: new Set<string>() })) };
});
vi.mock('../../../canvas/public/store', async () => {
  const { create } = await import('zustand');
  return {
    useCanvasStore: create(() => ({
      panels: {},
      openWithSmartPlacement: vi.fn(),
      updateTab: vi.fn(),
    })),
  };
});

let editor: Editor | null = null;
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

it('edits a table through its actual node view inside a notebook column', async () => {
  embedRegistry.register({
    type: 'table',
    version: 1,
    label: 'Table',
    icon: 'Table',
    Renderer: TableRenderer,
  });
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      NotebookColumns,
      NotebookColumn,
      EmbedNode,
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'notebookColumns',
          attrs: { layout: 'three-columns' },
          content: [
            { type: 'notebookColumn', content: [{ type: 'paragraph' }] },
            { type: 'notebookColumn', content: [{ type: 'paragraph' }] },
            {
              type: 'notebookColumn',
              content: [
                {
                  type: 'embed',
                  attrs: {
                    type: 'table',
                    version: 1,
                    refId: 'column-table',
                    data: { rows: 2, cols: 2, cells: [] },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  });
  render(<EditorContent editor={editor} />);
  const grid = await screen.findByTestId('table-grid');
  const cell = grid.querySelector('[data-cell-position="0,0"]');
  if (!cell) throw new Error('Missing first data cell');
  fireEvent.doubleClick(cell);
  await waitFor(() => expect(cell.querySelector('input')).not.toBeNull());
  const input = cell.querySelector('input')!;
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: 'Sample A' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(cell).toHaveTextContent('Sample A'));
  act(() => {
    editor!.commands.setTextSelection(3);
    editor!.commands.setNotebookLayout('wide-left');
  });
  expect(await screen.findByTestId('table-grid')).toHaveTextContent('Sample A');
  expect(
    editor.getJSON().content?.[0].content?.[1].content?.[1].attrs?.data.cells[0][0].value
  ).toBe('Sample A');
});

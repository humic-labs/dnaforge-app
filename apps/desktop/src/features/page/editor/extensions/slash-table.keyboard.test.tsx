import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { installVisibleEditorGeometry } from '../../../../test/visible-editor-geometry';
import { EmbedNode } from './embed-node';
import { SlashCommandsExtension } from './slash-commands';
import { embedRegistry } from '../../embeds/registry';
import '../../embeds/table/definition';

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
    useCanvasStore: create(() => ({ panels: {}, openWithSmartPlacement: vi.fn() })),
  };
});

let editor: Editor | null = null;
let restoreGeometry: () => void;
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const getClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const getBoundingClientRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect'
);

beforeAll(() => {
  restoreGeometry = installVisibleEditorGeometry();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
});
afterAll(() => {
  restoreGeometry();
  for (const [target, key, descriptor] of [
    [Element.prototype, 'scrollIntoView', scrollIntoView],
    [Range.prototype, 'getClientRects', getClientRects],
    [Range.prototype, 'getBoundingClientRect', getBoundingClientRect],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

it('selects the slash Table command and configures and edits its real node view with the keyboard', async () => {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      EmbedNode,
      SlashCommandsExtension.configure({
        commands: embedRegistry.getSlashCommands(),
        onFlowCommand: (command) => {
          if (!editor || !command.flowName) throw new Error('Missing slash-command table flow');
          expect(
            embedRegistry.completePickerFlow(
              command.flowName,
              editor,
              {},
              editor.state.selection.from
            )
          ).toBe(true);
        },
      }),
    ],
    content: '<p></p>',
  });
  render(<EditorContent editor={editor} />);
  act(() => {
    editor!.view.dom.focus();
    editor!.commands.insertContent('/table');
  });
  expect(await screen.findByRole('option', { name: /Table$/ })).toBeVisible();
  fireEvent.keyDown(editor.view.dom, { key: 'Enter' });

  const rows = await screen.findByLabelText('rows');
  const columns = screen.getByLabelText('cols');
  await waitFor(() => expect(rows).toHaveFocus(), { onTimeout: (error) => error });
  fireEvent.change(rows, { target: { value: '4' } });
  fireEvent.keyDown(rows, { key: 'Tab' });
  expect(columns).toHaveFocus();
  fireEvent.change(columns, { target: { value: '3' } });
  fireEvent.keyDown(columns, { key: 'Tab', shiftKey: true });
  expect(rows).toHaveFocus();
  fireEvent.keyDown(rows, { key: 'Tab' });
  expect(columns).toHaveFocus();
  fireEvent.keyDown(columns, { key: 'Enter' });

  const sink = await screen.findByLabelText('Table keyboard navigation');
  await waitFor(() => expect(sink).toHaveFocus(), { onTimeout: (error) => error });
  fireEvent.keyDown(sink, { key: 'S' });
  const input = screen
    .getByTestId('table-grid')
    .querySelector<HTMLInputElement>('[data-cell-position="0,0"] input');
  await waitFor(() => expect(input).toHaveFocus(), { onTimeout: (error) => error });
  fireEvent.change(input!, { target: { value: 'Sample A' } });
  fireEvent.keyDown(input!, { key: 'Enter' });

  await waitFor(() => {
    const table = editor!.getJSON().content?.find((node) => node.type === 'embed')?.attrs?.data;
    expect(table?.rows).toBe(4);
    expect(table?.cols).toBe(3);
    expect(table?.cells?.[0]?.[0]?.value).toBe('Sample A');
  });
});

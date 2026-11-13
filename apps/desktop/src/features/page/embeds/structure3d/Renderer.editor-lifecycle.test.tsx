// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import type { ReactNode } from 'react';
import { Structure3dRenderer } from './Renderer';
import { EmbedNode } from '../../editor/extensions/embed-node';

vi.mock('../registry', () => ({
  embedRegistry: {
    getRenderer: () => Structure3dRenderer,
    get: () => ({ version: 1 }),
  },
}));
vi.mock('../table/notebook-observation', () => ({
  openTableNotebookView: vi.fn(),
  updateTableNotebookAttributes: vi.fn(),
}));

vi.mock('../components/EmbedWrapper', () => ({
  EmbedWrapper: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./components/InlineSearch', () => ({ InlineSearch: () => <div>Structure source</div> }));
vi.mock('./components/LazyLoadedViewer', () => ({
  LazyLoadedViewer: () => <div>Structure viewer</div>,
}));
vi.mock('./store', () => ({
  useStructure3dStore: (selector: (state: unknown) => unknown) =>
    selector({ registerStructure: vi.fn(), expandedStructures: {} }),
}));
vi.mock('../../../canvas/public/store', () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ panels: {}, openWithSmartPlacement: vi.fn() }),
}));

function StructureNodeView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper>
      <Structure3dRenderer
        type="structure3d"
        refId="editor-lifecycle"
        attrs={node.attrs.data}
        selected={false}
        onRemove={() => {}}
        onUpdateAttrs={(patch) => updateAttributes({ data: { ...node.attrs.data, ...patch } })}
      />
    </NodeViewWrapper>
  );
}

const StructureNode = Node.create({
  name: 'structureLifecycle',
  group: 'block',
  atom: true,
  addAttributes: () => ({ data: { default: {} } }),
  parseHTML: () => [{ tag: 'div[data-structure-lifecycle]' }],
  renderHTML: () => ['div', { 'data-structure-lifecycle': '' }],
  addNodeView: () => ReactNodeViewRenderer(StructureNodeView),
});

describe('structure embed editor lifecycle', () => {
  let editor: Editor | undefined;
  afterEach(() => {
    editor?.destroy();
    vi.restoreAllMocks();
  });

  it('persists a generated structure identity without reentering the React commit', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    editor = new Editor({ extensions: [StarterKit, StructureNode], content: '<p>Notebook</p>' });
    render(<EditorContent editor={editor} />);
    await waitFor(() => expect(editor?.isInitialized).toBe(true));

    act(() => {
      editor?.commands.insertContent({
        type: 'structureLifecycle',
        attrs: { data: { label: 'Keep me' } },
      });
    });

    await waitFor(() => {
      const structure = editor
        ?.getJSON()
        .content?.find((node) => node.type === 'structureLifecycle');
      expect(structure?.attrs?.data).toEqual({
        id: expect.stringMatching(/^structure-/),
        label: 'Keep me',
      });
    });
    expect(
      errors.mock.calls
        .map((args) => args.join(' '))
        .filter((message) => message.includes('flushSync'))
    ).toEqual([]);
  });

  it('keeps a hydrated empty block clean and persists a newly inserted block identity', async () => {
    const changes = vi.fn();
    editor = new Editor({
      extensions: [StarterKit, EmbedNode],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph' },
          { type: 'embed', attrs: { type: 'structure3d', refId: 'legacy', data: {} } },
          { type: 'paragraph' },
        ],
      },
      onUpdate: changes,
    });
    render(<EditorContent editor={editor} />);
    await waitFor(() => expect(editor?.isInitialized).toBe(true));
    await act(async () => {});
    const data = (refId: string) =>
      editor?.getJSON().content?.find((node) => node.attrs?.refId === refId)?.attrs?.data;
    expect(data('legacy')).toEqual({});
    expect(changes).not.toHaveBeenCalled();

    act(() => {
      editor?.commands.insertEmbed({
        type: 'structure3d',
        refId: 'created',
        data: { label: 'Keep me' },
      });
    });
    await waitFor(() =>
      expect(data('created')).toEqual({
        id: expect.stringMatching(/^structure-/),
        label: 'Keep me',
      })
    );
    expect(data('legacy')).toEqual({});
    expect(changes).toHaveBeenCalled();
  });
});

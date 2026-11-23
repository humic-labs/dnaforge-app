// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { installVisibleEditorGeometry } from '../../../../test/visible-editor-geometry';

const { search, category } = vi.hoisted(() => ({
  search: vi.fn(),
  category: {
    key: 'type:primer',
    label: 'Primer',
    terms: ['primer'],
    filter: { role: 'primer' as const },
    iconKind: 'primer',
    browse: false,
  },
}));

vi.mock('../../../../platform', () => ({
  platform: () => ({
    entityDiscovery: {
      search,
      types: async () => ({ items: [category] }),
      resolve: async ({ ids }: { ids: string[] }) => ({
        items: ids.map((id) => ({
          id,
          status: 'available',
          entity: {
            id,
            type: 'primer',
            name: 'M13 Forward',
            path: 'primers/M13.primer.json',
            projectId: 'repo-beta',
            projectName: 'Beta',
          },
        })),
      }),
    },
  }),
}));
vi.mock('../../../../services/recent-entity-views', () => ({
  useEntityViewHistory: { getState: () => ({ views: [] }) },
}));

import { MentionExtension } from './mention';
import { SlashCommandsExtension } from './slash-commands';

let editor: Editor | null = null;
let restoreGeometry: () => void;

beforeAll(() => {
  restoreGeometry = installVisibleEditorGeometry();
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => restoreGeometry());

beforeEach(() => {
  search.mockReset().mockImplementation(async ({ query, filter }) => ({
    items:
      filter?.role === 'primer' || query === 'M13'
        ? [
            {
              id: 'primer-beta',
              type: 'primer',
              name: 'M13 Forward',
              path: 'primers/M13.primer.json',
              projectId: 'repo-beta',
              projectName: 'Beta',
            },
          ]
        : [],
    nextCursor: null,
    generation: 'fixture-generation',
    coverage: { catalog: 1, registry: 0, primers: 0, excluded: 0 },
  }));
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

function mount() {
  const flow = vi.fn();
  editor = new Editor({
    extensions: [
      StarterKit,
      MentionExtension,
      SlashCommandsExtension.configure({
        commands: [
          {
            name: 'primer',
            label: 'Primer',
            description: '',
            icon: '',
            keywords: ['primer'],
            category: 'embed',
            flowName: 'primer',
          },
        ],
        onFlowCommand: flow,
      }),
    ],
    content: '<p></p>',
  });
  render(<EditorContent editor={editor} />);
  act(() => {
    editor!.view.dom.focus();
  });
  return flow;
}

it('browses from @ then clears its category on Escape before another direct-name search', async () => {
  mount();
  act(() => {
    editor!.commands.insertContent('@primer');
  });
  fireEvent.click(await screen.findByRole('option', { name: 'Browse Primer' }));
  expect(await screen.findByTestId('mention-active-category')).toHaveTextContent('Primer');
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: '', filter: category.filter })
    )
  );
  fireEvent.keyDown(editor!.view.dom, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByTestId('mention-menu')).toBeNull());
  act(() => {
    editor!.commands.setContent('<p></p>');
    editor!.commands.insertContent('@M13');
  });
  expect(await screen.findByTestId('mention-menu-item')).toHaveTextContent('M13 Forward');
  expect(screen.queryByTestId('mention-active-category')).toBeNull();
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'M13' }));
  expect(search.mock.lastCall?.[0]).not.toHaveProperty('filter');
});

it('uses the same inline picker for /primer and inserts the exact project reference with Enter', async () => {
  const flow = mount();
  act(() => {
    editor!.commands.insertContent('/primer');
  });
  expect(await screen.findByRole('option', { name: /^Link primer$/i })).toBeVisible();
  fireEvent.keyDown(editor!.view.dom, { key: 'Enter' });
  expect(await screen.findByTestId('mention-active-category')).toHaveTextContent('Primer');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(flow).not.toHaveBeenCalled();
  expect(editor!.getText()).toBe('@');
  expect(await screen.findByTestId('mention-menu-item')).toHaveTextContent('Beta');
  fireEvent.keyDown(editor!.view.dom, { key: 'Enter' });
  await waitFor(() => {
    const mention = editor!.getJSON().content?.[0].content?.find((node) => node.type === 'mention');
    expect(mention?.attrs).toMatchObject({
      entityId: 'primer-beta',
      path: 'primers/M13.primer.json',
      projectId: 'repo-beta',
    });
  });
  expect(editor!.getText()).not.toContain('/primer');
});

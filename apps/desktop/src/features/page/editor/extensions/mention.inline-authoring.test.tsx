// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { installVisibleEditorGeometry } from '../../../../test/visible-editor-geometry';

const fixtures = vi.hoisted(() => ({
  search: vi.fn(),
  category: {
    key: 'type:primer',
    label: 'Primer',
    terms: ['primer'],
    filter: { role: 'primer' as const },
    iconKind: 'primer',
    browse: false,
  },
  primer: {
    id: 'existing-primer-beta',
    type: 'primer' as const,
    name: 'M13 Forward',
    path: 'primers/M13.primer.json',
    projectId: 'repo-beta',
    projectName: 'Beta',
  },
}));
vi.mock('../../../../platform', () => ({
  platform: () => ({
    entityDiscovery: {
      search: fixtures.search,
      types: async () => ({ items: [fixtures.category] }),
      resolve: async ({ ids }: { ids: string[] }) => ({
        items: ids.map((id) => ({ id, status: 'available', entity: { ...fixtures.primer, id } })),
      }),
    },
  }),
}));
vi.mock('../../../../services/recent-entity-views', () => ({
  useEntityViewHistory: { getState: () => ({ views: [] }) },
}));
vi.mock('../../../molecular-documents/public/references', () => ({
  resolveMolecularReferenceRecord: async () => null,
}));
import { MentionExtension } from './mention';
import { SlashCommandsExtension } from './slash-commands';

let editor: Editor | null = null;
let restoreGeometry: () => void;
const savedReferenceUri = 'dnaforge-chat://reference/0479adef-aaf8-41cf-a996-6045adfa2736';
beforeAll(() => {
  restoreGeometry = installVisibleEditorGeometry();
  Element.prototype.scrollIntoView = vi.fn();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => restoreGeometry());
beforeEach(() => {
  fixtures.search.mockReset().mockImplementation(async ({ query, filter }) => ({
    items:
      filter?.role === 'primer' || query.toLowerCase().includes('m13') ? [fixtures.primer] : [],
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
function mount(
  content: JSONContent | string = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Protected prose ' }] }],
  }
) {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      MentionExtension,
      SlashCommandsExtension.configure({
        commands: [
          {
            name: 'heading',
            label: 'Heading 1',
            description: '',
            icon: 'H',
            keywords: ['heading'],
            category: 'format',
          },
          {
            name: 'table',
            label: 'Table',
            description: '',
            icon: 'T',
            keywords: ['table'],
            category: 'embed',
          },
        ],
      }),
    ],
    content,
  });
  render(<EditorContent editor={editor} />);
  act(() => {
    editor!.view.dom.focus();
    editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
  });
  return editor;
}
function insert(text: string) {
  act(() => {
    editor!.commands.insertContent(text);
  });
}
function backspace() {
  let handled = false;
  act(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    editor!.view.someProp('handleKeyDown', (handler) => {
      if (!handler(editor!.view, event)) return false;
      handled = true;
      return true;
    });
    if (!handled) {
      const { from, to, empty } = editor!.state.selection;
      editor!.commands.deleteRange({ from: empty ? Math.max(1, from - 1) : from, to });
    }
  });
  return handled;
}
function mentions() {
  const found: JSONContent[] = [];
  editor!.state.doc.descendants((node) => {
    if (node.type.name === 'mention') found.push(node.toJSON());
  });
  return found;
}
async function chooseSlashPrimer() {
  insert('/primer');
  fireEvent.click(await screen.findByRole('option', { name: /Primer$/i }));
  await screen.findByTestId('mention-active-category');
}
it.each(['@', '/'] as const)(
  'keeps %s inline and the same dropdown open through typing across a formatting boundary',
  async (prefix) => {
    const before = 'Before\u00a0';
    const ed = mount({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: before + ' afterwards' }] }],
    });
    act(() => {
      ed.commands.setTextSelection(1 + before.length);
    });
    insert(prefix);
    const testId = prefix === '@' ? 'mention-menu' : 'slash-command-menu';
    const popup = await screen.findByTestId(testId);
    insert('M');
    act(() => {
      ed.commands.toggleBold();
    });
    insert('1');
    insert('3');
    await waitFor(() => expect(screen.getByTestId(testId)).toBe(popup));
    expect(ed.getText()).toBe(before + prefix + 'M13 afterwards');
    expect(ed.state.selection.from).toBe(1 + before.length + 4);
    expect(ed.view.hasFocus()).toBe(true);
    expect(
      Array.from(ed.view.dom.querySelectorAll('[data-entity-query]'))
        .map((el) => el.textContent)
        .join('')
    ).toBe(prefix + 'M13');
    expect(within(popup).queryByRole('textbox')).toBeNull();
    if (prefix === '@') expect(await within(popup).findByText('M13 Forward')).toBeVisible();
  }
);

it.each(['review@example.com', 'folder/file', '@ literal', '/ literal'])(
  'keeps %s as ordinary notebook text',
  async (value) => {
    const ed = mount();
    for (const char of value) insert(char);
    await act(async () => {});
    expect(ed.getText()).toBe('Protected prose ' + value);
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    expect(screen.queryByTestId('slash-command-menu')).toBeNull();
  }
);

it('keeps the query in editable prose with only an ephemeral theme decoration', async () => {
  const ed = mount({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before  after.' }] }],
  });
  act(() => {
    ed.commands.setTextSelection(8);
  });
  insert('@M13');
  await screen.findByTestId('mention-menu-item');
  expect(ed.getText()).toBe('Before @M13 after.');
  expect(ed.state.doc.child(0).child(0).isText).toBe(true);
  expect(ed.state.doc.child(0).child(0).text).toBe('Before @M13 after.');
  expect(within(screen.getByTestId('mention-menu')).queryByRole('textbox')).toBeNull();
  expect(screen.queryByTestId('mention-menu-search')).toBeNull();
  const decorated = ed.view.dom.querySelector('[data-entity-query]');
  expect(decorated).not.toBeNull();
  expect(decorated?.textContent).toBe('@M13');
  expect(decorated).toHaveClass('text-accent');
  expect(JSON.stringify(ed.getJSON())).not.toMatch(/entity-query|text-accent|textStyle/);
  const beforeCancel = ed.getJSON();
  fireEvent.keyDown(ed.view.dom, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByTestId('mention-menu')).toBeNull());
  expect(ed.view.dom.querySelector('[data-entity-query]')).toBeNull();
  expect(ed.getJSON()).toEqual(beforeCancel);
});
it('keeps the primer role shortcut out of the default type list and exposes it on search', async () => {
  mount();
  insert('/');
  expect(await screen.findByRole('option', { name: /Link an entity$/ })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Format' })).toBeVisible();
  expect(screen.getByRole('group', { name: 'Embed' })).toBeVisible();
  const entity = screen.getByRole('group', { name: 'Entity' });
  expect(within(entity).getAllByRole('option')).toHaveLength(1);
  expect(screen.queryByRole('option', { name: /^Link primer$/i })).toBeNull();
  insert('primer');
  expect(await screen.findByRole('option', { name: /^Link primer$/i })).toBeVisible();
});
it('deletes a nonempty query normally without leaving its category', async () => {
  mount();
  await chooseSlashPrimer();
  insert('M13');
  await waitFor(() =>
    expect(fixtures.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'M13', filter: fixtures.category.filter })
    )
  );
  expect(backspace()).toBe(false);
  expect(editor!.getText()).toBe('Protected prose @M1');
  expect(screen.getByTestId('mention-active-category')).toHaveTextContent('Primer');
  await waitFor(() =>
    expect(fixtures.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'M1', filter: fixtures.category.filter })
    )
  );
});
it('backs out of an empty slash category to its original query without deleting prose', async () => {
  mount();
  await chooseSlashPrimer();
  expect(editor!.getText()).toBe('Protected prose @');
  expect(backspace()).toBe(true);
  expect(await screen.findByRole('option', { name: /^Link primer$/i })).toBeVisible();
  expect(editor!.getText()).toBe('Protected prose /primer');
  expect(screen.queryByTestId('mention-menu')).toBeNull();
});
it.each(['', 'Protected prose '])(
  'cancels a bare @ without deleting preceding prose %j',
  async (prose) => {
    mount({
      type: 'doc',
      content: [{ type: 'paragraph', content: prose ? [{ type: 'text', text: prose }] : [] }],
    });
    insert('@');
    await screen.findByTestId('mention-menu');
    expect(backspace()).toBe(true);
    expect(editor!.getText()).toBe(prose);
    await waitFor(() => expect(screen.queryByTestId('mention-menu')).toBeNull());
  }
);
it.each(['', 'Protected prose '])(
  'cancels a bare slash without deleting preceding prose %j',
  async (prose) => {
    mount({
      type: 'doc',
      content: [{ type: 'paragraph', content: prose ? [{ type: 'text', text: prose }] : [] }],
    });
    insert('/');
    await screen.findByRole('option', { name: /Link an entity$/ });
    expect(backspace()).toBe(true);
    expect(editor!.getText()).toBe(prose);
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /Link an entity$/ })).toBeNull()
    );
  }
);
it('returns generic entity search to its empty slash parent then cancels the slash', async () => {
  mount();
  insert('/');
  fireEvent.click(await screen.findByRole('option', { name: /Link an entity$/ }));
  await screen.findByTestId('mention-menu');
  expect(backspace()).toBe(true);
  expect(await screen.findByRole('option', { name: /Link an entity$/ })).toBeVisible();
  expect(editor!.getText()).toBe('Protected prose /');
  expect(backspace()).toBe(true);
  expect(editor!.getText()).toBe('Protected prose ');
  await waitFor(() => expect(screen.queryByRole('option', { name: /Link an entity$/ })).toBeNull());
});
it('replaces only the query and preserves surrounding prose and an existing saved chip through JSON roundtrip and edits', async () => {
  const ed = mount({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Before ' },
          {
            type: 'mention',
            attrs: {
              entityType: 'reference',
              label: 'Existing chip',
              referenceUri: savedReferenceUri,
            },
          },
          { type: 'text', text: ' middle  after.' },
        ],
      },
    ],
  });
  const existing = mentions()[0];
  let gap = -1;
  ed.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(' middle '))
      gap = pos + node.text.indexOf(' middle ') + ' middle '.length;
  });
  expect(gap).toBeGreaterThan(0);
  act(() => {
    ed.commands.setTextSelection(gap);
  });
  insert('@M13');
  fireEvent.click(await screen.findByTestId('mention-menu-item'));
  await waitFor(() => expect(mentions()).toHaveLength(2));
  expect(ed.getText()).toBe('Before Existing chip middle M13 Forward after.');
  expect(mentions()[0]).toEqual(existing);
  expect(mentions()[1].attrs).toMatchObject({
    entityId: fixtures.primer.id,
    path: fixtures.primer.path,
    projectId: fixtures.primer.projectId,
  });
  expect(ed.view.dom.querySelector('[data-entity-query]')).toBeNull();
  const saved = JSON.parse(JSON.stringify(ed.getJSON()));
  act(() => {
    ed.commands.setContent(saved);
    ed.commands.insertContentAt(1, 'Edited ');
  });
  expect(mentions()[0]).toEqual(existing);
  expect(mentions()[0].attrs?.referenceUri).toBe(savedReferenceUri);
  expect(ed.getText()).toBe('Edited Before Existing chip middle M13 Forward after.');
});

function mountExistingLink() {
  const ed = mount({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Before' },
          {
            type: 'mention',
            marks: [{ type: 'bold' }],
            attrs: {
              id: 'old',
              entityId: 'old',
              entityType: 'page',
              label: 'Original',
              occurrenceId: 'occ-1',
              objectUuid: 'old-object',
              path: 'old-path',
              projectId: 'old-project',
            },
          },
          { type: 'text', text: ' after' },
        ],
      },
    ],
  });
  act(() => {
    ed.commands.setTextSelection(8);
  });
  return ed;
}
it('edits the chip immediately left of the caret without publishing a draft and cancels on Escape', async () => {
  const ed = mountExistingLink();
  const original = ed.getJSON();
  const updated = vi.fn();
  ed.on('update', updated);
  expect(backspace()).toBe(true);
  const input = await screen.findByRole('textbox', { name: 'Edit reference' });
  expect(input).toHaveValue('Original');
  fireEvent.change(input, { target: { value: 'M13' } });
  expect(await screen.findByText('M13 Forward')).toBeVisible();
  expect(ed.getJSON()).toEqual(original);
  fireEvent.keyDown(input, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit reference' })).toBeNull());
  expect(screen.queryByTestId('mention-menu')).toBeNull();
  expect(ed.getJSON()).toEqual(original);
  expect(ed.state.selection.from).toBe(8);
  expect(updated).not.toHaveBeenCalled();
});
it('commits a replacement as one undoable edit preserving occurrence and marks', async () => {
  const ed = mountExistingLink();
  const original = ed.getJSON();
  expect(backspace()).toBe(true);
  const input = await screen.findByRole('textbox', { name: 'Edit reference' });
  fireEvent.change(input, { target: { value: 'M13' } });
  await screen.findByText('M13 Forward');
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(mentions()[0]?.attrs?.entityId).toBe(fixtures.primer.id));
  expect(mentions()[0]).toMatchObject({
    marks: [{ type: 'bold' }],
    attrs: {
      occurrenceId: 'occ-1',
      objectUuid: null,
      label: fixtures.primer.name,
      projectId: 'repo-beta',
    },
  });
  expect(ed.state.selection.from).toBe(8);
  expect(screen.queryByTestId('mention-menu')).toBeNull();
  act(() => {
    ed.commands.undo();
  });
  expect(ed.getJSON()).toEqual(original);
});

it('deletes an edited reference when Backspace removes its empty trigger and Undo restores it', async () => {
  const ed = mountExistingLink();
  const original = ed.getJSON();
  expect(backspace()).toBe(true);
  const input = await screen.findByRole('textbox', { name: 'Edit reference' });
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.keyDown(input, { key: 'Backspace' });
  await waitFor(() => expect(mentions()).toHaveLength(0));
  expect(ed.getText()).toBe('Before after');
  expect(ed.state.selection.from).toBe(7);
  act(() => {
    ed.commands.undo();
  });
  expect(ed.getJSON()).toEqual(original);
  act(() => {
    ed.commands.setTextSelection(8);
  });
  backspace();
  const reopened = await screen.findByRole('textbox', { name: 'Edit reference' });
  fireEvent.change(reopened, { target: { value: '' } });
  fireEvent.keyDown(reopened, { key: 'Backspace' });
  await waitFor(() => expect(mentions()).toHaveLength(0));
  insert('/');
  expect(await screen.findByTestId('slash-command-menu')).toBeVisible();
  expect(ed.getText()).toBe('Before/ after');
});

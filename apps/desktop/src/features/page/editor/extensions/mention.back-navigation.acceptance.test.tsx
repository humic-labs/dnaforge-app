// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UI_TOOLBAR_SELECT_TRIGGER_CLASS } from '../../../../components/ui/styles';
import { installVisibleEditorGeometry } from '../../../../test/visible-editor-geometry';

const fixtures = vi.hoisted(() => ({
  search: vi.fn(),
  category: {
    key: 'role:primer',
    label: 'Primer',
    terms: ['primer'],
    filter: { role: 'primer' as const },
    iconKind: 'primer',
    browse: false,
    kind: 'shortcut',
    count: 1,
  },
  sequenceType: {
    key: 'type:sequence',
    label: 'Sequences',
    terms: ['sequence', 'sequences'],
    filter: { namedTypeKey: 'type:sequence' },
    iconKind: 'sequence',
    kind: 'type',
    count: 1,
  },
}));

vi.mock('../../../../platform', () => ({
  platform: () => ({
    entityDiscovery: {
      search: fixtures.search,
      types: async () => ({ items: [fixtures.category, fixtures.sequenceType] }),
      resolve: async () => ({ items: [] }),
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
  fixtures.search.mockReset().mockResolvedValue({
    items: [],
    nextCursor: null,
    generation: 'back-navigation-fixture',
    coverage: { catalog: 0, registry: 0, primers: 0, excluded: 0 },
  });
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

function mount() {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      MentionExtension,
      SlashCommandsExtension.configure({ commands: [] }),
    ],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before  after.' }] }],
    },
  });
  render(<EditorContent editor={editor} />);
  act(() => {
    editor!.view.dom.focus();
    editor!.commands.setTextSelection(8);
  });
}

function insert(text: string) {
  act(() => {
    editor!.commands.insertContent(text);
  });
}

function expectProse(query: string) {
  expect(editor!.getText()).toBe(`Before ${query} after.`);
  expect(editor!.state.selection.empty).toBe(true);
  expect(editor!.state.selection.from).toBe(8 + query.length);
}

function backspaceWithDefaultDeletion() {
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
      expect(event.defaultPrevented).toBe(false);
      const { from, to, empty } = editor!.state.selection;
      editor!.commands.deleteRange({ from: empty ? from - 1 : from, to });
    }
  });
  return handled;
}

function backButton() {
  return within(screen.getByTestId('mention-menu')).getByRole('button', { name: /^Back\b/ });
}

async function goBack(method: 'pointer' | 'Backspace') {
  if (method === 'Backspace') expect(backspaceWithDefaultDeletion()).toBe(true);
  else {
    const button = backButton();
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
  }
}

async function openSlashPrimer() {
  insert('/primer');
  fireEvent.click(await screen.findByRole('button', { name: /^Link primer$/i }));
  expect(await screen.findByTestId('mention-active-category')).toHaveTextContent('Primer');
  expectProse('@');
}

function expectShortcutExplanation(available = true) {
  const menu = within(screen.getByTestId('mention-menu'));
  const back = menu.getByRole('button', { name: 'Back' });
  expect(back).toHaveAttribute('title', 'Backspace when search is empty');
  if (available) expect(within(back).getByText('Backspace')).toBeVisible();
  else expect(within(back).queryByText('Backspace')).toBeNull();
}

it('keeps the notebook caret and live filtered results together after picking a slash type', async () => {
  const target = { id: 'target-puc19', type: 'sequence', name: 'pUC19', kindLabel: 'Sequence' };
  fixtures.search.mockImplementation(async ({ query, filter }) => ({
    items: query === 'pUC' && filter?.namedTypeKey === 'type:sequence' ? [target] : [],
    nextCursor: null,
    generation: 'typed',
    coverage: { catalog: 1, registry: 0, primers: 0, excluded: 0 },
  }));
  mount();
  insert('/');
  fireEvent.click(await screen.findByRole('button', { name: 'Sequences' }));
  const menu = await screen.findByTestId('mention-menu');
  for (const char of 'pUC') insert(char);
  expect(await within(menu).findByText('pUC19')).toBeVisible();
  expect(editor!.view.hasFocus()).toBe(true);
  expectProse('@pUC');
  expect(screen.getByTestId('mention-menu')).toBe(menu);
  expect(within(menu).queryByRole('textbox')).toBeNull();
});

it('gives Back a labeled shared button surface and a leading arrow', async () => {
  mount();
  await openSlashPrimer();
  const button = backButton();
  expect(button).toBeVisible();
  expect(button).toHaveTextContent(/Back/);
  expect(button).toHaveClass(...UI_TOOLBAR_SELECT_TRIGGER_CLASS.split(' '));
  const arrow = button.querySelector('svg');
  expect(arrow).not.toBeNull();
  expect(button.firstElementChild).toBe(arrow);
  expect(arrow).toHaveAttribute('aria-hidden', 'true');
});

it('visibly explains the empty-search Backspace condition and leaves nonempty deletion in the category', async () => {
  mount();
  await openSlashPrimer();
  expectShortcutExplanation();
  insert('M13');
  await waitFor(() =>
    expect(fixtures.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'M13', filter: fixtures.category.filter })
    )
  );
  expectShortcutExplanation(false);
  expect(backspaceWithDefaultDeletion()).toBe(false);
  expectProse('@M1');
  expect(screen.getByTestId('mention-active-category')).toHaveTextContent('Primer');
  await waitFor(() =>
    expect(fixtures.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'M1', filter: fixtures.category.filter })
    )
  );
});

it('does not show a parent Back action for a directly typed root picker', async () => {
  mount();
  insert('@');
  const menu = within(await screen.findByTestId('mention-menu'));
  expect(menu.queryByRole('button', { name: /^Back\b/ })).toBeNull();
  expect(menu.queryByText(/^Backspace$/)).toBeNull();
  expectProse('@');
});

it('shows Back on entity home when its actual parent is the slash menu', async () => {
  mount();
  insert('/');
  fireEvent.click(await screen.findByRole('button', { name: /Link an entity$/ }));
  await screen.findByRole('option', { name: 'Browse types' });
  expect(backButton()).toBeVisible();
  await goBack('pointer');
  expect(await screen.findByRole('button', { name: /Link an entity$/ })).toBeVisible();
  expect(screen.queryByTestId('mention-menu')).toBeNull();
  expectProse('/');
});

it.each(['pointer', 'Backspace'] as const)(
  '%s opens a type from bare slash and returns directly to the original three-column menu',
  async (method) => {
    mount();
    insert('/');
    const column = within(await screen.findByRole('group', { name: 'Entity' }));
    fireEvent.click(await column.findByRole('button', { name: 'Sequences' }));
    expect(await screen.findByTestId('mention-active-category')).toHaveTextContent('Sequences');
    await waitFor(() =>
      expect(fixtures.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: '', filter: fixtures.sequenceType.filter })
      )
    );
    await goBack(method);
    expect(await screen.findByRole('button', { name: 'Sequences' })).toBeVisible();
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    expectProse('/');
  }
);

it.each(['pointer', 'Backspace'] as const)(
  '%s returns a slash category directly to its original slash query',
  async (method) => {
    mount();
    await openSlashPrimer();
    await goBack(method);
    expect(await screen.findByRole('button', { name: /^Link primer$/i })).toBeVisible();
    expect(screen.queryByTestId('mention-menu')).toBeNull();
    expectProse('/primer');
  }
);

it.each(['pointer', 'Backspace'] as const)(
  '%s returns a browsed category to Browse types and then to entity home',
  async (method) => {
    mount();
    insert('@');
    fireEvent.click(await screen.findByRole('option', { name: 'Browse types' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Browse Sequences' }));
    expect(await screen.findByTestId('mention-active-category')).toHaveTextContent('Sequences');
    await goBack(method);
    expect(await screen.findByRole('option', { name: 'Browse Sequences' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Browse types' })).toBeNull();
    expectProse('@');
    await goBack(method);
    expect(await screen.findByRole('option', { name: 'Browse types' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Browse Sequences' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Back\b/ })).toBeNull();
    expectProse('@');
  }
);

it.each(['pointer', 'Backspace'] as const)(
  '%s restores a parent entity query without losing surrounding prose',
  async (method) => {
    mount();
    insert('@primer');
    fireEvent.click(await screen.findByRole('option', { name: 'Browse Primer' }));
    expect(await screen.findByTestId('mention-active-category')).toHaveTextContent('Primer');
    expectProse('@');
    await goBack(method);
    expect(await screen.findByRole('option', { name: 'Browse Primer' })).toBeVisible();
    expect(screen.queryByTestId('mention-active-category')).toBeNull();
    expectProse('@primer');
  }
);

it.each(['@', '/'] as const)(
  'keeps the popup and previous choices visible while a type loads from %s',
  async (prefix) => {
    mount();
    insert(prefix);
    if (prefix === '@')
      fireEvent.click(await screen.findByRole('option', { name: 'Browse types' }));
    const type = await screen.findByRole(prefix === '@' ? 'option' : 'button', {
      name: prefix === '@' ? 'Browse Sequences' : 'Sequences',
    });
    const popup = type.closest('[data-tippy-root]');
    let complete!: () => void;
    fixtures.search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              items: [{ id: 's1', name: 'Example sequence', type: 'sequence' }],
              nextCursor: null,
              generation: 'type',
              coverage: {},
            });
        })
    );
    fireEvent.click(type);
    await waitFor(() => expect(complete).toBeTypeOf('function'));
    expect(popup).toBeInTheDocument();
    expect(type).toBeVisible();
    await act(async () => complete());
    const result = await screen.findByText('Example sequence');
    expect(result.closest('[data-tippy-root]')).toBe(popup);
    expect(type).not.toBeInTheDocument();
  }
);

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorContent } from '@tiptap/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Instance } from 'tippy.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ tips: [] as Instance[] }));
vi.mock('tippy.js', async (load) => {
  const actual = await load<typeof import('tippy.js')>();
  return {
    ...actual,
    default: (...args: Parameters<typeof actual.default>) => {
      const result = actual.default(...args);
      observed.tips.push(...(Array.isArray(result) ? result : [result]));
      return result;
    },
  };
});
vi.mock('../../../../platform', () => ({
  platform: () => ({
    entityDiscovery: {
      search: async () => ({
        items: [],
        nextCursor: null,
        generation: 'one',
        coverage: { catalog: 0, registry: 0, primers: 0, excluded: 0 },
      }),
      types: async () => ({ items: [] }),
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
let anchorY = 240;
let scroller: HTMLDivElement;
let outer: HTMLDivElement;
function rectangle(element: Element): DOMRect {
  if (element.matches('.suggestion,[data-entity-query]')) return new DOMRect(160, anchorY, 40, 20);
  if (element === scroller) return new DOMRect(100, 120, 600, 400);
  if (element === outer) return new DOMRect(80, 100, 800, 500);
  if (element.classList.contains('ProseMirror')) return new DOMRect(100, 120, 600, 1200);
  if (element.closest('[data-tippy-root]')) return new DOMRect(0, 0, 380, 180);
  return new DOMRect(0, 0, 1200, 800);
}
beforeEach(() => {
  observed.tips.length = 0;
  anchorY = 240;
  outer = document.createElement('div');
  outer.style.overflow = 'auto';
  scroller = document.createElement('div');
  scroller.className = 'notebook-editor-body';
  scroller.style.overflow = 'auto';
  outer.append(scroller);
  document.body.append(outer);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return rectangle(this);
  });
  for (const [name, dimension] of [
    ['clientWidth', 'width'],
    ['clientHeight', 'height'],
    ['offsetWidth', 'width'],
    ['offsetHeight', 'height'],
  ] as const)
    vi.spyOn(HTMLElement.prototype, name, 'get').mockImplementation(function () {
      return rectangle(this)[dimension];
    });
  Range.prototype.getBoundingClientRect = () => new DOMRect(160, anchorY, 1, 20);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  for (const tip of observed.tips) if (!tip.state.isDestroyed) tip.destroy();
  outer.remove();
  vi.restoreAllMocks();
});
async function open(prefix: '@' | '/') {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      MentionExtension,
      SlashCommandsExtension,
    ],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Protected prose ' }] }],
    },
  });
  render(<EditorContent editor={editor} />, { container: scroller });
  act(() => {
    editor!.view.dom.focus();
    editor!.commands.setTextSelection(editor!.state.doc.content.size - 1);
    editor!.commands.insertContent(prefix);
  });
  await screen.findByTestId(prefix === '@' ? 'mention-menu' : 'slash-command-menu');
  await waitFor(() => expect(observed.tips.some((tip) => tip.popperInstance)).toBe(true));
  const tip = observed.tips.find((item) => item.popperInstance)!;
  await act(async () => {
    await tip.popperInstance!.update();
  });
  return tip;
}

it.each(['@', '/'] as const)(
  '%s anchors under the final visible line of wrapped inline text',
  async (prefix) => {
    const tip = await open(prefix);
    const lastLine = new DOMRect(110, anchorY + 24, 35, 20);
    const fragment = editor!.view.dom.querySelector('[data-decoration-id]')!;
    vi.spyOn(fragment, 'getClientRects').mockReturnValue([
      new DOMRect(500, anchorY, 20, 20),
      lastLine,
    ] as unknown as DOMRectList);
    await act(async () => {
      await tip.popperInstance!.update();
    });
    expect(tip.popperInstance!.state.rects.reference).toMatchObject({
      x: lastLine.x,
      y: lastLine.y,
      width: lastLine.width,
      height: lastLine.height,
    });
    expect(tip.state.isVisible).toBe(true);
  }
);

it.each(['@', '/'] as const)(
  '%s follows its inline anchor when a nested notebook container scrolls',
  async (prefix) => {
    const tip = await open(prefix);
    const original = tip.popperInstance!.state.rects.reference.y;
    anchorY -= 60;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(tip.popperInstance!.state.rects.reference.y).toBe(original - 60));
    expect(tip.popperInstance!.state.scrollParents.reference).toContain(scroller);
    anchorY -= 20;
    fireEvent.scroll(outer);
    await waitFor(() => expect(tip.popperInstance!.state.rects.reference.y).toBe(original - 80));
    expect(tip.state.isVisible).toBe(true);
  }
);

it.each(['@', '/'] as const)(
  '%s closes when its anchor scrolls out of the editor without deleting typed text',
  async (prefix) => {
    await open(prefix);
    anchorY = 50;
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(
        screen.queryByTestId(prefix === '@' ? 'mention-menu' : 'slash-command-menu')
      ).toBeNull()
    );
    expect(editor!.getText()).toBe(`Protected prose ${prefix}`);
  }
);

it.each(['@', '/'] as const)(
  '%s keeps the menu open when only its own list scrolls',
  async (prefix) => {
    const tip = await open(prefix);
    const before = tip.popperInstance!.state.rects.reference.y;
    const menu = screen.getByTestId(prefix === '@' ? 'mention-menu' : 'slash-command-menu');
    fireEvent.scroll(prefix === '@' ? screen.getByRole('listbox') : menu);
    await act(async () => {});
    expect(tip.state.isVisible).toBe(true);
    expect(tip.popperInstance!.state.rects.reference.y).toBe(before);
    expect(menu).toBeInTheDocument();
  }
);

it.each(['@', '/'] as const)(
  '%s keeps its positioning instance while typing and tracks window resize',
  async (prefix) => {
    const tip = await open(prefix);
    const popper = tip.popperInstance;
    anchorY += 20;
    act(() => {
      editor!.commands.insertContent(prefix === '@' ? 'a' : 'h');
    });
    await waitFor(() => expect(tip.popperInstance!.state.rects.reference.y).toBe(anchorY));
    expect(tip.popperInstance).toBe(popper);
    anchorY += 20;
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(tip.popperInstance!.state.rects.reference.y).toBe(anchorY));
  }
);

it.each(['@', '/'] as const)(
  '%s releases ancestor scroll subscriptions when the editor is destroyed',
  async (prefix) => {
    const remove = vi.spyOn(scroller, 'removeEventListener');
    const tip = await open(prefix);
    act(() => {
      editor!.destroy();
      editor = null;
    });
    expect(tip.state.isDestroyed).toBe(true);
    expect(remove.mock.calls.some(([type]) => type === 'scroll')).toBe(true);
    expect(screen.queryByTestId(prefix === '@' ? 'mention-menu' : 'slash-command-menu')).toBeNull();
  }
);

it.each(['@', '/'] as const)(
  '%s joins the popup to the full width of the inline query',
  async (prefix) => {
    const tip = await open(prefix);
    expect(tip.props.offset).toEqual([0, 0]);
    const first = editor!.view.dom.querySelector('[data-entity-query]')!;
    expect(first.hasAttribute('data-tab-start')).toBe(true);
    expect(first.hasAttribute('data-tab-end')).toBe(true);
    act(() => {
      editor!.commands.toggleBold();
      editor!.commands.insertContent('x');
    });
    const parts = editor!.view.dom.querySelectorAll('[data-entity-query]');
    expect(Array.from(parts, (part) => part.textContent)).toEqual([prefix, 'x']);
    expect(parts[0].hasAttribute('data-tab-end')).toBe(false);
    expect(parts[1].hasAttribute('data-tab-start')).toBe(false);
    for (const [index, part] of Array.from(parts).entries()) {
      vi.spyOn(part, 'getClientRects').mockReturnValue([
        new DOMRect(160 + index * 22, anchorY, 22, 20),
      ] as unknown as DOMRectList);
    }
    await act(async () => {
      await tip.popperInstance!.update();
    });
    expect(tip.popperInstance!.state.rects.reference).toMatchObject({ x: 160, width: 44 });
    expect(tip.popper.style.getPropertyValue('--picker-join-end')).toBe('44px');
  }
);

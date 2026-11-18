import { createRef, type RefObject } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandMenu, type SlashCommandMenuRef } from './SlashCommandMenu';
import type { SlashCommand } from '../lib/commands';

const commands: SlashCommand[] = [
  {
    name: 'heading',
    label: 'Heading',
    description: '',
    icon: null,
    keywords: [],
    category: 'format',
  },
  { name: 'quote', label: 'Quote', description: '', icon: null, keywords: [], category: 'format' },
  { name: 'table', label: 'Table', description: '', icon: null, keywords: [], category: 'embed' },
  {
    name: 'structure',
    label: 'Structure',
    description: '',
    icon: null,
    keywords: [],
    category: 'embed',
  },
];

function key(ref: RefObject<SlashCommandMenuRef | null>, value: string) {
  const event = new KeyboardEvent('keydown', { key: value, cancelable: true });
  let handled = false;
  act(() => {
    handled = ref.current!.onKeyDown({ event });
  });
  return { event, handled };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

describe('notebook slash command menu', () => {
  it('preserves the active command when rows reorder across its two columns', () => {
    const command = vi.fn();
    const ref = createRef<SlashCommandMenuRef>();
    const { rerender } = render(<SlashCommandMenu ref={ref} items={commands} command={command} />);
    expect(key(ref, 'ArrowRight').handled).toBe(true);
    expect(key(ref, 'ArrowDown').handled).toBe(true);
    rerender(
      <SlashCommandMenu
        ref={ref}
        items={[commands[3], commands[1], commands[2], commands[0]]}
        command={command}
      />
    );
    const entered = key(ref, 'Enter');
    expect(entered.handled).toBe(true);
    expect(entered.event.defaultPrevented).toBe(true);
    expect(command).toHaveBeenCalledExactlyOnceWith(commands[3]);
  });

  it('uses native keys to navigate columns and wraps within the current column', () => {
    const command = vi.fn();
    const ref = createRef<SlashCommandMenuRef>();
    render(<SlashCommandMenu ref={ref} items={commands} command={command} />);
    key(ref, 'ArrowUp');
    key(ref, 'ArrowRight');
    key(ref, 'ArrowLeft');
    expect(key(ref, 'q').handled).toBe(false);
    key(ref, 'Enter');
    expect(command).toHaveBeenCalledExactlyOnceWith(commands[1]);
  });

  it('prevents a command mousedown from moving focus out of the notebook editor', () => {
    const command = vi.fn();
    render(
      <>
        <div role="textbox" contentEditable aria-label="Notebook editor" />
        <SlashCommandMenu items={commands} command={command} />
      </>
    );
    const editor = screen.getByRole('textbox', { name: 'Notebook editor' });
    act(() => editor.focus());
    const option = screen.getByText('Table').closest('button')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    fireEvent(option, down);
    expect(down.defaultPrevented).toBe(true);
    expect(editor).toHaveFocus();
    fireEvent.click(option);
    expect(command).toHaveBeenCalledExactlyOnceWith(commands[2]);
  });

  it('invalidates retained native callbacks after the suggestion is closed', () => {
    const command = vi.fn();
    const ref = createRef<SlashCommandMenuRef>();
    render(<SlashCommandMenu ref={ref} items={commands} command={command} />);
    act(() => ref.current!.close('escape'));
    key(ref, 'Enter');
    expect(command).not.toHaveBeenCalled();
  });
});

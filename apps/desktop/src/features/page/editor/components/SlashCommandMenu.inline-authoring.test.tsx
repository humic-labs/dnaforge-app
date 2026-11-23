// @vitest-environment jsdom
import { createRef } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, expect, it, vi } from 'vitest';
import { SlashCommandMenu, type SlashCommandMenuRef } from './SlashCommandMenu';
import type { SlashCommand } from '../lib/commands';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
const commands: SlashCommand[] = [
  {
    name: 'heading',
    label: 'Heading 1',
    description: '',
    icon: 'H',
    keywords: [],
    category: 'format',
  },
  { name: 'table', label: 'Table', description: '', icon: 'T', keywords: [], category: 'embed' },
  {
    name: 'entity-link',
    label: 'Link an entity',
    description: '',
    icon: '@',
    keywords: [],
    category: 'entity' as SlashCommand['category'],
  },
];
it('puts Format, Embed and Entity actions in three separately labelled columns', () => {
  const command = vi.fn();
  render(<SlashCommandMenu items={commands} command={command} />);
  const format = screen.getByRole('group', { name: 'Format' });
  const embed = screen.getByRole('group', { name: 'Embed' });
  const entity = screen.getByRole('group', { name: 'Entity' });
  expect(within(format).getAllByRole('option')).toHaveLength(1);
  expect(within(embed).getAllByRole('option')).toHaveLength(1);
  expect(within(entity).getAllByRole('option')).toHaveLength(1);
  expect(within(format).getByRole('option', { name: /Heading 1$/ })).toBeVisible();
  expect(within(embed).getByRole('option', { name: /Table$/ })).toBeVisible();
  fireEvent.click(within(entity).getByRole('option', { name: /Link an entity$/ }));
  expect(command).toHaveBeenCalledWith(commands[2]);
});
it('moves across all three columns with the keyboard and inserts the chosen entity action', () => {
  const command = vi.fn();
  const ref = createRef<SlashCommandMenuRef>();
  render(<SlashCommandMenu ref={ref} items={commands} command={command} />);
  for (const key of ['ArrowRight', 'ArrowRight', 'Enter']) {
    act(() => {
      expect(ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key }) })).toBe(true);
    });
  }
  expect(command).toHaveBeenCalledWith(commands[2]);
});

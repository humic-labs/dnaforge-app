import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InlineSearch } from './InlineSearch';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps focus on the notebook after the user leaves structure search', () => {
  vi.useFakeTimers();
  render(
    <>
      <input aria-label="Notebook paragraph" />
      <InlineSearch attrs={{}} onUpdateAttrs={() => {}} />
    </>
  );
  const paragraph = screen.getByRole('textbox', { name: 'Notebook paragraph' });
  const search = screen.getByPlaceholderText('pdb, alphafold, url, file');
  act(() => vi.advanceTimersByTime(35));
  expect(search).toHaveFocus();

  paragraph.focus();
  act(() => vi.advanceTimersByTime(100));
  expect(paragraph).toHaveFocus();
});

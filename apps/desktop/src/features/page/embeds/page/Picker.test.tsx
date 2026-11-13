import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PagePicker } from './Picker';

vi.mock('../../store', () => ({
  usePageStore: () => ({
    pages: {
      first: { id: 'first', title: 'First notebook', updatedAt: new Date('2026-10-12') },
      second: { id: 'second', title: 'Second notebook', updatedAt: new Date('2026-10-11') },
    },
  }),
}));

describe('page picker filtered selection', () => {
  it('cannot insert a page hidden by the current search', () => {
    const onAdvance = vi.fn();
    render(<PagePicker data={{}} onAdvance={onAdvance} onBack={vi.fn()} onCancel={vi.fn()} />);
    const search = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByRole('button', { name: 'Insert Link' })).toBeDisabled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('Enter inserts the matching page after changing the search', () => {
    const onAdvance = vi.fn();
    render(<PagePicker data={{}} onAdvance={onAdvance} onBack={vi.fn()} onCancel={vi.fn()} />);
    const search = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(search, { target: { value: 'Second' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdvance).toHaveBeenCalledWith({ pageId: 'second', pageName: 'Second notebook' });
  });
});

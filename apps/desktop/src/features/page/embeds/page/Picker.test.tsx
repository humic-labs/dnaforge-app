import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ search: vi.fn(), resolve: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: mocks }) }));
import { PagePicker } from './Picker';
const pages = [
  {
    id: 'first',
    name: 'First notebook',
    type: 'page',
    kindLabel: 'Notebook',
    projectId: 'alpha',
    path: 'First notebook',
  },
  {
    id: 'second',
    name: 'Second notebook',
    type: 'page',
    kindLabel: 'Notebook',
    projectId: 'beta',
    path: 'Second notebook',
  },
];
beforeEach(() => {
  mocks.search.mockReset().mockImplementation(async ({ query }) => ({
    items: pages.filter((page) => page.name.toLowerCase().includes(query.toLowerCase())),
    nextCursor: null,
    generation: 'generation',
    coverage: { catalog: 2, registry: 0, primers: 0, excluded: 0 },
  }));
  mocks.resolve.mockReset().mockImplementation(async ({ ids }) => ({
    items: ids.map((id: string) => ({
      id,
      status: 'available',
      entity: pages.find((page) => page.id === id),
    })),
  }));
});
describe('page picker filtered selection', () => {
  it('cannot insert a page hidden by the current search', async () => {
    const onAdvance = vi.fn();
    render(<PagePicker data={{}} onAdvance={onAdvance} onBack={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByRole('option', { name: /First notebook/ });
    fireEvent.click(screen.getByRole('option', { name: /First notebook/ }));
    const search = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(search, { target: { value: 'missing' } });
    await screen.findByText('No pages found');
    expect(screen.getByRole('button', { name: 'Insert Link' })).toBeDisabled();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdvance).not.toHaveBeenCalled();
  });
  it('Enter inserts the matching page after changing the search', async () => {
    const onAdvance = vi.fn();
    render(<PagePicker data={{}} onAdvance={onAdvance} onBack={vi.fn()} onCancel={vi.fn()} />);
    const search = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(search, { target: { value: 'Second' } });
    await screen.findByRole('option', { name: /Second notebook/ });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() =>
      expect(onAdvance).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'second',
          pageName: 'Second notebook',
          entity: expect.objectContaining({ id: 'second', projectId: 'beta' }),
        })
      )
    );
    expect(mocks.resolve).toHaveBeenCalledWith({ ids: ['second'] });
  });
});

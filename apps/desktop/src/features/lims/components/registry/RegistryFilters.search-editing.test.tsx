import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RegistryFilters } from './RegistryFilters';

afterEach(cleanup);

it('edits the actual active global search instead of changing the name criterion', () => {
  const onSearchChange = vi.fn();
  const onTextFilterChange = vi.fn();
  render(
    <RegistryFilters
      facets={[]}
      textFilters={{ name: 'existing name criterion' }}
      onTextFilterChange={onTextFilterChange}
      showArchived={false}
      onShowArchivedChange={vi.fn()}
      search="lab source"
      onSearchChange={onSearchChange}
      onClearSearch={vi.fn()}
      onClearAll={vi.fn()}
      open={true}
      onOpenChange={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Search: lab source' }));
  const field = screen.getByRole('searchbox', { name: 'Search records' });
  expect(field).toHaveValue('lab source');
  fireEvent.change(field, { target: { value: 'new source' } });
  expect(onSearchChange).toHaveBeenCalledExactlyOnceWith('new source');
  expect(onTextFilterChange).not.toHaveBeenCalled();
});

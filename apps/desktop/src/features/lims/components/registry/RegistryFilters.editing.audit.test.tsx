import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RegistryFilters } from './RegistryFilters';

afterEach(cleanup);

it('opens an editable Sequence field when the existing sequence filter chip is clicked', () => {
  render(
    <RegistryFilters
      facets={[]}
      textFilters={{ sequence: 'ACGT' }}
      onTextFilterChange={vi.fn()}
      showArchived={false}
      onShowArchivedChange={vi.fn()}
      search=""
      onClearSearch={vi.fn()}
      onClearAll={vi.fn()}
      open={true}
      onOpenChange={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sequence contains “ACGT”' }));
  expect(screen.getByRole('textbox', { name: 'Sequence contains' })).toHaveValue('ACGT');
});

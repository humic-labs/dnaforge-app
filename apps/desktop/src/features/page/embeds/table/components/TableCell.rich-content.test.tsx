// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TableCell } from './TableCell';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), navigate: vi.fn() }));

vi.mock('../../../../molecular-documents/public/references', () => ({
  resolveMolecularReferenceRecord: mocks.resolve,
}));
vi.mock('../../../../ai/public/navigate-to-reference', () => ({
  navigateToReference: mocks.navigate,
}));

const referenceId = 'e18c3ba4-9448-4589-8309-710c13a0261b';
const href = `dnaforge-chat://reference/${referenceId}`;
const reference = {
  id: referenceId,
  entity_type: 'sequence_region',
  display_label: 'Exact region',
  locator: 'entity://sequence/source-sequence',
  deep_link_params: JSON.stringify({ start: 11, end: 31 }),
  data: null,
};

beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue(reference);
  mocks.navigate.mockReset().mockResolvedValue(undefined);
});

it('renders mixed inline formatting and opens the exact saved target through the shared reference owner', async () => {
  const onCellClick = vi.fn();
  render(
    <TableCell
      cell={{
        value: 'Use Exact region carefully',
        type: 'text',
        content: [
          { type: 'text', text: 'Use ', marks: [{ type: 'bold' }] },
          {
            type: 'mention',
            attrs: { entityType: 'reference', referenceUri: href, label: 'Exact region' },
          },
          { type: 'text', text: ' carefully', marks: [{ type: 'italic' }] },
        ],
      }}
      position={{ row: 0, col: 0 }}
      isFocused={false}
      isEditing={false}
      editingValue=""
      referenceNotebookPageId="source-notebook"
      onCellClick={onCellClick}
      onCellDoubleClick={vi.fn()}
      onEditingValueChange={vi.fn()}
      onEditCommit={vi.fn()}
      onEditCancel={vi.fn()}
      cellRef={vi.fn()}
    />
  );
  expect(screen.getByText('Use').closest('strong')).not.toBeNull();
  expect(screen.getByText('carefully').closest('em')).not.toBeNull();
  const chip = await screen.findByRole('link', { name: 'Exact region, Sequence region' });
  expect(chip).not.toHaveAttribute('aria-disabled', 'true');
  fireEvent.mouseDown(chip);
  fireEvent.click(chip);
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith(reference, {
      sourceNotebookPageId: 'source-notebook',
    })
  );
  expect(mocks.resolve).toHaveBeenCalledWith(href, 'Exact region', 'source-notebook');
  expect(onCellClick).not.toHaveBeenCalled();
});

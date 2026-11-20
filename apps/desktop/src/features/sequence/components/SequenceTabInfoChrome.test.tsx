import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { sequenceDisplayName, sequencePresentation } from '../../../shared/sequence-presentation';
import { SequenceTabInfoChrome } from './SequenceTabInfoChrome';

const baseProps: ComponentProps<typeof SequenceTabInfoChrome> = {
  readOnly: false,
  presentation: sequencePresentation('Saved construct'),
  sequenceLength: 846,
  circular: true,
  viewMode: '2d',
  onViewModeChange: vi.fn(),
  rendererVisibility: 'map',
  onRendererVisibilityChange: vi.fn(),
  mapLayout: 'vertical',
  onMapLayoutChange: vi.fn(),
  sequenceDocumentId: 'package-id',
  limsBadge: null,
  hostedRevisionNumber: null,
  shareControl: null,
  isViewerEditMode: false,
  onRequestEdit: vi.fn(),
  acceptedAssemblyProductMismatch: null,
  showExternalChangeToast: false,
  onAcceptExternalChange: vi.fn(),
  onDismissExternalChange: vi.fn(),
};

describe('sequence header editing', () => {
  it('keeps one sequence edit action and leaves construction editing in Metadata', () => {
    const onRequestEdit = vi.fn();
    render(<SequenceTabInfoChrome {...baseProps} onRequestEdit={onRequestEdit} />);
    const bar = screen.getByTestId('sequence-info-bar');
    expect(within(bar).queryByRole('button', { name: 'Edit assembly' })).toBeNull();
    expect(within(bar).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit sequence' }));
    expect(onRequestEdit).toHaveBeenCalledWith('package-id');
  });

  it('places compact project actions after the length and topology', () => {
    render(<SequenceTabInfoChrome {...baseProps} shareControl={<button>Share</button>} />);
    const bar = within(screen.getByTestId('sequence-info-bar'));
    const edit = bar.getByRole('button', { name: 'Edit sequence' });
    expect(
      bar.getByText('circular').compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      edit.compareDocumentPosition(bar.getByRole('button', { name: 'Share' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(edit).toHaveClass('appbar-action');
  });

  it.each(['two records.GBK', 'plasmid.v3.dna'])(
    'shows the exact external filename %s and the import action in the preview toolbar',
    (sourceFileName) => {
      const onSelect = vi.fn();
      const onImportToEdit = vi.fn();
      render(
        <SequenceTabInfoChrome
          {...baseProps}
          readOnly
          quickLook={{
            sourceFileName,
            records: [
              {
                recordId: 'first',
                displayName: sequenceDisplayName('Duplicate'),
                sequenceLength: 846,
              },
              {
                recordId: 'second',
                displayName: sequenceDisplayName('Duplicate'),
                sequenceLength: 404,
              },
            ],
            selectedRecordId: 'first',
            onSelect,
            onImportToEdit,
          }}
        />
      );
      const bar = screen.getByTestId('sequence-info-bar');
      expect(bar).toHaveClass('external-preview-toolbar');
      expect(bar).toHaveAccessibleName('Read-only preview · Not imported');
      expect(within(bar).getByText('Preview')).toHaveAttribute('title', 'Read-only · Not imported');
      expect(within(bar).getByTestId('sequence-info-path').textContent).toBe(sourceFileName);
      expect(bar).not.toHaveTextContent(/Quick Look|Read Only|Saved construct/i);
      const records = within(bar).getByRole('combobox', { name: 'Quick Look record' });
      fireEvent.change(records, { target: { value: 'second' } });
      expect(onSelect).toHaveBeenCalledWith('second');
      const importAction = within(bar).getByRole('button', { name: 'Import to Edit' });
      expect(
        within(bar).getByText('circular').compareDocumentPosition(importAction) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      fireEvent.click(importAction);
      expect(onImportToEdit).toHaveBeenCalledTimes(1);
    }
  );
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sequencePresentation } from '../../../shared/sequence-presentation';
import { SequenceTabInfoChrome } from './SequenceTabInfoChrome';

describe('sequence header editing', () => {
  it('keeps one sequence edit action and leaves construction editing in Metadata', () => {
    const onRequestEdit = vi.fn();
    render(
      <SequenceTabInfoChrome
        readOnly={false}
        presentation={sequencePresentation('Saved construct')}
        sequenceLength={846}
        circular
        viewMode="2d"
        onViewModeChange={vi.fn()}
        rendererVisibility="map"
        onRendererVisibilityChange={vi.fn()}
        mapLayout="vertical"
        onMapLayoutChange={vi.fn()}
        sequenceDocumentId="package-id"
        limsBadge={null}
        hostedRevisionNumber={null}
        shareControl={null}
        isViewerEditMode={false}
        onRequestEdit={onRequestEdit}
        acceptedAssemblyProductMismatch={null}
        showExternalChangeToast={false}
        onAcceptExternalChange={vi.fn()}
        onDismissExternalChange={vi.fn()}
      />
    );
    const bar = screen.getByTestId('sequence-info-bar');
    expect(within(bar).queryByRole('button', { name: 'Edit assembly' })).toBeNull();
    expect(within(bar).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(bar).getByRole('button', { name: 'Edit sequence' }));
    expect(onRequestEdit).toHaveBeenCalledWith('package-id');
  });
});

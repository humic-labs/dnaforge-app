import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { AnnotationsDrawerContent } from './annotations-drawer';
import type { Annotation } from '@waypoint/sequence-utils';

const makeAnnotation = (overrides: Partial<Annotation> = {}): Annotation => ({
  name: 'TestGene',
  type: 'CDS',
  start: 100,
  end: 500,
  direction: 1,
  color: '#4299e1',
  ...overrides,
});

const defaultProps = {
  filePath: '/test/file.gb',
  annotations: [] as Annotation[],
  onAnnotationClick: vi.fn(),
  onAnnotationSave: vi.fn(),
  onAnnotationDelete: vi.fn(),
  onRunPlannotate: vi.fn(),
  plannotateStatus: 'idle' as const,
  sequenceVersion: 0,
  activeTab: 'annotations' as const,
  onTabChange: vi.fn(),
};

function renderControlled(
  props: ComponentProps<typeof AnnotationsDrawerContent>,
  initialTab: 'annotations' | 'plannotate' = 'annotations'
) {
  function Owner() {
    const [tab, setTab] = useState<'annotations' | 'plannotate'>(initialTab);
    return <AnnotationsDrawerContent {...props} activeTab={tab} onTabChange={setTab} />;
  }
  return render(<Owner />);
}

describe('AnnotationsDrawerContent', () => {
  it.each(['idle', 'error'] as const)(
    'disables %s submission until the job owner connects',
    (status) => {
      const onRunPlannotate = vi.fn();
      const { rerender } = render(
        <AnnotationsDrawerContent
          {...defaultProps}
          activeTab="plannotate"
          plannotateStatus={status}
          plannotateUnavailableReason={userMessage('annotation.connecting')}
          onRunPlannotate={onRunPlannotate}
        />
      );
      const button = screen.getByRole('button', {
        name: status === 'idle' ? 'Run pLannotate' : 'Retry',
      });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(onRunPlannotate).not.toHaveBeenCalled();
      expect(screen.getByText('Connecting to job service…')).toBeVisible();
      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          activeTab="plannotate"
          plannotateStatus={status}
          onRunPlannotate={onRunPlannotate}
        />
      );
      expect(button).toBeEnabled();
    }
  );

  it('offers existing-file import without starting an analysis', () => {
    const onImportAnnotationOutput = vi.fn();
    const onRunPlannotate = vi.fn();
    render(
      <AnnotationsDrawerContent
        {...defaultProps}
        onRunPlannotate={onRunPlannotate}
        onImportAnnotationOutput={onImportAnnotationOutput}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import results' }));
    expect(onImportAnnotationOutput).toHaveBeenCalledOnce();
    expect(onRunPlannotate).not.toHaveBeenCalled();
  });

  it('labels an imported review and its unknown analyzed revision without offering a rerun', () => {
    render(
      <AnnotationsDrawerContent
        {...defaultProps}
        activeTab="plannotate"
        plannotateStatus="success"
        importedOutputName="external.gff3"
        runVersion={1}
        sequenceVersion={2}
        hasReviewSession
        reviewPanel={<div>Selected candidates</div>}
      />
    );
    expect(screen.getByRole('tab', { name: 'Import review' })).toBeDefined();
    expect(screen.getByText(/exact sequence used for this result is unknown/i)).toBeDefined();
    expect(screen.getByText('Selected candidates')).toBeDefined();
    expect(screen.queryByRole('button', { name: /re-run/i })).toBeNull();
  });

  describe('tab switching', () => {
    it('renders Annotations tab by default', () => {
      render(<AnnotationsDrawerContent {...defaultProps} />);
      expect(screen.getByText(/no annotations/i)).toBeDefined();
    });

    it('switches to pLannotate tab (parent-controlled)', () => {
      renderControlled(defaultProps);
      fireEvent.click(screen.getByRole('tab', { name: /plannotate/i }));
      expect(screen.getByRole('button', { name: /run plannotate/i })).toBeDefined();
    });

    it('opens to pLannotate tab when activeTab prop is plannotate', () => {
      render(<AnnotationsDrawerContent {...defaultProps} activeTab="plannotate" />);
      expect(screen.getByRole('button', { name: /run plannotate/i })).toBeDefined();
    });
  });

  describe('search', () => {
    it('filters annotations by name', () => {
      const annotations = [
        makeAnnotation({ name: 'AmpR', start: 100, end: 500 }),
        makeAnnotation({ name: 'GFP', start: 800, end: 1500 }),
        makeAnnotation({ name: 'ori', type: 'rep_origin', start: 2000, end: 2500 }),
      ];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.change(screen.getByPlaceholderText(/search/i), {
        target: { value: 'amp' },
      });
      expect(screen.getByText('AmpR')).toBeDefined();
      expect(screen.queryByText('GFP')).toBeNull();
      expect(screen.queryByText('ori')).toBeNull();
    });
  });

  describe('type filter', () => {
    it('filters by annotation type', () => {
      const annotations = [
        makeAnnotation({ name: 'AmpR', type: 'CDS' }),
        makeAnnotation({ name: 'ori', type: 'rep_origin', start: 2000, end: 2500 }),
      ];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.click(screen.getByTestId('type-filter-button'));
      fireEvent.click(screen.getByTestId('type-filter-CDS'));
      expect(screen.queryByText('AmpR')).toBeNull();
      expect(screen.getByText('ori')).toBeDefined();
    });
  });

  describe('sort', () => {
    it('sorts by name when column header clicked', () => {
      const annotations = [
        makeAnnotation({ name: 'Zeta', start: 100, end: 200 }),
        makeAnnotation({ name: 'Alpha', start: 300, end: 400 }),
      ];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.click(screen.getByTestId('sort-by-name'));
      const rows = screen.getAllByTestId(/^annotation-row-/);
      expect(rows[0].textContent).toContain('Alpha');
      expect(rows[1].textContent).toContain('Zeta');
    });

    it('reverses sort on second click', () => {
      const annotations = [
        makeAnnotation({ name: 'Alpha', start: 100, end: 200 }),
        makeAnnotation({ name: 'Zeta', start: 300, end: 400 }),
      ];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.click(screen.getByTestId('sort-by-name'));
      fireEvent.click(screen.getByTestId('sort-by-name'));
      const rows = screen.getAllByTestId(/^annotation-row-/);
      expect(rows[0].textContent).toContain('Zeta');
      expect(rows[1].textContent).toContain('Alpha');
    });

    it('default sort is position ascending', () => {
      const annotations = [
        makeAnnotation({ name: 'Late', start: 900, end: 1000 }),
        makeAnnotation({ name: 'Early', start: 50, end: 100 }),
      ];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      const rows = screen.getAllByTestId(/^annotation-row-/);
      expect(rows[0].textContent).toContain('Early');
      expect(rows[1].textContent).toContain('Late');
    });
  });

  describe('inline editing', () => {
    it('single click selects + navigates WITHOUT expanding; second click expands', () => {
      const onAnnotationClick = vi.fn();
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onAnnotationClick={onAnnotationClick}
        />
      );
      fireEvent.click(screen.getByTestId('annotation-row-0'));
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
      expect(onAnnotationClick).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('annotation-row-0'));
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
    });

    it('double click expands annotation into edit mode', () => {
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
    });

    it('double click keeps the edit view open (no toggle-collapse)', () => {
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
    });

    it('the caret button toggles the open edit view closed', () => {
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.click(screen.getByTestId('edit-icon-0'));
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
      fireEvent.click(screen.getByTestId('edit-icon-0'));
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
    });

    it('arrow keys select + navigate without expanding; Enter expands the selection', () => {
      const onAnnotationClick = vi.fn();
      const annotations = [
        makeAnnotation({ name: 'AmpR', start: 10 }),
        makeAnnotation({ name: 'lacZ', start: 50 }),
      ];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onAnnotationClick={onAnnotationClick}
        />
      );
      const list = screen.getByTestId('annotation-list-scroll');
      fireEvent.keyDown(list, { key: 'ArrowDown' });
      expect(onAnnotationClick).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
      fireEvent.keyDown(list, { key: 'ArrowDown' });
      expect(onAnnotationClick).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
      fireEvent.keyDown(list, { key: 'Enter' });
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
    });

    it('edit icon click expands annotation', () => {
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.click(screen.getByTestId('edit-icon-0'));
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
    });

    it('visibility checkbox toggles without selecting/expanding the row (incl. double-click)', () => {
      const onToggleAnnotationVisibility = vi.fn();
      const onAnnotationClick = vi.fn();
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onToggleAnnotationVisibility={onToggleAnnotationVisibility}
          onAnnotationClick={onAnnotationClick}
        />
      );
      const checkbox = screen.getByTestId('annotation-visible-0');
      fireEvent.click(checkbox);
      expect(onToggleAnnotationVisibility).toHaveBeenCalledTimes(1);
      expect(onAnnotationClick).not.toHaveBeenCalled();
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
      fireEvent.doubleClick(checkbox);
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
    });

    it('calls onAnnotationSave with updated data', () => {
      const onAnnotationSave = vi.fn();
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onAnnotationSave={onAnnotationSave}
        />
      );
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      const nameInput = screen.getByTestId('edit-name-input');
      fireEvent.change(nameInput, { target: { value: 'NewName' } });
      fireEvent.click(screen.getByTestId('edit-save-button'));
      expect(onAnnotationSave).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ name: 'NewName' })
      );
    });

    it('edits the range (now editable) and saves numeric start/end', () => {
      const onAnnotationSave = vi.fn();
      const annotations = [makeAnnotation({ name: 'AmpR', start: 10, end: 50 })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onAnnotationSave={onAnnotationSave}
        />
      );
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      expect((screen.getByTestId('edit-start-input') as HTMLInputElement).value).toBe('10');
      expect((screen.getByTestId('edit-end-input') as HTMLInputElement).value).toBe('50');
      fireEvent.change(screen.getByTestId('edit-start-input'), { target: { value: '20' } });
      fireEvent.change(screen.getByTestId('edit-end-input'), { target: { value: '80' } });
      fireEvent.click(screen.getByTestId('edit-save-button'));
      expect(onAnnotationSave).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ start: 20, end: 80 })
      );
    });

    it('disables Save when the edited range is invalid (end < start) on a linear sequence', () => {
      const annotations = [makeAnnotation({ name: 'AmpR', start: 10, end: 50 })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      fireEvent.change(screen.getByTestId('edit-end-input'), { target: { value: '5' } });
      expect((screen.getByTestId('edit-save-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('allows an origin-spanning range (end < start) on a CIRCULAR sequence', () => {
      const annotations = [makeAnnotation({ name: 'ori-span', start: 2600, end: 50 })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          circular
          sequenceLength={2686}
        />
      );
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      expect((screen.getByTestId('edit-save-button') as HTMLButtonElement).disabled).toBe(false);
    });

    it('disables Save when an endpoint exceeds the sequence length', () => {
      const annotations = [makeAnnotation({ name: 'AmpR', start: 10, end: 50 })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          sequenceLength={100}
        />
      );
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      fireEvent.change(screen.getByTestId('edit-end-input'), { target: { value: '500' } });
      expect((screen.getByTestId('edit-save-button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('calls onAnnotationDelete', () => {
      const onAnnotationDelete = vi.fn();
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onAnnotationDelete={onAnnotationDelete}
        />
      );
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      fireEvent.click(screen.getByTestId('edit-delete-button'));
      expect(onAnnotationDelete).toHaveBeenCalledWith(0);
    });
  });

  describe('edit target', () => {
    it('auto-expands annotation at editTargetIndex', () => {
      const annotations = [
        makeAnnotation({ name: 'AmpR' }),
        makeAnnotation({ name: 'GFP', start: 800, end: 1500 }),
      ];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          editTargetIndex={1}
          onClearEditTarget={vi.fn()}
        />
      );
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
      const nameInput = screen.getByTestId('edit-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('GFP');
    });

    it('clears an active search that would hide the edit target, then expands it', () => {
      const annotations = [
        makeAnnotation({ name: 'AmpR', start: 100, end: 500 }),
        makeAnnotation({ name: 'GFP', start: 800, end: 1500 }),
        makeAnnotation({ name: 'ori', type: 'rep_origin', start: 2000, end: 2500 }),
      ];
      const { rerender } = render(
        <AnnotationsDrawerContent {...defaultProps} annotations={annotations} />
      );
      const searchInput = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
      fireEvent.change(searchInput, { target: { value: 'amp' } });
      expect(screen.queryByText('GFP')).toBeNull();

      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          editTargetIndex={1}
          onClearEditTarget={vi.fn()}
        />
      );

      expect((screen.getByPlaceholderText(/search/i) as HTMLInputElement).value).toBe('');
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
      expect((screen.getByTestId('edit-name-input') as HTMLInputElement).value).toBe('GFP');
    });

    it('leaves an active search untouched when the edit target is already listed', () => {
      const annotations = [
        makeAnnotation({ name: 'AmpR', start: 100, end: 500 }),
        makeAnnotation({ name: 'GFP', start: 800, end: 1500 }),
        makeAnnotation({ name: 'ori', type: 'rep_origin', start: 2000, end: 2500 }),
      ];
      const { rerender } = render(
        <AnnotationsDrawerContent {...defaultProps} annotations={annotations} />
      );
      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'gfp' } });
      expect(screen.getByText('GFP')).toBeDefined();

      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          editTargetIndex={1}
          onClearEditTarget={vi.fn()}
        />
      );

      expect((screen.getByPlaceholderText(/search/i) as HTMLInputElement).value).toBe('gfp');
      expect((screen.getByTestId('edit-name-input') as HTMLInputElement).value).toBe('GFP');
    });
  });

  describe('direction indicator', () => {
    it('renders SVG direction indicator for each annotation', () => {
      const annotations = [makeAnnotation({ direction: 1 })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      const row = screen.getByTestId('annotation-row-0');
      expect(row.querySelector('svg')).not.toBeNull();
    });
  });

  describe('cancel button', () => {
    it('collapses edit form when cancel clicked', () => {
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(<AnnotationsDrawerContent {...defaultProps} annotations={annotations} />);
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      expect(screen.getByTestId('annotation-edit-form')).toBeDefined();
      fireEvent.click(screen.getByTestId('edit-cancel-button'));
      expect(screen.queryByTestId('annotation-edit-form')).toBeNull();
    });

    it('discards unsaved edit fields without saving when cancel clicked', () => {
      const onAnnotationSave = vi.fn();
      const annotations = [makeAnnotation({ name: 'AmpR' })];
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          annotations={annotations}
          onAnnotationSave={onAnnotationSave}
        />
      );

      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      fireEvent.change(screen.getByTestId('edit-name-input'), {
        target: { value: 'Unsaved name' },
      });
      fireEvent.click(screen.getByTestId('edit-cancel-button'));

      expect(onAnnotationSave).not.toHaveBeenCalled();
      fireEvent.doubleClick(screen.getByTestId('annotation-row-0'));
      expect((screen.getByTestId('edit-name-input') as HTMLInputElement).value).toBe('AmpR');
    });
  });

  describe('plannotate tab', () => {
    it('shows run button on plannotate tab', () => {
      render(<AnnotationsDrawerContent {...defaultProps} activeTab="plannotate" />);
      expect(screen.getByRole('button', { name: /run plannotate/i })).toBeDefined();
    });

    it('shows staleness banner when stale', () => {
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          activeTab="plannotate"
          plannotateStatus="success"
          sequenceVersion={2}
          runVersion={1}
          reviewPanel={<div>Review Panel</div>}
        />
      );
      expect(screen.getByText(/sequence modified/i)).toBeDefined();
    });

    it('shows error with retry', () => {
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          activeTab="plannotate"
          plannotateStatus="error"
          plannotateError={userMessage('failure.annotation-failed')}
        />
      );
      expect(screen.getByText(userMessage('failure.annotation-failed'))).toBeDefined();
      expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
    });
  });

  describe('add annotation form (draft pre-fill)', () => {
    it('opens a blank add form and closes it after the annotation save completes', async () => {
      const onAnnotationAdd = vi.fn().mockResolvedValue(undefined);
      render(<AnnotationsDrawerContent {...defaultProps} onAnnotationAdd={onAnnotationAdd} />);

      const addButton = screen.getByRole('button', { name: 'Add Annotation' });
      expect(addButton.textContent?.trim()).toBe('Add');
      expect(addButton.getAttribute('title')).toBe('Add Annotation');
      fireEvent.click(addButton);

      expect(screen.getByTestId('annotation-add-form')).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Add Annotation' })).toBeNull();
      expect(screen.getByTestId('add-save-button')).toBeVisible();
      expect(screen.getByTestId('add-cancel-button')).toBeVisible();
      expect(screen.queryByTestId('apply-highlight-boundaries-button')).toBeNull();
      expect((screen.getByTestId('add-name-input') as HTMLInputElement).value).toBe('');
      expect((screen.getByTestId('add-start-input') as HTMLInputElement).value).toBe('');
      expect((screen.getByTestId('add-end-input') as HTMLInputElement).value).toBe('');

      fireEvent.change(screen.getByTestId('add-name-input'), {
        target: { value: 'Manual feature' },
      });
      fireEvent.change(screen.getByTestId('add-start-input'), { target: { value: '12' } });
      fireEvent.change(screen.getByTestId('add-end-input'), { target: { value: '45' } });
      fireEvent.click(screen.getByTestId('add-save-button'));

      expect(onAnnotationAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Manual feature',
          type: 'misc_feature',
          start: 12,
          end: 45,
          direction: 1,
        })
      );
      expect(onAnnotationAdd).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByTestId('annotation-add-form')).toBeNull());
      expect(screen.getByRole('button', { name: 'Add Annotation' })).toBeVisible();
    });

    it('advertises and applies the current highlight selection as add boundaries', () => {
      const onAnnotationAdd = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={onAnnotationAdd}
          currentSelectionRange={{ start: 13, end: 46 }}
        />
      );

      const addButton = screen.getByRole('button', { name: 'Add Annotation' });
      expect(addButton.getAttribute('title')).toContain('Highlight selection available (13..46)');
      fireEvent.click(addButton);

      const applyButton = screen.getByTestId('apply-highlight-boundaries-button');
      expect(applyButton.textContent).toContain(
        'Apply highlight selection as annotation boundaries'
      );
      expect(applyButton.getAttribute('title')).toContain('13..46');
      fireEvent.click(applyButton);

      expect((screen.getByTestId('add-start-input') as HTMLInputElement).value).toBe('13');
      expect((screen.getByTestId('add-end-input') as HTMLInputElement).value).toBe('46');
    });

    it('lets a manual annotation be created as a CDS explicitly', () => {
      const onAnnotationAdd = vi.fn();
      render(<AnnotationsDrawerContent {...defaultProps} onAnnotationAdd={onAnnotationAdd} />);

      fireEvent.click(screen.getByRole('button', { name: 'Add Annotation' }));
      fireEvent.change(screen.getByTestId('edit-type-input'), { target: { value: 'CDS' } });

      expect((screen.getByTestId('edit-type-input') as HTMLInputElement).value).toBe('CDS');

      fireEvent.change(screen.getByTestId('add-name-input'), {
        target: { value: 'Manual CDS' },
      });
      fireEvent.change(screen.getByTestId('add-start-input'), { target: { value: '12' } });
      fireEvent.change(screen.getByTestId('add-end-input'), { target: { value: '45' } });
      fireEvent.click(screen.getByTestId('add-save-button'));

      expect(onAnnotationAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Manual CDS',
          type: 'CDS',
          start: 12,
          end: 45,
        })
      );
    });

    it('strips hidden CDS qualifiers when an ORF-derived draft is changed to regular', () => {
      const onAnnotationAdd = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={onAnnotationAdd}
          pendingNewDraft={{
            type: 'CDS',
            name: 'ORF_frame1_1_300',
            start: 1,
            end: 300,
            direction: 1,
            qualifiers: { translation: ['MAA'], transl_table: ['1'], note: ['keep me'] },
          }}
          onClearPendingNewDraft={vi.fn()}
        />
      );

      fireEvent.change(screen.getByTestId('edit-type-input'), {
        target: { value: 'misc_feature' },
      });
      expect((screen.getByTestId('edit-type-input') as HTMLInputElement).value).toBe(
        'misc_feature'
      );
      fireEvent.click(screen.getByTestId('add-save-button'));

      expect(onAnnotationAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'misc_feature',
          qualifiers: { note: ['keep me'] },
        })
      );
    });

    it('starts a live draft from the current highlight when Add Annotation is clicked', () => {
      const onPendingNewDraftChange = vi.fn();
      const onClearPendingNewDraft = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          currentSelectionRange={{ start: 13, end: 46 }}
          onPendingNewDraftChange={onPendingNewDraftChange}
          onClearPendingNewDraft={onClearPendingNewDraft}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Add Annotation' }));

      expect(onPendingNewDraftChange).toHaveBeenCalledWith({
        type: 'misc_feature',
        name: '',
        start: 13,
        end: 46,
        direction: 1,
        color: '#4E79A7',
      });
      expect(onClearPendingNewDraft).not.toHaveBeenCalled();
    });

    it('canceling add discards the ephemeral draft and pending range without saving', () => {
      const onAnnotationAdd = vi.fn();
      const onPendingNewDraftChange = vi.fn();
      const onClearPendingNewDraft = vi.fn();
      const onClearPendingNewRange = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={onAnnotationAdd}
          pendingNewRange={{ start: 13, end: 46 }}
          pendingNewDraft={{
            type: 'misc_feature',
            name: '',
            start: 13,
            end: 46,
            direction: 1,
            color: '#4E79A7',
          }}
          onPendingNewDraftChange={onPendingNewDraftChange}
          onClearPendingNewDraft={onClearPendingNewDraft}
          onClearPendingNewRange={onClearPendingNewRange}
        />
      );

      expect(screen.getByTestId('annotation-add-form')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Add Annotation' })).toBeNull();
      expect(screen.getByTestId('add-save-button')).toBeVisible();
      expect(screen.getByTestId('add-cancel-button')).toBeVisible();
      fireEvent.click(screen.getByTestId('add-cancel-button'));

      expect(screen.queryByTestId('annotation-add-form')).toBeNull();
      expect(screen.getByRole('button', { name: 'Add Annotation' })).toBeVisible();
      expect(onAnnotationAdd).not.toHaveBeenCalled();
      expect(onPendingNewDraftChange).toHaveBeenCalledWith(null);
      expect(onClearPendingNewDraft).toHaveBeenCalled();
      expect(onClearPendingNewRange).toHaveBeenCalled();
    });

    it('switching away from the annotations tab discards the active add draft', () => {
      const onPendingNewDraftChange = vi.fn();
      const onClearPendingNewDraft = vi.fn();
      renderControlled({
        ...defaultProps,
        onAnnotationAdd: vi.fn(),
        pendingNewDraft: {
          type: 'CDS',
          name: '',
          start: 13,
          end: 46,
          direction: 1,
          color: '#4E79A7',
        },
        onPendingNewDraftChange,
        onClearPendingNewDraft,
      });

      fireEvent.click(screen.getByRole('tab', { name: /plannotate/i }));

      expect(screen.queryByTestId('annotation-add-form')).toBeNull();
      expect(onPendingNewDraftChange).toHaveBeenCalledWith(null);
      expect(onClearPendingNewDraft).toHaveBeenCalled();
    });

    it('emits live draft type changes when the Regular/CDS switch is flipped', async () => {
      const onPendingNewDraftChange = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewDraft={{
            type: 'misc_feature',
            name: '',
            start: 13,
            end: 46,
            direction: 1,
            color: '#4E79A7',
          }}
          onPendingNewDraftChange={onPendingNewDraftChange}
        />
      );

      onPendingNewDraftChange.mockClear();

      fireEvent.change(screen.getByTestId('edit-type-input'), { target: { value: 'CDS' } });
      await waitFor(() =>
        expect(onPendingNewDraftChange).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'CDS',
            start: 13,
            end: 46,
          })
        )
      );

      onPendingNewDraftChange.mockClear();
      fireEvent.change(screen.getByTestId('edit-type-input'), {
        target: { value: 'misc_feature' },
      });
      await waitFor(() =>
        expect(onPendingNewDraftChange).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'misc_feature',
            start: 13,
            end: 46,
          })
        )
      );
    });

    it('opens with type/name/direction pre-filled from pendingNewDraft', () => {
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewDraft={{
            type: 'CDS',
            name: 'ORF_frame3_120_300',
            start: 120,
            end: 300,
            direction: 1,
            qualifiers: { translation: ['MNK*'], transl_table: ['1'] },
          }}
          onClearPendingNewDraft={vi.fn()}
        />
      );
      expect((screen.getByTestId('add-name-input') as HTMLInputElement).value).toBe(
        'ORF_frame3_120_300'
      );
      expect((screen.getByTestId('add-start-input') as HTMLInputElement).value).toBe('120');
      expect((screen.getByTestId('add-end-input') as HTMLInputElement).value).toBe('300');
    });

    it('save preserves draft qualifiers on the persisted annotation', () => {
      const onAnnotationAdd = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={onAnnotationAdd}
          pendingNewDraft={{
            type: 'CDS',
            name: 'ORF_frame1_1_300',
            start: 1,
            end: 300,
            direction: 1,
            qualifiers: { translation: ['MAA'], transl_table: ['1'] },
          }}
          onClearPendingNewDraft={vi.fn()}
        />
      );
      fireEvent.click(screen.getByTestId('add-save-button'));
      expect(onAnnotationAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CDS',
          name: 'ORF_frame1_1_300',
          start: 1,
          end: 300,
          direction: 1,
          qualifiers: { translation: ['MAA'], transl_table: ['1'] },
        })
      );
    });

    it('switching from a range to a different draft remounts the form', () => {
      const { rerender } = render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewRange={{ start: 100, end: 200 }}
          onClearPendingNewRange={vi.fn()}
          draftSessionId={1}
        />
      );
      expect((screen.getByTestId('add-name-input') as HTMLInputElement).value).toBe('');

      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewRange={null}
          pendingNewDraft={{
            type: 'CDS',
            name: 'ORF_X',
            start: 500,
            end: 800,
            direction: -1,
          }}
          onClearPendingNewDraft={vi.fn()}
          draftSessionId={2}
        />
      );
      expect((screen.getByTestId('add-name-input') as HTMLInputElement).value).toBe('ORF_X');
      expect((screen.getByTestId('add-start-input') as HTMLInputElement).value).toBe('500');
    });
  });

  describe('add annotation form (pre-fill)', () => {
    it('opens with start/end pre-filled from pendingNewRange', () => {
      const onAnnotationAdd = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={onAnnotationAdd}
          pendingNewRange={{ start: 100, end: 200 }}
          onClearPendingNewRange={vi.fn()}
        />
      );
      const startInput = screen.getByTestId('add-start-input') as HTMLInputElement;
      const endInput = screen.getByTestId('add-end-input') as HTMLInputElement;
      expect(startInput.value).toBe('100');
      expect(endInput.value).toBe('200');
    });

    it('resets to a new range when draft session id increments', () => {
      const { rerender } = render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewRange={{ start: 100, end: 200 }}
          onClearPendingNewRange={vi.fn()}
          draftSessionId={1}
        />
      );
      expect((screen.getByTestId('add-start-input') as HTMLInputElement).value).toBe('100');

      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewRange={{ start: 555, end: 999 }}
          onClearPendingNewRange={vi.fn()}
          draftSessionId={2}
        />
      );
      expect((screen.getByTestId('add-start-input') as HTMLInputElement).value).toBe('555');
      expect((screen.getByTestId('add-end-input') as HTMLInputElement).value).toBe('999');
    });

    it('persists user edits when only the draft fields change but session id is stable', () => {
      const { rerender } = render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewDraft={{
            type: 'CDS',
            name: 'ORF_initial',
            start: 100,
            end: 300,
            direction: 1,
          }}
          onClearPendingNewDraft={vi.fn()}
          onPendingNewDraftChange={vi.fn()}
          draftSessionId={1}
        />
      );
      const nameInput = screen.getByTestId('add-name-input') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: 'user_typed' } });
      expect(nameInput.value).toBe('user_typed');

      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewDraft={{
            type: 'CDS',
            name: 'user_typed',
            start: 100,
            end: 300,
            direction: 1,
          }}
          onClearPendingNewDraft={vi.fn()}
          onPendingNewDraftChange={vi.fn()}
          draftSessionId={1}
        />
      );
      expect((screen.getByTestId('add-name-input') as HTMLInputElement).value).toBe('user_typed');
    });

    it('emits live draft updates for blank names and clears the preview when coordinates are invalid', async () => {
      const onPendingNewDraftChange = vi.fn();
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewDraft={{
            type: 'misc_feature',
            name: 'initial',
            start: 100,
            end: 200,
            direction: 1,
            color: '#4E79A7',
          }}
          onClearPendingNewDraft={vi.fn()}
          onPendingNewDraftChange={onPendingNewDraftChange}
          draftSessionId={1}
        />
      );

      fireEvent.change(screen.getByTestId('add-name-input'), { target: { value: '' } });
      await waitFor(() =>
        expect(onPendingNewDraftChange).toHaveBeenCalledWith(
          expect.objectContaining({
            name: '',
            start: 100,
            end: 200,
          })
        )
      );

      fireEvent.change(screen.getByTestId('add-end-input'), { target: { value: '50' } });
      await waitFor(() => expect(onPendingNewDraftChange).toHaveBeenCalledWith(null));
    });

    it('persists user edits when re-rendered with the same draft session id', () => {
      const range = { start: 100, end: 200 };
      const { rerender } = render(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewRange={range}
          onClearPendingNewRange={vi.fn()}
          draftSessionId={5}
        />
      );
      const nameInput = screen.getByTestId('add-name-input') as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: 'MyFeature' } });
      expect(nameInput.value).toBe('MyFeature');

      rerender(
        <AnnotationsDrawerContent
          {...defaultProps}
          onAnnotationAdd={vi.fn()}
          pendingNewRange={{ start: 100, end: 200 }}
          onClearPendingNewRange={vi.fn()}
          draftSessionId={5}
        />
      );
      expect((screen.getByTestId('add-name-input') as HTMLInputElement).value).toBe('MyFeature');
    });
  });

  describe('review session indicator', () => {
    it('shows gold dot on pLannotate tab when hasReviewSession and on annotations tab', () => {
      render(
        <AnnotationsDrawerContent
          {...defaultProps}
          hasReviewSession={true}
          reviewPanel={<div>Review Panel</div>}
          plannotateStatus="success"
        />
      );
      const plannotateTab = screen.getByRole('tab', { name: /plannotate/i });
      const dot = plannotateTab.querySelector('span.rounded-full');
      expect(dot).not.toBeNull();
      expect(dot?.className).toContain('bg-yellow');
    });

    it('hides gold dot when no review session', () => {
      render(<AnnotationsDrawerContent {...defaultProps} hasReviewSession={false} />);
      const plannotateTab = screen.getByRole('tab', { name: /plannotate/i });
      const dot = plannotateTab.querySelector('span.rounded-full');
      expect(dot?.className).toContain('bg-transparent');
    });

    it('calls onTabChange when switching tabs', () => {
      const onTabChange = vi.fn();
      render(<AnnotationsDrawerContent {...defaultProps} onTabChange={onTabChange} />);
      fireEvent.click(screen.getByRole('tab', { name: /plannotate/i }));
      expect(onTabChange).toHaveBeenCalledWith('plannotate');
    });
  });
});

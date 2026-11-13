import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnnotationReviewPanel } from './AnnotationReviewPanel';
import { formatPosition } from './format-position';
import type { DraftAnnotation } from '../types';

function createTestDraft(overrides: Partial<DraftAnnotation> = {}): DraftAnnotation {
  return {
    id: `draft-${Math.random()}`,
    name: 'Test Feature',
    start: 100,
    end: 500,
    strand: 1,
    identity: 95,
    coverage: 90,
    confidence: 85.5,
    accepted: true,
    duplicateStatus: { isDuplicate: false },
    type: 'CDS',
    ref_start: 1,
    ref_end: 100,
    ref_length: 100,
    db_source: 'nucleotide',
    ...overrides,
  };
}

describe('formatPosition', () => {
  it('forward strand: start + length', () => {
    const pos = formatPosition(100, 500, 1);
    expect(pos.origin).toBe('100');
    expect(pos.delta).toBe('+ 401');
  });

  it('reverse strand: higher coord - length', () => {
    const pos = formatPosition(100, 500, -1);
    expect(pos.origin).toBe('500');
    expect(pos.delta).toBe('- 401');
  });

  it('no direction: lower coord only', () => {
    const pos = formatPosition(100, 500, 0);
    expect(pos.origin).toBe('100');
    expect(pos.delta).toBeNull();
  });

  it('formats large numbers with commas', () => {
    const pos = formatPosition(10000, 10341, 1);
    expect(pos.origin).toBe('10,000');
    expect(pos.delta).toBe('+ 342');
  });

  it('handles single-base range', () => {
    const pos = formatPosition(500, 500, 1);
    expect(pos.origin).toBe('500');
    expect(pos.delta).toBe('+ 1');
  });
});

describe('AnnotationReviewPanel', () => {
  const defaultProps = {
    drafts: [] as DraftAnnotation[],
    selectedId: null as string | null,
    onSelect: vi.fn(),
    onToggleAccepted: vi.fn(),
    onAcceptRange: vi.fn(),
    onSetRangeAccepted: vi.fn(),
    onAcceptAll: vi.fn(),
    onRejectAll: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the revision blocker and prevents Apply while retaining the candidates', () => {
    render(
      <AnnotationReviewPanel
        {...defaultProps}
        drafts={[createTestDraft({ name: 'retained candidate' })]}
        commitBlockedReason={userMessage('annotation.revisionChanged')}
      />
    );
    const apply = screen.getByRole('button', { name: /Apply/ });
    expect(apply).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('differs from the analyzed revision');
    expect(screen.getByText('retained candidate')).toBeVisible();
    fireEvent.click(apply);
    expect(defaultProps.onCommit).not.toHaveBeenCalled();
  });

  it('offers an explicit refresh without discarding the review or invoking Apply', () => {
    const refresh = vi.fn();
    render(
      <AnnotationReviewPanel
        {...defaultProps}
        drafts={[createTestDraft({ name: 'retained candidate' })]}
        commitBlockedReason="The document changed after inspection."
        onRefreshReview={refresh}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh review', exact: true }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(defaultProps.onCommit).not.toHaveBeenCalled();
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('retained candidate')).toBeVisible();
  });

  it('offers one explicit rerun when coordinate history cannot be verified', () => {
    const refresh = vi.fn();
    const rerun = vi.fn();
    render(
      <AnnotationReviewPanel
        {...defaultProps}
        drafts={[createTestDraft()]}
        commitBlockedReason="No verified saved edit history reaches the current document."
        onRefreshReview={refresh}
        onRerunReview={rerun}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rerun annotation', exact: true }));
    expect(rerun).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Refresh review', exact: true })).toBeNull();
  });

  it('explains mapped coordinates, unrecalculated scores and substitution overlap', () => {
    render(
      <AnnotationReviewPanel
        {...defaultProps}
        drafts={[createTestDraft({ savedSubstitutionOverlap: true })]}
        coordinateProvenance={{ coordinates: 'mapped', transitionCount: 2 }}
      />
    );
    expect(
      screen.getByText('Coordinates were moved through 2 verified saved edits.')
    ).toBeVisible();
    expect(screen.getByText('Identity and coverage scores were not recalculated.')).toBeVisible();
    expect(screen.getByText('bases changed')).toHaveAttribute(
      'title',
      'Saved substitutions overlap this candidate; identity and coverage were not recalculated.'
    );
  });

  it('disables Discard and repeated Apply while the native owner is saving', () => {
    render(<AnnotationReviewPanel {...defaultProps} drafts={[createTestDraft()]} isApplying />);
    const discard = screen.getByRole('button', { name: 'Discard', exact: true });
    expect(discard).toBeDisabled();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    fireEvent.click(discard);
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  describe('rendering', () => {
    it('renders empty state when no drafts', () => {
      render(<AnnotationReviewPanel {...defaultProps} />);
      expect(screen.getByText(/no annotations found/i)).toBeDefined();
    });

    it('renders list of drafts with names', () => {
      const drafts = [
        createTestDraft({ id: '1', name: 'AmpR' }),
        createTestDraft({ id: '2', name: 'ColE1 origin' }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('AmpR')).toBeDefined();
      expect(screen.getByText('ColE1 origin')).toBeDefined();
    });

    it('shows identity and coverage columns with appropriate colors', () => {
      const drafts = [
        createTestDraft({
          id: '1',
          name: 'High',
          identity: 98,
          coverage: 100,
          confidence: 98,
          db_source: 'nucleotide',
        }),
        createTestDraft({
          id: '2',
          name: 'Medium',
          identity: 85,
          coverage: 50,
          confidence: 42.5,
          db_source: 'protein',
          ref_start: 1,
          ref_end: 50,
          ref_length: 100,
        }),
        createTestDraft({
          id: '3',
          name: 'Low',
          identity: 60,
          coverage: 30,
          confidence: 18,
          db_source: 'rna',
        }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('98')).toBeDefined();
      expect(screen.getByText('nt')).toBeDefined();
      expect(screen.getByText('AA')).toBeDefined();
      expect(screen.getByText('RNA')).toBeDefined();

      expect(screen.getByText('100')).toBeDefined();
      expect(screen.getAllByText('50').length).toBeGreaterThan(0);
      expect(screen.getByText('30')).toBeDefined();
    });

    it('shows coverage percentage for partial matches', () => {
      const drafts = [
        createTestDraft({
          id: '1',
          name: 'Fragment',
          coverage: 50,
          db_source: 'protein',
          ref_start: 1,
          ref_end: 50,
          ref_length: 100,
        }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('50')).toBeDefined();
    });

    it('shows New column for non-duplicate annotations', () => {
      const drafts = [
        createTestDraft({
          id: '1',
          name: 'NewFeature',
          duplicateStatus: { isDuplicate: false },
        }),
        createTestDraft({
          id: '2',
          name: 'ExistingFeature',
          duplicateStatus: {
            isDuplicate: true,
            reason: 'exact',
            existingAnnotationName: 'Existing',
          },
        }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('★')).toBeDefined();
      expect(screen.getByText('✓')).toBeDefined();
    });

    it('highlights selected row', () => {
      const drafts = [
        createTestDraft({ id: 'first-id', name: 'First' }),
        createTestDraft({ id: 'second-id', name: 'Second' }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} selectedId="second-id" />);

      const rows = screen.getAllByRole('row');
      expect(rows[1].getAttribute('data-selected')).toBe('true');
    });

    it('shows position as start ± length', () => {
      const drafts = [createTestDraft({ id: '1', start: 100, end: 500, strand: 1 })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('100 + 401')).toBeDefined();
    });

    it('shows start - length for reverse strand', () => {
      const drafts = [createTestDraft({ id: '1', start: 100, end: 500, strand: -1 })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('500 - 401')).toBeDefined();
    });

    it('shows just start for no-direction strand', () => {
      const drafts = [createTestDraft({ id: '1', start: 100, end: 500, strand: 0 })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('100')).toBeDefined();
    });

    it('shows feature type', () => {
      const drafts = [createTestDraft({ id: '1', type: 'promoter' })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText('promoter')).toBeDefined();
    });
  });

  describe('interactions', () => {
    it('calls onSelect with draft id when row is clicked', () => {
      const onSelect = vi.fn();
      const drafts = [
        createTestDraft({ id: 'first-id', name: 'First' }),
        createTestDraft({ id: 'second-id', name: 'Second' }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} onSelect={onSelect} />);

      fireEvent.click(screen.getByText('Second'));

      expect(onSelect).toHaveBeenCalledWith('second-id');
    });

    it('calls onToggleAccepted when checkbox clicked', () => {
      const onToggleAccepted = vi.fn();
      const drafts = [createTestDraft({ id: 'test-id', name: 'Feature', accepted: true })];

      render(
        <AnnotationReviewPanel
          {...defaultProps}
          drafts={drafts}
          onToggleAccepted={onToggleAccepted}
        />
      );

      const row = screen.getByText('Feature').closest('[role="row"]');
      const checkbox = row?.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeDefined();
      if (checkbox) fireEvent.click(checkbox);

      expect(onToggleAccepted).toHaveBeenCalledWith('test-id');
    });

    it('calls onAcceptAll when Select all button clicked', () => {
      const onAcceptAll = vi.fn();
      const drafts = [createTestDraft({ id: '1' })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} onAcceptAll={onAcceptAll} />);

      fireEvent.click(screen.getByRole('button', { name: /select all/i }));

      expect(onAcceptAll).toHaveBeenCalled();
    });

    it('calls onRejectAll when Clear all button clicked', () => {
      const onRejectAll = vi.fn();
      const drafts = [createTestDraft({ id: '1' })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} onRejectAll={onRejectAll} />);

      fireEvent.click(screen.getByRole('button', { name: /clear all/i }));

      expect(onRejectAll).toHaveBeenCalled();
    });

    it('calls onCommit when Apply button clicked', () => {
      const onCommit = vi.fn();
      const drafts = [createTestDraft({ id: '1', accepted: true })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} onCommit={onCommit} />);

      fireEvent.click(screen.getByRole('button', { name: /apply/i }));

      expect(onCommit).toHaveBeenCalled();
    });

    it('calls onCancel when Discard button clicked', () => {
      const onCancel = vi.fn();
      const drafts = [createTestDraft({ id: '1' })];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} onCancel={onCancel} />);

      fireEvent.click(screen.getByRole('button', { name: /discard/i }));

      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('summary', () => {
    it('shows count of selected annotations', () => {
      const drafts = [
        createTestDraft({ id: '1', accepted: true }),
        createTestDraft({ id: '2', accepted: false }),
        createTestDraft({ id: '3', accepted: true }),
      ];

      render(<AnnotationReviewPanel {...defaultProps} drafts={drafts} />);

      expect(screen.getByText(/2 of 3 selected/i)).toBeDefined();
    });
  });
});

describe('AnnotationReviewPanel — footer space management in narrow drawers', () => {
  const footerProps = {
    drafts: [createTestDraft({ id: 'a' }), createTestDraft({ id: 'b' })],
    selectedId: null as string | null,
    onSelect: vi.fn(),
    onToggleAccepted: vi.fn(),
    onAcceptRange: vi.fn(),
    onSetRangeAccepted: vi.fn(),
    onAcceptAll: vi.fn(),
    onRejectAll: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };

  const footer = () => screen.getByTestId('plannotate-review-footer');
  const meta = () => screen.getByTestId('plannotate-review-footer-meta');
  const actions = () => screen.getByTestId('plannotate-review-footer-actions');

  it('never wraps: the footer row is flex-nowrap', () => {
    render(<AnnotationReviewPanel {...footerProps} />);
    expect(footer().className).toContain('flex-nowrap');
    expect(footer().className).not.toMatch(/(^|\s)flex-wrap(\s|$)/);
  });

  it('the action buttons can never be squeezed or wrapped out of the drawer', () => {
    render(<AnnotationReviewPanel {...footerProps} />);
    expect(actions().className).toContain('shrink-0');
    for (const label of ['Discard', 'Apply']) {
      const button = screen.getByRole('button', { name: new RegExp(`^${label}`) });
      expect(button.className, `${label} must not shrink`).toContain('shrink-0');
      expect(button.className, `${label} must not wrap`).toContain('whitespace-nowrap');
    }
  });

  it('the selection count is the single flexible element and truncates', () => {
    render(<AnnotationReviewPanel {...footerProps} />);
    expect(meta().className).toContain('min-w-0');
    expect(meta().className).toContain('flex-1');
    const count = screen.getByTitle(/of 2 selected$/);
    expect(count.className).toContain('truncate');
    expect(count.className).toContain('min-w-0');
  });

  it('the secondary links stay on one line rather than shrinking to nothing', () => {
    render(<AnnotationReviewPanel {...footerProps} />);
    for (const label of ['Select all', 'Clear all']) {
      const button = screen.getByRole('button', { name: label });
      expect(button.className).toContain('shrink-0');
      expect(button.className).toContain('whitespace-nowrap');
    }
  });
});

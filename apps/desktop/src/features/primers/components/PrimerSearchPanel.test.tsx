import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PrimerSearchPanel } from './PrimerSearchPanel';
import type { PrimerSearchResult } from '../primer-search-service';
import type { Primer } from '../types';

const analyticsMocks = vi.hoisted(() => ({
  trackToolError: vi.fn(),
}));

vi.mock('../../../lib/analytics', () => analyticsMocks);

function makePrimer(overrides?: Partial<Primer>): Primer {
  return {
    id: 'p1',
    catalogNumber: 'P001',
    name: 'Test_F1',
    sequence: 'ATCGATCGATCGATCGATCG',
    length: 20,
    tm: 58.4,
    gcPercent: 50.0,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeResult(overrides?: Partial<PrimerSearchResult>): PrimerSearchResult {
  return {
    primer: makePrimer(),
    hits: [{ start: 100, end: 120, strand: 1, identity: 1.0, editDistance: 0 }],
    bestHit: { start: 100, end: 120, strand: 1, identity: 1.0, editDistance: 0 },
    isAttached: false,
    ...overrides,
  };
}

const defaultProps = {
  results: [] as PrimerSearchResult[],
  isSearching: false,
  onSearch: vi.fn(),
  onAttach: vi.fn().mockResolvedValue(undefined),
  sequenceLength: 5000,
  selectionRange: null as { start: number; end: number } | null,
};

describe('PrimerSearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders search button', () => {
    render(<PrimerSearchPanel {...defaultProps} />);
    expect(screen.getByTestId('primer-search-button')).toBeDefined();
  });

  it('calls onSearch when search button clicked', () => {
    render(<PrimerSearchPanel {...defaultProps} />);
    fireEvent.click(screen.getByTestId('primer-search-button'));
    expect(defaultProps.onSearch).toHaveBeenCalled();
  });

  it('preserves zero as the exact-match mismatch constraint', () => {
    render(<PrimerSearchPanel {...defaultProps} />);

    fireEvent.change(screen.getByTestId('max-mismatches'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByTestId('primer-search-button'));

    expect(defaultProps.onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ maxMismatches: 0 })
    );
  });

  it('shows loading state while searching', () => {
    render(<PrimerSearchPanel {...defaultProps} isSearching={true} />);
    expect(screen.getByText(/searching library/i)).toBeDefined();
  });

  it('renders search results with primer info', () => {
    const results = [makeResult({ primer: makePrimer({ name: 'lacZ_F1' }) })];
    render(<PrimerSearchPanel {...defaultProps} results={results} />);

    expect(screen.getByText('lacZ_F1')).toBeDefined();
    expect(screen.getByText(/100%/)).toBeDefined();
  });

  it('shows Attach button for unattached primers', () => {
    const results = [makeResult({ isAttached: false })];
    render(<PrimerSearchPanel {...defaultProps} results={results} />);

    expect(screen.getByTestId('search-attach-p1')).toBeDefined();
  });

  it('shows check mark for attached primers', () => {
    const results = [makeResult({ isAttached: true })];
    render(<PrimerSearchPanel {...defaultProps} results={results} />);

    expect(screen.getByText('✓')).toBeDefined();
  });

  it('calls onAttach with primer and bestHit when Attach clicked', async () => {
    const result = makeResult();
    render(<PrimerSearchPanel {...defaultProps} results={[result]} />);

    fireEvent.click(screen.getByTestId('search-attach-p1'));
    expect(defaultProps.onAttach).toHaveBeenCalledWith(result.primer, result.bestHit);
    await waitFor(() => expect(screen.getByTestId('search-attach-p1')).toBeEnabled());
  });

  it('surfaces an artifact attach failure without an unhandled rejection', async () => {
    const result = makeResult();
    const onAttach = vi.fn().mockRejectedValue(new Error('artifact changed on disk'));
    render(<PrimerSearchPanel {...defaultProps} results={[result]} onAttach={onAttach} />);

    fireEvent.click(screen.getByTestId('search-attach-p1'));

    await waitFor(() =>
      expect(screen.getByTestId('primer-attach-error').textContent).toBe(
        userMessageWithValues('primer.attachFailed', { name: userMessageValue('Test_F1') })
      )
    );
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('shows region constraint options', () => {
    render(<PrimerSearchPanel {...defaultProps} />);
    expect(screen.getByTestId('region-mode-select')).toBeDefined();
  });

  it('passes region constraint to onSearch when using selection', () => {
    render(<PrimerSearchPanel {...defaultProps} selectionRange={{ start: 100, end: 200 }} />);

    fireEvent.change(screen.getByTestId('region-mode-select'), {
      target: { value: 'selection' },
    });
    fireEvent.click(screen.getByTestId('primer-search-button'));

    expect(defaultProps.onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ regionStart: 100, regionEnd: 200 })
    );
  });

  it('filters results by name text filter', () => {
    const results = [
      makeResult({ primer: makePrimer({ id: 'p1', name: 'lacZ_F1' }) }),
      makeResult({ primer: makePrimer({ id: 'p2', name: 'ampR_R1' }) }),
    ];
    render(<PrimerSearchPanel {...defaultProps} results={results} />);

    fireEvent.change(screen.getByTestId('search-text-filter'), {
      target: { value: 'lacZ' },
    });

    expect(screen.getByText('lacZ_F1')).toBeDefined();
    expect(screen.queryByText('ampR_R1')).toBeNull();
  });
});

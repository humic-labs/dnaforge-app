import { userMessage } from '@waypoint/user-messages';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { FindBar } from '@waypoint/workspace-editor';
import type { SearchMode } from '@waypoint/workspace-editor';
import type { SearchMatch } from '@waypoint/sequence-utils';
import { annotationTypeBadgeStyle } from '@waypoint/genome-renderer/pure';

const DEFAULT_PLATFORM = navigator.platform;

function defaultProps(overrides: Partial<Parameters<typeof FindBar>[0]> = {}) {
  return {
    query: '',
    mode: 'nucleotide' as SearchMode,
    matchCount: 0,
    activeIndex: 0,
    isActiveReverse: false,
    isError: false,
    errorMessage: null,
    onQueryChange: vi.fn(),
    onModeChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

const aaMatches: SearchMatch[] = [
  { start: 9, end: 20, strand: 'forward', type: 'annotation', label: 'Feature A' },
  { start: 99, end: 120, strand: 'forward', type: 'annotation', label: 'Feature B' },
  { start: 199, end: 220, strand: 'reverse', type: 'annotation', label: 'Feature C' },
];

function setNavigatorPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('FindBar', () => {
  afterEach(() => {
    setNavigatorPlatform(DEFAULT_PLATFORM);
  });

  it('renders with search role and correct structure', () => {
    render(<FindBar {...defaultProps()} />);

    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByLabelText('Search pattern')).toBeInTheDocument();
    expect(screen.getByLabelText('Close find bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous match')).toBeInTheDocument();
    expect(screen.getByLabelText('Next match')).toBeInTheDocument();
  });

  it('shows "DNA" mode pill in nucleotide mode', () => {
    render(<FindBar {...defaultProps({ mode: 'nucleotide' })} />);
    expect(screen.getByLabelText('Search mode: DNA bases')).toHaveTextContent('DNA');
  });

  it('shows "AA+" mode pill in aminoAcid mode', () => {
    render(<FindBar {...defaultProps({ mode: 'aminoAcid' })} />);
    expect(screen.getByLabelText('Search mode: AA and features')).toHaveTextContent('AA+');
  });

  it('shows correct placeholder per mode', () => {
    const { rerender } = render(<FindBar {...defaultProps({ mode: 'nucleotide' })} />);
    expect(screen.getByPlaceholderText('Search DNA bases...')).toBeInTheDocument();

    rerender(<FindBar {...defaultProps({ mode: 'aminoAcid' })} />);
    expect(screen.getByPlaceholderText('Search AA or features...')).toBeInTheDocument();
  });

  it('shows match counter in "N of M" format', () => {
    render(
      <FindBar
        {...defaultProps({
          query: 'ATG',
          matchCount: 5,
          activeIndex: 1,
        })}
      />
    );

    expect(screen.getByText('2 of 5')).toBeInTheDocument();
  });

  it('labels a bounded result list truthfully when additional hits exist', () => {
    render(
      <FindBar
        {...defaultProps({
          query: 'AT',
          matchCount: 500,
          activeIndex: 0,
          isTruncated: true,
        })}
      />
    );

    expect(screen.getByText('1 of 500+')).toBeInTheDocument();
  });

  it('groups peptide occurrences by gene and identifies each source isoform', () => {
    const proteinMatches: SearchMatch[] = [
      {
        start: 100,
        end: 114,
        strand: 'forward',
        type: 'protein',
        annotationTrackId: 'mRNA',
        label: 'NM_000518.5',
        protein: {
          geneId: 'HBB',
          transcriptId: 'HBB.mrna.1',
          proteinStart: 1,
          proteinEnd: 6,
          geneticCode: 1,
          segments: [{ start: 100, end: 115 }],
        },
      },
      {
        start: 200,
        end: 214,
        strand: 'forward',
        type: 'protein',
        annotationTrackId: 'mRNA',
        label: 'NM_000519.4',
        protein: {
          geneId: 'HBB',
          transcriptId: 'HBB.mrna.2',
          proteinStart: 2,
          proteinEnd: 7,
          geneticCode: 1,
          segments: [{ start: 200, end: 215 }],
        },
      },
      {
        start: 300,
        end: 314,
        strand: 'reverse',
        type: 'protein',
        annotationTrackId: 'mRNA',
        label: 'NM_000519.5',
        protein: {
          geneId: 'HBD',
          transcriptId: 'HBD.mrna.1',
          proteinStart: 3,
          proteinEnd: 8,
          geneticCode: 1,
          segments: [{ start: 300, end: 315 }],
        },
      },
    ];
    render(
      <FindBar
        {...defaultProps({
          query: 'MVHLT',
          mode: 'aminoAcid',
          matchCount: proteinMatches.length,
          matches: proteinMatches,
        })}
      />
    );

    expect(screen.getAllByTestId('findbar-protein-gene-group')).toHaveLength(2);
    expect(screen.getByText('HBB')).toBeInTheDocument();
    expect(screen.getByText('HBD')).toBeInTheDocument();
    expect(screen.getByText('NM_000518.5')).toBeInTheDocument();
    expect(screen.getByText('NM_000519.4')).toBeInTheDocument();
    expect(screen.getByText('NM_000519.5')).toBeInTheDocument();
    expect(screen.getAllByText('Peptide')).toHaveLength(3);
  });

  it('shows a clickable nucleotide hit list with off-anchor chromosome-local coordinates', () => {
    const onActivateMatch = vi.fn();
    render(
      <FindBar
        {...defaultProps({
          query: 'GCAGAATCCAGATGCTCAAGGCCC',
          mode: 'nucleotide',
          matchCount: 1,
          matches: [
            {
              start: 1_813_906_545,
              end: 1_813_906_568,
              chrom: 'chr11',
              localStart: 5_225_494,
              localEnd: 5_225_517,
              strand: 'forward',
              type: 'nucleotide',
              label: 'GCAGAATCCAGATGCTCAAGGCCC',
            },
          ],
          onActivateMatch,
        })}
      />
    );

    const row = screen.getByTestId('findbar-aa-result-row');
    expect(row).toHaveTextContent('DNA');
    expect(row).toHaveTextContent('chr11:5225495');
    expect(row).toHaveTextContent('5225518');
    fireEvent.click(row);
    expect(onActivateMatch).toHaveBeenCalledWith(0);
  });

  it('shows "No matches" when matchCount is 0 and query exists', () => {
    render(<FindBar {...defaultProps({ query: 'ZZZZZ', matchCount: 0 })} />);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('shows a truthful pending state instead of "No matches" while work is active', () => {
    render(<FindBar {...defaultProps({ query: 'HBB', matchCount: 0, isSearching: true })} />);

    expect(screen.getByText('Searching…')).toBeInTheDocument();
    expect(screen.queryByText('No matches')).not.toBeInTheDocument();
    expect(screen.getByRole('search')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows error message when isError is true', () => {
    render(
      <FindBar
        {...defaultProps({
          query: 'ATG[[',
          isError: true,
          errorMessage: userMessage('sequenceSearch.invalidPattern'),
        })}
      />
    );
    expect(screen.getByText('Invalid pattern')).toBeInTheDocument();
  });

  it('shows "(rev)" suffix when isActiveReverse', () => {
    render(
      <FindBar
        {...defaultProps({
          query: 'ATG',
          matchCount: 3,
          activeIndex: 0,
          isActiveReverse: true,
        })}
      />
    );
    expect(screen.getByText('1 of 3 (rev)')).toBeInTheDocument();
  });

  it('calls onQueryChange when typing in input', () => {
    const onQueryChange = vi.fn();
    render(<FindBar {...defaultProps({ onQueryChange })} />);

    const input = screen.getByLabelText('Search pattern');
    fireEvent.change(input, { target: { value: 'ATG' } });

    expect(onQueryChange).toHaveBeenCalledWith('ATG');
  });

  it('clicking mode pill calls onModeChange', () => {
    const onModeChange = vi.fn();
    render(<FindBar {...defaultProps({ mode: 'nucleotide', onModeChange })} />);

    fireEvent.click(screen.getByLabelText('Search mode: DNA bases'));
    expect(onModeChange).toHaveBeenCalledWith('aminoAcid');
  });

  it('Cmd+F inside the focused find input switches DNA search to feature/AA search', () => {
    const onModeChange = vi.fn();
    setNavigatorPlatform('MacIntel');
    render(<FindBar {...defaultProps({ mode: 'nucleotide', onModeChange })} />);

    fireEvent.keyDown(screen.getByLabelText('Search pattern'), {
      key: 'F',
      metaKey: true,
    });

    expect(onModeChange).toHaveBeenCalledWith('aminoAcid');
  });

  it('Cmd+F inside the focused find input switches feature/AA search back to DNA search', () => {
    const onModeChange = vi.fn();
    setNavigatorPlatform('MacIntel');
    render(<FindBar {...defaultProps({ mode: 'aminoAcid', onModeChange })} />);

    fireEvent.keyDown(screen.getByLabelText('Search pattern'), {
      key: 'f',
      metaKey: true,
    });

    expect(onModeChange).toHaveBeenCalledWith('nucleotide');
  });

  it('does not intercept Cmd+Shift+F so global workspace search can own it', () => {
    const onModeChange = vi.fn();
    render(<FindBar {...defaultProps({ mode: 'nucleotide', onModeChange })} />);

    fireEvent.keyDown(screen.getByLabelText('Search pattern'), {
      key: 'f',
      metaKey: true,
      shiftKey: true,
    });

    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('Enter key calls onNext', () => {
    const onNext = vi.fn();
    render(<FindBar {...defaultProps({ onNext })} />);

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNext).toHaveBeenCalled();
  });

  it('Shift+Enter calls onPrev', () => {
    const onPrev = vi.fn();
    render(<FindBar {...defaultProps({ onPrev })} />);

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(onPrev).toHaveBeenCalled();
  });

  it('ArrowDown calls onNext, with or without the AA dropdown visible — arrow keys always preview-navigate', () => {
    const onNext = vi.fn();
    render(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
          onNext,
        })}
      />
    );

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('ArrowUp calls onPrev, with or without the AA dropdown visible', () => {
    const onPrev = vi.fn();
    render(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
          onPrev,
        })}
      />
    );

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('ArrowDown/ArrowUp call onNext/onPrev the same way in nucleotide mode (no dropdown exists there)', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(
      <FindBar
        {...defaultProps({
          query: 'ATG',
          mode: 'nucleotide',
          matchCount: 3,
          onNext,
          onPrev,
        })}
      />
    );

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('keeps the active AA dropdown result in view when activeIndex changes', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const { rerender } = render(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
          activeIndex: 0,
        })}
      />
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();

    rerender(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
          activeIndex: 2,
        })}
      />
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /Feature C/ })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('shows a right arrow for forward-strand results, a left arrow for reverse, a dash for no direction', () => {
    const matches: SearchMatch[] = [
      {
        start: 9,
        end: 20,
        strand: 'forward',
        type: 'annotation',
        label: 'Forward feature',
        annotation: { type: 'CDS', name: 'Forward feature', start: 10, end: 21, direction: 1 },
      },
      {
        start: 99,
        end: 120,
        strand: 'reverse',
        type: 'annotation',
        label: 'Reverse feature',
        annotation: { type: 'CDS', name: 'Reverse feature', start: 100, end: 121, direction: -1 },
      },
      {
        start: 199,
        end: 220,
        strand: 'forward',
        type: 'annotation',
        label: 'Non-directional feature',
        annotation: {
          type: 'misc_feature',
          name: 'Non-directional feature',
          start: 200,
          end: 221,
          direction: 0,
        },
      },
    ];
    render(
      <FindBar
        {...defaultProps({
          query: 'feature',
          mode: 'aminoAcid',
          matchCount: matches.length,
          matches,
        })}
      />
    );

    const rows = screen.getAllByTestId('findbar-aa-result-row');
    expect(rows[0]).toHaveTextContent('10 → 21');
    expect(rows[1]).toHaveTextContent('100 ← 121');
    expect(rows[2]).toHaveTextContent('200 – 221');
    expect(rows[1]).not.toHaveTextContent('100 ← 121 (rev)');
    expect(screen.queryByText(/\(rev\)/)).not.toBeInTheDocument();
  });

  it('shows the source annotation type with identity and legacy fallbacks', () => {
    const matches: SearchMatch[] = [
      {
        start: 9,
        end: 20,
        strand: 'forward',
        type: 'annotation',
        label: 'Transcript hit',
        featureType: 'mRNA',
      },
      {
        start: 29,
        end: 40,
        strand: 'forward',
        type: 'annotation',
        label: 'CDS hit',
        annotation: { type: 'CDS', name: 'CDS hit', start: 30, end: 41 },
      },
      {
        start: 49,
        end: 60,
        strand: 'forward',
        type: 'annotation',
        label: 'Legacy hit',
      },
    ];
    render(
      <FindBar
        {...defaultProps({
          query: 'hit',
          mode: 'aminoAcid',
          matchCount: matches.length,
          matches,
        })}
      />
    );

    const rows = screen.getAllByTestId('findbar-aa-result-row');
    expect(within(rows[0]).getByText('mRNA')).toHaveAttribute('title', 'mRNA');
    expect(within(rows[1]).getByText('CDS')).toHaveAttribute('title', 'CDS');
    expect(within(rows[2]).getByText('Annotation')).toHaveAttribute('title', 'Annotation');
  });

  it('distinguishes the logical hidden track from the raw annotation type', () => {
    const matches: SearchMatch[] = [
      {
        start: 99,
        end: 120,
        strand: 'reverse',
        type: 'annotation',
        label: 'NR_131224.2',
        featureType: 'ncRNA',
        annotationTrackId: 'lnc_RNA',
        annotationTrackVisibility: 'hidden',
      },
    ];
    render(
      <FindBar
        {...defaultProps({
          query: 'NR_131224.2',
          mode: 'aminoAcid',
          matchCount: matches.length,
          matches,
        })}
      />
    );

    const row = screen.getByTestId('findbar-aa-result-row');
    expect(within(row).getByText('ncRNA')).toBeVisible();
    expect(within(row).getByText('lnc_RNA')).toHaveAttribute('title', 'Annotation track: lnc_RNA');
    expect(within(row).getByTestId('findbar-hidden-annotation-badge')).toHaveTextContent('Hidden');
    expect(row).toHaveTextContent('100 ← 121');
  });

  it('shows chromosome-local coordinates while preserving assembly-global navigation coordinates', () => {
    const matches: SearchMatch[] = [
      {
        start: 1_813_906_545,
        end: 1_813_906_568,
        chrom: 'chr11',
        localStart: 5_225_494,
        localEnd: 5_225_517,
        strand: 'forward',
        type: 'protein',
        label: 'chr11 peptide',
      },
    ];
    render(
      <FindBar
        {...defaultProps({
          query: 'MPEPT',
          mode: 'aminoAcid',
          matchCount: matches.length,
          matches,
        })}
      />
    );

    expect(screen.getByTestId('findbar-aa-result-row')).toHaveTextContent(
      'chr11:5225495 → 5225518'
    );
  });

  it('uses the indexed annotation renderer palette for annotation type badges', () => {
    const matches: SearchMatch[] = [
      {
        start: 9,
        end: 20,
        strand: 'forward',
        type: 'annotation',
        label: 'Transcript hit',
        featureType: 'mRNA',
      },
      {
        start: 29,
        end: 40,
        strand: 'forward',
        type: 'annotation',
        label: 'Non-coding hit',
        featureType: 'ncRNA',
      },
    ];
    render(
      <FindBar
        {...defaultProps({
          query: 'hit',
          mode: 'aminoAcid',
          matchCount: matches.length,
          matches,
          resolveAnnotationBadgeStyle: (match) =>
            annotationTypeBadgeStyle(match.featureType ?? 'default', 'light'),
        })}
      />
    );

    const rows = screen.getAllByTestId('findbar-aa-result-row');
    expect(within(rows[0]).getByText('mRNA')).toHaveStyle({ background: '#1D4ED8' });
    expect(within(rows[1]).getByText('ncRNA')).toHaveStyle({ background: '#A855F7' });
  });

  it('renders the direction arrow slightly bolder than the surrounding position digits', () => {
    render(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
        })}
      />
    );

    const row = screen.getAllByTestId('findbar-aa-result-row')[0];
    const glyph = within(row).getByText('→');
    expect(glyph).toHaveStyle({ fontWeight: 700 });
  });

  it('clicking a result row activates it (select + navigate) via onActivateMatch', () => {
    const onActivateMatch = vi.fn();
    render(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
          onActivateMatch,
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Feature B/ }));

    expect(onActivateMatch).toHaveBeenCalledWith(1);
  });

  it('Space always types a literal space character — no special "confirm" meaning (arrow keys already navigate, so there is nothing left for Space to unlock)', () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onActivateMatch = vi.fn();
    render(
      <FindBar
        {...defaultProps({
          query: 'M13',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
          onNext,
          onPrev,
          onActivateMatch,
        })}
      />
    );

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: ' ' });

    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
    expect(onActivateMatch).not.toHaveBeenCalled();
  });

  it('prevents default on row mousedown so the search input keeps focus (real-browser focus-follows-mousedown, not reproducible in jsdom)', () => {
    render(
      <FindBar
        {...defaultProps({
          query: 'Feature',
          mode: 'aminoAcid',
          matchCount: aaMatches.length,
          matches: aaMatches,
        })}
      />
    );

    const row = screen.getByRole('button', { name: /Feature B/ });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    render(<FindBar {...defaultProps({ onClose })} />);

    const input = screen.getByLabelText('Search pattern');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('click close button calls onClose', () => {
    const onClose = vi.fn();
    render(<FindBar {...defaultProps({ onClose })} />);

    fireEvent.click(screen.getByLabelText('Close find bar'));
    expect(onClose).toHaveBeenCalled();
  });

  it('nav buttons are disabled when matchCount is 0', () => {
    render(<FindBar {...defaultProps({ matchCount: 0 })} />);

    expect(screen.getByLabelText('Previous match')).toBeDisabled();
    expect(screen.getByLabelText('Next match')).toBeDisabled();
  });

  it('nav buttons are enabled when matchCount > 0', () => {
    render(<FindBar {...defaultProps({ query: 'ATG', matchCount: 3, activeIndex: 0 })} />);

    expect(screen.getByLabelText('Previous match')).not.toBeDisabled();
    expect(screen.getByLabelText('Next match')).not.toBeDisabled();
  });

  it('shows a Mac double-find cue without changing the search box shape', () => {
    setNavigatorPlatform('MacIntel');
    render(<FindBar {...defaultProps({ query: '' })} />);

    expect(screen.getByText('⌘F again for AA/features')).toBeInTheDocument();
    expect(screen.getByRole('search')).toHaveStyle({ height: '32px', width: '560px' });
    expect(screen.getByLabelText('Search mode: DNA bases')).toHaveAttribute(
      'title',
      'DNA bases search. Click for AA/features (⌘F)'
    );
  });

  it('shows a Mac cue for switching AA search back to DNA search', () => {
    setNavigatorPlatform('MacIntel');
    render(<FindBar {...defaultProps({ mode: 'aminoAcid', query: '' })} />);

    expect(screen.getByText('⌘F again for DNA')).toBeInTheDocument();
    expect(screen.getByRole('search')).toHaveStyle({ height: '32px', width: '560px' });
    expect(screen.getByLabelText('Search mode: AA and features')).toHaveAttribute(
      'title',
      'AA and feature search. Click for DNA bases (⌘F)'
    );
  });

  it('shows Windows/Linux Ctrl+F cues outside Apple platforms', () => {
    setNavigatorPlatform('Win32');
    render(<FindBar {...defaultProps({ query: '' })} />);

    expect(screen.getByText('Ctrl+F again for AA/features')).toBeInTheDocument();
    expect(screen.getByRole('search')).toHaveStyle({ height: '32px', width: '560px' });
  });

  it('reserves enough fixed layout space for the input, mode, status, and close controls', () => {
    render(<FindBar {...defaultProps({ query: '' })} />);

    expect(screen.getByTestId('findbar-shell')).toHaveStyle({
      width: '560px',
      maxWidth: 'calc(100vw - 16px)',
    });
    expect(screen.getByLabelText('Search pattern')).toHaveStyle({
      width: '300px',
      height: '24px',
    });
    expect(screen.getByLabelText('Search mode: DNA bases')).toHaveStyle({ width: '48px' });
    expect(document.querySelector('[aria-live="polite"]')).toHaveStyle({ width: '130px' });
    expect(screen.getByLabelText('Close find bar')).toHaveStyle({ width: '18px' });
  });

  it('keeps the fixed status slot empty for too-short AA queries', () => {
    render(<FindBar {...defaultProps({ mode: 'aminoAcid', query: 'M' })} />);

    expect(screen.getByText('type 2+ chars')).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('');
  });

  it('shows the configured three-character hint for a two-character query', () => {
    render(
      <FindBar
        {...defaultProps({
          mode: 'aminoAcid',
          query: 'HB',
          minQueryLength: 3,
        })}
      />
    );

    expect(screen.getByText('type 3+ chars')).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('');
    expect(screen.queryByText('No matches')).not.toBeInTheDocument();
  });

  it('constrains AA result rows so long labels cannot move the top-right find bar', () => {
    const longLabel = 'very-long-feature-or-protein-name-'.repeat(20);
    render(
      <FindBar
        {...defaultProps({
          mode: 'aminoAcid',
          query: 'kinase',
          matchCount: 1,
          matches: [
            {
              start: 10,
              end: 35,
              strand: 'forward',
              type: 'protein',
              label: longLabel,
            },
          ],
        })}
      />
    );

    expect(screen.getByTestId('findbar-shell')).toHaveStyle({
      width: '560px',
      maxWidth: 'calc(100vw - 16px)',
    });
    expect(screen.getByRole('search')).toHaveStyle({ width: '560px' });
    expect(screen.getByTestId('findbar-aa-dropdown')).toHaveStyle({
      width: '560px',
      maxWidth: '100%',
      overflowX: 'hidden',
    });
    expect(screen.getByTestId('findbar-aa-result-row')).toHaveStyle({
      width: '100%',
      maxWidth: '100%',
      minWidth: '0',
      boxSizing: 'border-box',
    });
    expect(screen.getByText(longLabel)).toHaveStyle({
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
  });

  it('uses the fixed status slot for the search-mode shortcut cue when no query exists', () => {
    render(<FindBar {...defaultProps({ query: '' })} />);

    const polite = document.querySelector('[aria-live="polite"]');
    expect(polite).toHaveTextContent(/again for AA\/features/);
  });
});

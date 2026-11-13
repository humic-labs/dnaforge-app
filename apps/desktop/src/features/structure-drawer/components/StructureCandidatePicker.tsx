import { selectableCardClass } from '../../../components/ui/styles';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Tooltip } from '../../../shared/components/Tooltip';
import { candidateRowsForResolved } from '../api/candidates';
import type {
  ResolverResult,
  StructureCandidate,
  StructureCandidateGroup,
} from '../types/structure-drawer';
import {
  candidateTitle,
  countCandidatesBySource,
  ExternalLinkIcon,
  sourceLinkForCandidate,
  SourceBadge,
  SOURCE_STYLES,
  type CandidateSourceCounts,
} from './structure-candidate-ui';
import { prefetchStructureCandidatePosters } from './structure-candidate-poster';
import { StructureCandidatePosterThumbnail } from './StructureCandidatePosterThumbnail';

export const STRUCTURE_CANDIDATE_HOVER_PREVIEW_DELAY_MS = 300;

interface Props {
  resolved: ResolverResult;
  committedCandidateId: string | null;
  previewCandidateId: string | null;
  expanded: boolean;
  fillAvailable?: boolean;
  onPreview(candidateId: string): void;
  onCommit(candidateId: string): void;
  onCancelPreview(): void;
  onClosePicker(): void;
}

export function StructureCandidatePicker({
  resolved,
  committedCandidateId,
  previewCandidateId,
  expanded,
  fillAvailable = false,
  onPreview,
  onCommit,
  onCancelPreview,
  onClosePicker,
}: Props) {
  const candidates = candidateRowsForResolved(resolved);
  const [activeFilter, setActiveFilter] = useState<HitFilter>('all');
  const [sortMode, setSortMode] = useState<HitSortMode>('best');
  const hoverPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPreviewCandidateRef = useRef<string | null>(null);

  const committed = candidates.find((candidate) => candidate.id === committedCandidateId) ?? null;
  const hasSourceChoice = candidates.length > 1;
  const pickerExpanded = !committed || (expanded && hasSourceChoice);
  const selectedCandidateId = committed?.id ?? null;
  const recommendedCandidateId = resolved.recommendedCandidateId ?? candidates[0]?.id ?? null;
  const counts = countCandidatesBySource(candidates);
  const effectiveFilter = counts[activeFilter] > 0 ? activeFilter : 'all';
  const sortOptions = sortOptionsForCandidates(candidates);
  const effectiveSort = sortOptions.some((option) => option.value === sortMode) ? sortMode : 'best';
  const showSourceFilters = [counts.rcsb, counts.alphafold].filter((count) => count > 0).length > 1;
  const showPickerControls = showSourceFilters || sortOptions.length > 1;
  const visibleCandidates = useMemo(() => {
    const filtered =
      effectiveFilter === 'all'
        ? candidates
        : candidates.filter((candidate) => candidate.group === effectiveFilter);
    return sortCandidates(filtered, effectiveSort);
  }, [candidates, effectiveFilter, effectiveSort]);
  const activePreviewIndex = useMemo(() => {
    const activeCandidateId = previewCandidateId ?? selectedCandidateId ?? recommendedCandidateId;
    return visibleCandidates.findIndex((candidate) => candidate.id === activeCandidateId);
  }, [previewCandidateId, recommendedCandidateId, selectedCandidateId, visibleCandidates]);
  useEffect(() => {
    if (!expanded || visibleCandidates.length === 0) return;
    const center = activePreviewIndex >= 0 ? activePreviewIndex : 0;
    const prefetchCandidates = visibleCandidates.slice(
      Math.max(0, center - 1),
      Math.min(visibleCandidates.length, center + 2)
    );
    prefetchStructureCandidatePosters(prefetchCandidates);
  }, [activePreviewIndex, expanded, visibleCandidates]);
  const cancelHoverPreview = useCallback(() => {
    if (hoverPreviewTimerRef.current !== null) {
      clearTimeout(hoverPreviewTimerRef.current);
      hoverPreviewTimerRef.current = null;
    }
    hoverPreviewCandidateRef.current = null;
  }, []);
  const previewCandidateImmediately = useCallback(
    (candidateId: string) => {
      cancelHoverPreview();
      onPreview(candidateId);
    },
    [cancelHoverPreview, onPreview]
  );
  const scheduleHoverPreview = useCallback(
    (candidateId: string) => {
      cancelHoverPreview();
      hoverPreviewCandidateRef.current = candidateId;
      hoverPreviewTimerRef.current = setTimeout(() => {
        if (hoverPreviewCandidateRef.current !== candidateId) return;
        hoverPreviewTimerRef.current = null;
        hoverPreviewCandidateRef.current = null;
        onPreview(candidateId);
      }, STRUCTURE_CANDIDATE_HOVER_PREVIEW_DELAY_MS);
    },
    [cancelHoverPreview, onPreview]
  );

  useEffect(() => cancelHoverPreview, [cancelHoverPreview]);

  if (candidates.length === 0) return null;
  if (!pickerExpanded) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancelPreview();
      return;
    }

    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[data-ignore-picker-shortcuts="true"]')) {
      return;
    }

    if (!pickerExpanded || visibleCandidates.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const activeCandidateId = previewCandidateId ?? selectedCandidateId ?? recommendedCandidateId;
      const activeIndex = visibleCandidates.findIndex(
        (candidate) => candidate.id === activeCandidateId
      );
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        activeIndex === -1
          ? event.key === 'ArrowDown'
            ? 0
            : visibleCandidates.length - 1
          : (activeIndex + delta + visibleCandidates.length) % visibleCandidates.length;
      previewCandidateImmediately(visibleCandidates[nextIndex].id);
      return;
    }

    if (event.key === 'Enter' && previewCandidateId) {
      event.preventDefault();
      event.stopPropagation();
      onCommit(previewCandidateId);
    }
  };

  return (
    <div
      className={
        fillAvailable
          ? 'flex h-full min-h-0 flex-col bg-bg text-xs'
          : 'border-b border-border bg-bg text-xs'
      }
      data-testid="structure-hit-results"
      aria-label="Structure hit results"
      onKeyDown={handleKeyDown}
    >
      {pickerExpanded && (
        <>
          <div
            data-testid="structure-candidate-picker-instructions"
            className="flex min-w-0 items-center justify-between gap-2 px-3 py-1.5"
          >
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-fg-muted">
                Results
              </span>
              <span className="text-[11px] text-fg-muted">Click to confirm</span>
            </span>
            {(showPickerControls || (committed && hasSourceChoice)) && (
              <span
                data-testid="structure-candidate-picker-controls"
                className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5"
              >
                <SourceFilters
                  counts={counts}
                  activeFilter={effectiveFilter}
                  onChange={setActiveFilter}
                />
                <SortSelect options={sortOptions} value={effectiveSort} onChange={setSortMode} />
                {committed && hasSourceChoice && (
                  <button
                    type="button"
                    data-testid="structure-candidate-toggle"
                    data-ignore-picker-shortcuts="true"
                    aria-expanded="true"
                    className="h-6 rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                    onClick={onClosePicker}
                  >
                    Done
                  </button>
                )}
              </span>
            )}
          </div>

          <div
            data-testid="structure-candidate-list"
            className={
              fillAvailable
                ? 'min-h-0 flex-1 space-y-1.5 overflow-auto px-2.5 pb-2 pt-1'
                : 'max-h-64 space-y-1.5 overflow-auto px-2.5 pb-2 pt-1'
            }
            onScroll={cancelHoverPreview}
            onWheel={cancelHoverPreview}
          >
            <div data-testid="structure-candidate-picker" className="space-y-1.5">
              {visibleCandidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  committed={candidate.id === selectedCandidateId}
                  previewed={candidate.id === previewCandidateId}
                  onHoverPreview={scheduleHoverPreview}
                  onImmediatePreview={previewCandidateImmediately}
                  onCancelHoverPreview={cancelHoverPreview}
                  onCommit={onCommit}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type HitFilter = 'all' | StructureCandidateGroup;

type SourceCounts = CandidateSourceCounts;

type HitSortMode = 'best' | 'resolution' | 'confidence' | 'newest' | 'chains';

interface HitSortOption {
  value: HitSortMode;
  label: string;
}

function SourceFilters({
  counts,
  activeFilter,
  onChange,
}: {
  counts: SourceCounts;
  activeFilter: HitFilter;
  onChange(filter: HitFilter): void;
}) {
  const filters = (
    [
      { filter: 'all', label: 'All' },
      { filter: 'rcsb', label: 'PDB' },
      { filter: 'alphafold', label: 'AlphaFold' },
    ] satisfies Array<{ filter: HitFilter; label: string }>
  ).filter(({ filter }) => filter === 'all' || counts[filter] > 0);

  if ([counts.rcsb, counts.alphafold].filter((count) => count > 0).length < 2) return null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {filters.map(({ filter, label }) => {
        const active = filter === activeFilter;
        const sourceClass =
          filter === 'all'
            ? active
              ? 'border-border bg-bg-muted text-fg'
              : 'border-border text-fg-muted hover:bg-bg-muted hover:text-fg'
            : active
              ? SOURCE_STYLES[filter].filterActive
              : SOURCE_STYLES[filter].filterIdle;
        return (
          <button
            key={filter}
            type="button"
            data-testid={`structure-source-filter-${filter}`}
            data-ignore-picker-shortcuts="true"
            aria-pressed={active}
            className={`rounded border px-2 py-1 text-[11px] ${sourceClass}`}
            onClick={() => onChange(filter)}
          >
            {label} {counts[filter]}
          </button>
        );
      })}
    </div>
  );
}

function SortSelect({
  options,
  value,
  onChange,
}: {
  options: HitSortOption[];
  value: HitSortMode;
  onChange(sortMode: HitSortMode): void;
}) {
  if (options.length <= 1) return null;

  return (
    <select
      data-testid="structure-hit-sort"
      data-ignore-picker-shortcuts="true"
      aria-label="Sort structure hits"
      className="h-6 rounded border border-border bg-bg px-1.5 text-[11px] text-fg-muted hover:bg-bg-muted focus:outline-none focus:ring-1 focus:ring-accent"
      value={value}
      onChange={(event) => onChange(event.target.value as HitSortMode)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function CandidateRow({
  candidate,
  committed,
  previewed,
  onHoverPreview,
  onImmediatePreview,
  onCancelHoverPreview,
  onCommit,
}: {
  candidate: StructureCandidate;
  committed: boolean;
  previewed: boolean;
  onHoverPreview(candidateId: string): void;
  onImmediatePreview(candidateId: string): void;
  onCancelHoverPreview(): void;
  onCommit(candidateId: string): void;
}) {
  const sourceLink = sourceLinkForCandidate(candidate);
  const sourceStyle = SOURCE_STYLES[candidate.group];
  const title = candidateTitle(candidate);
  const badges = candidateBadges(candidate);
  return (
    <div
      data-testid="structure-candidate-row"
      data-candidate-id={candidate.id}
      data-row-height="fixed"
      data-state={committed ? 'committed' : previewed ? 'preview' : 'idle'}
      role="button"
      tabIndex={0}
      aria-label={`Select ${candidate.label}`}
      aria-description={title}
      aria-current={committed ? 'true' : undefined}
      className={selectableCardClass(
        candidate.group === 'rcsb' ? 'blue' : 'emerald',
        committed,
        previewed
      )}
      onMouseEnter={() => onHoverPreview(candidate.id)}
      onMouseLeave={onCancelHoverPreview}
      onFocus={() => onImmediatePreview(candidate.id)}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-ignore-picker-shortcuts="true"]')
        )
          return;
        onCommit(candidate.id);
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          onCommit(candidate.id);
        }
      }}
    >
      <div className={`absolute bottom-0 left-0 top-0 z-10 w-1.5 ${sourceStyle.stripe}`} />
      <div
        data-testid="structure-candidate-row-content"
        className="flex h-full w-full min-w-0 py-0 pl-0 pr-3 text-left"
      >
        <StructureCandidatePosterThumbnail candidate={candidate} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-2 pt-0.5">
          <div className="flex h-5 min-w-0 shrink-0 items-center gap-1">
            <span className="min-w-0" title={candidate.label}>
              <span className="block truncate font-mono text-[12px] text-fg">
                {candidate.label}
              </span>
            </span>
            <span className="flex shrink-0">
              <SourceBadge group={candidate.group} />
            </span>
            {!committed && (
              <span
                data-testid="structure-candidate-select-affordance"
                className="ml-auto inline-flex h-4 shrink-0 items-center rounded-sm bg-accent/10 px-1 text-[9px] font-medium leading-none text-accent"
              >
                Select
              </span>
            )}
          </div>
          <div
            data-testid="structure-candidate-title-row"
            className="flex min-h-5 min-w-0 shrink-0 items-start gap-1"
          >
            <Tooltip content={title} side="bottom" className="min-w-0 flex-1">
              <span
                data-testid="structure-candidate-title"
                className="line-clamp-2 min-w-0 text-[11px] leading-tight text-fg [overflow-wrap:anywhere]"
              >
                {title}
              </span>
            </Tooltip>
            {sourceLink && (
              <Tooltip content={`Open ${candidate.label} source`} side="left" className="shrink-0">
                <a
                  href={sourceLink.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="structure-candidate-source-link"
                  data-ignore-picker-shortcuts="true"
                  className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent ${sourceStyle.link}`}
                  aria-label={`Open ${candidate.label} source`}
                  onMouseEnter={() => onHoverPreview(candidate.id)}
                  onMouseLeave={onCancelHoverPreview}
                  onFocus={() => onImmediatePreview(candidate.id)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <ExternalLinkIcon />
                </a>
              </Tooltip>
            )}
          </div>
          {badges.length > 0 && (
            <div
              data-testid="structure-candidate-metadata"
              data-ignore-picker-shortcuts="true"
              role="region"
              aria-label={`${candidate.label} metadata`}
              tabIndex={0}
              className="mt-auto flex h-6 min-w-0 shrink-0 items-start gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
            >
              {badges.map((badge) => (
                <Badge key={badge}>{badge}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function candidateBadges(candidate: StructureCandidate): string[] {
  const badges: string[] = [];
  if (candidate.provider === 'pdb') {
    if (candidate.metadata.method) badges.push(candidate.metadata.method);
    if (candidate.metadata.resolution !== undefined) {
      badges.push(`${candidate.metadata.resolution.toFixed(2)} Å`);
    }
    const chainCount = candidate.metadata.chainCount ?? candidate.metadata.chainIds?.length;
    if (chainCount !== undefined && chainCount > 0) {
      badges.push(chainCount === 1 ? 'monomer' : `${chainCount} chains`);
    }
    const composition = compositionLabel(candidate.metadata.polymerTypes);
    if (composition) badges.push(composition);
    if (candidate.metadata.initialReleaseDate) {
      badges.push(formatCandidateDateBadge('released', candidate.metadata.initialReleaseDate));
    } else if (candidate.metadata.revisionDate) {
      badges.push(formatCandidateDateBadge('updated', candidate.metadata.revisionDate));
    }
    return badges;
  }

  if (candidate.metadata.meanPlddt !== undefined) {
    badges.push(`pLDDT ${candidate.metadata.meanPlddt.toFixed(1)}`);
  }
  return badges;
}

const CANDIDATE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatCandidateDateBadge(prefix: 'released' | 'updated', rawDate: string): string {
  const timestamp = Date.parse(rawDate);
  if (Number.isFinite(timestamp)) {
    return `${prefix} ${CANDIDATE_DATE_FORMATTER.format(new Date(timestamp))}`;
  }
  return `${prefix} ${rawDate.split(/[T ]/)[0] || rawDate}`;
}

function compositionLabel(polymerTypes: string[] | undefined): string | null {
  if (!polymerTypes?.length) return null;
  const normalized = polymerTypes.map((type) => type.toLowerCase());
  const hasProtein = normalized.some(
    (type) => type.includes('protein') || type.includes('peptide')
  );
  const hasRna = normalized.some((type) => type.includes('ribonucleotide') || type.includes('rna'));
  const hasDna = normalized.some(
    (type) => type.includes('deoxyribonucleotide') || type.includes('dna')
  );
  if (hasProtein && hasRna) return 'RNP';
  if (hasProtein && hasDna) return 'protein-DNA';
  if (hasProtein) return 'protein';
  if (hasRna) return 'RNA';
  if (hasDna) return 'DNA';
  return polymerTypes[0];
}

function sortOptionsForCandidates(candidates: StructureCandidate[]): HitSortOption[] {
  const options: HitSortOption[] = [{ value: 'best', label: 'Best' }];
  if (candidates.some((candidate) => candidate.metadata.resolution !== undefined)) {
    options.push({ value: 'resolution', label: 'Resolution' });
  }
  if (candidates.some((candidate) => candidate.metadata.meanPlddt !== undefined)) {
    options.push({ value: 'confidence', label: 'Confidence' });
  }
  if (candidates.some((candidate) => candidateDateSortValue(candidate) > 0)) {
    options.push({ value: 'newest', label: 'Newest' });
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.metadata.chainCount !== undefined || candidate.metadata.chainIds?.length
    )
  ) {
    options.push({ value: 'chains', label: 'Chains' });
  }
  return options;
}

function sortCandidates(
  candidates: readonly StructureCandidate[],
  sortMode: HitSortMode
): StructureCandidate[] {
  return [...candidates].sort((left, right) => {
    const fallback = left.rank - right.rank || left.label.localeCompare(right.label);

    switch (sortMode) {
      case 'resolution':
        return (
          numberSortValue(left.metadata.resolution, 'asc') -
            numberSortValue(right.metadata.resolution, 'asc') || fallback
        );
      case 'confidence':
        return (
          numberSortValue(right.metadata.meanPlddt, 'desc') -
            numberSortValue(left.metadata.meanPlddt, 'desc') || fallback
        );
      case 'newest':
        return candidateDateSortValue(right) - candidateDateSortValue(left) || fallback;
      case 'chains':
        return candidateChainCount(right) - candidateChainCount(left) || fallback;
      case 'best':
      default:
        return fallback;
    }
  });
}

function numberSortValue(value: number | undefined, direction: 'asc' | 'desc'): number {
  if (value === undefined || !Number.isFinite(value)) {
    return direction === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }
  return value;
}

function candidateChainCount(candidate: StructureCandidate): number {
  return candidate.metadata.chainCount ?? candidate.metadata.chainIds?.length ?? -1;
}

function candidateDateSortValue(candidate: StructureCandidate): number {
  const rawDate =
    candidate.metadata.revisionDate ??
    candidate.metadata.initialReleaseDate ??
    candidate.metadata.depositionDate;
  if (!rawDate) return 0;
  const timestamp = Date.parse(rawDate);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function Badge({ children }: { children: string }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center whitespace-nowrap rounded-sm border border-border px-1 text-[9px] uppercase leading-none text-fg-muted">
      {children}
    </span>
  );
}

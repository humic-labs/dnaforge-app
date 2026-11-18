import { MenuNativeSelect } from '@waypoint/ui-components';
import {
  type UserMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
  renderUserMessage,
  toUserMessage,
} from '@waypoint/user-messages';

import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { PrimerSearchResult, BindingHit } from '../primer-search-service';
import type { Primer } from '../types';
import { LIBRARY_PRIMER_COLOR } from '../types';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import { trackToolError } from '../../../lib/analytics';
import { HostedSignUpRequiredError, requestHostedKeepWork } from '../../../hosted/capabilities';

type RegionMode = 'entire' | 'custom' | 'selection';

export interface PrimerAutoScopeRequest {
  nonce: number;
  region: { start: number; end: number } | null;
}

interface SearchConstraints {
  regionStart?: number;
  regionEnd?: number;
  maxEditDistance?: number;
  minMatchLength?: number;
  minEffectiveTm?: number;
  maxMismatches?: number;
}

interface PrimerSearchPanelProps {
  results: PrimerSearchResult[];
  isSearching: boolean;
  onSearch: (constraints: SearchConstraints) => void;
  onAttach: (primer: Primer, hit: BindingHit) => Promise<void>;
  onResultClick?: (hit: BindingHit) => void;
  onCandidatePreview?: (preview: PrimerDisplay | null) => void;
  sequenceLength: number;
  selectionRange: { start: number; end: number } | null;
  autoScope?: PrimerAutoScopeRequest | null;
  libraryEmpty?: boolean;
  onAutoScopeConsumed?: () => void;
  searchError?: Error | null;
  scopeControl?: ReactNode;
  searchDisabledReason?: UserMessage | null;
  formatHitRange?: (hit: BindingHit) => string;
}

export function PrimerSearchPanel({
  results,
  isSearching,
  onSearch,
  onAttach,
  onResultClick,
  onCandidatePreview,
  sequenceLength,
  selectionRange,
  autoScope,
  libraryEmpty = false,
  onAutoScopeConsumed,
  searchError,
  scopeControl,
  searchDisabledReason = null,
  formatHitRange,
}: PrimerSearchPanelProps) {
  const [regionMode, setRegionMode] = useState<RegionMode>('entire');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [textFilter, setTextFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'forward' | 'reverse'>('all');
  const [attaching, setAttaching] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const signUpLabel =
    searchError instanceof HostedSignUpRequiredError ? searchError.guidance : null;
  const [minMatchLength, setMinMatchLength] = useState('15');
  const [minEffectiveTm, setMinEffectiveTm] = useState('50');
  const [maxMismatches, setMaxMismatches] = useState('3');
  const [hasSearched, setHasSearched] = useState(false);

  const buildConstraints = useCallback(
    (mode: RegionMode): SearchConstraints => {
      const parsedMaxMismatches = parseInt(maxMismatches, 10);
      const constraints: SearchConstraints = {
        minMatchLength: parseInt(minMatchLength, 10) || 0,
        minEffectiveTm: parseFloat(minEffectiveTm) || 0,
        maxMismatches: Number.isNaN(parsedMaxMismatches) ? 10 : parsedMaxMismatches,
      };

      if (scopeControl) return constraints;
      if (mode === 'custom' && customStart && customEnd) {
        constraints.regionStart = parseInt(customStart, 10);
        constraints.regionEnd = parseInt(customEnd, 10);
      } else if (mode === 'selection' && selectionRange) {
        constraints.regionStart = selectionRange.start;
        constraints.regionEnd = selectionRange.end;
      }

      return constraints;
    },
    [
      customStart,
      customEnd,
      selectionRange,
      minMatchLength,
      minEffectiveTm,
      maxMismatches,
      scopeControl,
    ]
  );

  const handleSearch = useCallback(() => {
    setHasSearched(true);
    onSearch(buildConstraints(regionMode));
  }, [onSearch, buildConstraints, regionMode]);

  const lastAutoScopeNonce = useRef(0);
  useEffect(() => {
    if (!autoScope || autoScope.nonce === lastAutoScopeNonce.current) return;
    lastAutoScopeNonce.current = autoScope.nonce;
    if (autoScope.region) {
      setRegionMode('custom');
      setCustomStart(String(autoScope.region.start));
      setCustomEnd(String(autoScope.region.end));
    } else {
      setRegionMode('entire');
    }
    onAutoScopeConsumed?.();
  }, [autoScope, onAutoScopeConsumed]);

  const handleAttach = useCallback(
    async (primer: Primer, hit: BindingHit) => {
      setAttachError(null);
      setAttaching(primer.id);
      try {
        await onAttach(primer, hit);
      } catch (error) {
        setAttachError(
          userMessageWithValues('primer.attachFailed', {
            name: userMessageValue(userEntityLabel(primer.name)),
          })
        );
        trackToolError('primers', 'sidebar', 'write_failed');
      } finally {
        setAttaching(null);
      }
    },
    [onAttach]
  );

  const filteredResults = useMemo(() => {
    let filtered = results;

    if (textFilter) {
      const lower = textFilter.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.primer.name.toLowerCase().includes(lower) ||
          r.primer.sequence.toLowerCase().includes(lower)
      );
    }

    if (directionFilter !== 'all') {
      filtered = filtered.filter((r) => {
        if (!r.bestHit) return false;
        return directionFilter === 'forward' ? r.bestHit.strand === 1 : r.bestHit.strand === -1;
      });
    }

    return filtered;
  }, [results, textFilter, directionFilter]);

  return (
    <div
      className="flex flex-col gap-2 p-3"
      data-testid="primer-search-panel"
      data-has-searched={hasSearched ? 'true' : 'false'}
    >
      {scopeControl ?? (
        <div className="flex items-center gap-2">
          <span className="inline-block min-w-0">
            <MenuNativeSelect
              density="compact"
              data-testid="region-mode-select"
              value={regionMode}
              onChange={(e) => setRegionMode(e.target.value as RegionMode)}
            >
              <option value="entire">Entire sequence</option>
              <option value="custom">Custom region</option>
              {selectionRange && <option value="selection">Use selection</option>}
            </MenuNativeSelect>
          </span>

          {regionMode === 'custom' && (
            <>
              <input
                data-testid="region-start-input"
                type="number"
                placeholder="Start"
                className="text-xs px-2 py-1 w-16 rounded border border-border bg-bg text-fg"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                min={0}
                max={sequenceLength}
              />
              <span className="text-xs text-fg-muted">–</span>
              <input
                data-testid="region-end-input"
                type="number"
                placeholder="End"
                className="text-xs px-2 py-1 w-16 rounded border border-border bg-bg text-fg"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                min={0}
                max={sequenceLength}
              />
            </>
          )}

          {regionMode === 'selection' && selectionRange && (
            <span data-testid="region-selection-range" className="text-xs text-fg-muted">
              {selectionRange.start}–{selectionRange.end}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-[10px] text-fg-muted whitespace-nowrap">{"3' match"}</label>
        <input
          data-testid="min-match-length"
          type="number"
          className="text-xs px-1.5 py-0.5 w-12 rounded border border-border bg-bg text-fg"
          value={minMatchLength}
          onChange={(e) => setMinMatchLength(e.target.value)}
          min={0}
          max={30}
          title="Min 3' contiguous match (nt)"
        />
        <label className="text-[10px] text-fg-muted">nt</label>
        <label className="text-[10px] text-fg-muted whitespace-nowrap ml-1">Tm ≥</label>
        <input
          data-testid="min-effective-tm"
          type="number"
          className="text-xs px-1.5 py-0.5 w-12 rounded border border-border bg-bg text-fg"
          value={minEffectiveTm}
          onChange={(e) => setMinEffectiveTm(e.target.value)}
          min={0}
          max={80}
          title="Min effective Tm (°C)"
        />
        <label className="text-[10px] text-fg-muted">°C</label>
        <label className="text-[10px] text-fg-muted whitespace-nowrap ml-1">MM ≤</label>
        <input
          data-testid="max-mismatches"
          type="number"
          className="text-xs px-1.5 py-0.5 w-10 rounded border border-border bg-bg text-fg"
          value={maxMismatches}
          onChange={(e) => setMaxMismatches(e.target.value)}
          min={0}
          max={10}
          title="Max total mismatches"
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          data-testid="search-text-filter"
          type="text"
          placeholder="Filter by name..."
          className="text-xs px-2 py-1 flex-1 rounded border border-border bg-bg text-fg"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
        />
        <span className="inline-block min-w-0">
          <MenuNativeSelect
            density="compact"
            data-testid="direction-filter"
            value={directionFilter}
            onChange={(e) => setDirectionFilter(e.target.value as 'all' | 'forward' | 'reverse')}
          >
            <option value="all">Both</option>
            <option value="forward">Forward</option>
            <option value="reverse">Reverse</option>
          </MenuNativeSelect>
        </span>
        <button
          data-testid="primer-search-button"
          className="text-xs px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
          onClick={handleSearch}
          disabled={isSearching || Boolean(searchDisabledReason)}
          title={searchDisabledReason != null ? searchDisabledReason : undefined}
        >
          {isSearching ? 'Searching...' : 'Find Primers'}
        </button>
      </div>

      {searchDisabledReason && !isSearching && (
        <div data-testid="primer-search-disabled-reason" className="text-[11px] text-fg-muted">
          {searchDisabledReason}
        </div>
      )}

      {isSearching && (
        <div className="py-6 text-center text-xs text-fg-muted">
          Searching library against sequence...
        </div>
      )}

      {!isSearching && searchError && !signUpLabel && (
        <div data-testid="primer-search-error" className="py-6 px-3 text-center text-xs">
          <div className="mb-1 text-fg">Couldn’t reach the primer matcher</div>
          <div className="text-fg-muted/70 mb-2">{toUserMessage(searchError, 'primer.failed')}</div>
          <button
            data-testid="primer-search-retry"
            className="text-xs px-3 py-1 rounded border border-border text-fg-muted wp-interactive "
            onClick={handleSearch}
          >
            Retry
          </button>
        </div>
      )}

      {!isSearching && signUpLabel && (
        <div data-testid="primer-search-sign-up" className="py-6 px-3 text-center text-xs">
          <div className="mb-2 text-fg">{renderUserMessage(signUpLabel)}</div>
          <button
            data-testid="primer-search-sign-up-open"
            className="text-xs px-3 py-1 rounded border border-border text-fg-muted wp-interactive "
            onClick={() => requestHostedKeepWork(signUpLabel)}
          >
            Sign up
          </button>
        </div>
      )}

      {!isSearching && attachError && (
        <div
          data-testid="primer-attach-error"
          role="alert"
          aria-live="assertive"
          className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          {toUserMessage(attachError, 'primer.failed')}
        </div>
      )}

      {!isSearching && results.length > 0 && (
        <div className="text-xs text-fg-muted mb-1">
          {filteredResults.length} result{filteredResults.length !== 1 ? 's' : ''}
          {textFilter && ` matching "${textFilter}"`}
        </div>
      )}

      {!isSearching && filteredResults.length > 0 && (
        <div>
          {filteredResults.map((result) => (
            <div
              key={result.primer.id}
              className="flex items-center gap-2 px-3 py-1.5 border-b border-border last:border-b-0 cursor-pointer wp-interactive"
              onClick={() => {
                if (result.bestHit) {
                  onResultClick?.(result.bestHit);
                  onCandidatePreview?.({
                    id: `__candidate_${result.primer.id}__`,
                    name: result.primer.name,
                    bases: result.primer.sequence,
                    start: result.bestHit.start,
                    end: result.bestHit.end,
                    direction: result.bestHit.strand === 1 ? 'forward' : 'reverse',
                    tm: result.primer.tm ?? 0,
                    gc: result.primer.gcPercent,
                    mismatches: undefined,
                    overhangLength: 0,
                    pbsColor: LIBRARY_PRIMER_COLOR,
                    isCandidate: true,
                  });
                }
              }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-fg truncate">{result.primer.name}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-fg-muted">
                  <span>{result.bestHit?.strand === 1 ? '→' : '←'}</span>
                  <span>
                    {result.bestHit && formatHitRange
                      ? formatHitRange(result.bestHit)
                      : `${result.bestHit?.start}–${result.bestHit?.end}`}
                  </span>
                  <span>
                    {result.bestHit?.effectiveTm
                      ? `${result.bestHit.effectiveTm.toFixed(1)}°C`
                      : `${Math.round((result.bestHit?.identity ?? 0) * 100)}%`}
                  </span>
                  <span>
                    {result.bestHit?.threePrimeMatchLength
                      ? `3'=${result.bestHit.threePrimeMatchLength}nt`
                      : `${result.primer.length}bp`}
                  </span>
                  {(result.bestHit?.editDistance ?? 0) > 0 && (
                    <span className="text-yellow-400">{result.bestHit?.editDistance}mm</span>
                  )}
                </div>
              </div>

              {result.isAttached ? (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg-muted/10 text-fg-muted/40 shrink-0">
                  ✓
                </span>
              ) : result.bestHit ? (
                <button
                  data-testid={`search-attach-${result.primer.id}`}
                  className="text-[10px] px-2 py-0.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 shrink-0"
                  onClick={() => result.bestHit && handleAttach(result.primer, result.bestHit)}
                  disabled={attaching === result.primer.id}
                >
                  {attaching === result.primer.id ? '...' : 'Attach'}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {!isSearching && results.length > 0 && filteredResults.length === 0 && (
        <div className="py-4 text-center text-xs text-fg-muted">No results match your filters</div>
      )}

      {!isSearching && !searchError && hasSearched && results.length === 0 && (
        <div data-testid="primer-search-empty" className="py-6 px-3 text-center text-xs">
          {libraryEmpty ? (
            <>
              <div className="mb-1 text-fg">No primers in your library yet</div>
              <div className="text-fg-muted/70">
                Import primers to find matches on this sequence.
              </div>
            </>
          ) : (
            <span className="text-fg-muted">No library primers bind in this region.</span>
          )}
        </div>
      )}
    </div>
  );
}

import { type UserMessage, withUserMessage } from '@waypoint/user-messages';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PRIMER_COLOR, type Primer as RendererPrimer } from '@waypoint/genome-renderer';
import type { PrimerDisplay } from '@waypoint/workspace-editor';

import type { PrimerAutoScopeRequest } from '../../primers/public/components/PrimerSearchPanel';
import type { BindingHit, PrimerSearchResult } from '../../primers/public/primer-search-service';
import { primerServices } from '../../primers/public/primer-services';
import type { Primer } from '../../primers/public/types';
import type { IndexedGenomePrimerBinding } from '../../../shared/indexed-genome';
import { candidatePrimerDisplaysFromSearch } from '../candidate-primer-displays';
import type { IndexedChromosomeSpan } from './indexed-cut-site-window';
import { formatIndexedScanWindow } from './indexed-cut-site-window';
import {
  resolveIndexedPrimerFindWindow,
  type IndexedPrimerFindScopeMode,
  type IndexedPrimerFindWindow,
} from './indexed-primer-find-scope';

interface FindConstraints {
  regionStart?: number;
  regionEnd?: number;
  maxEditDistance?: number;
  minMatchLength?: number;
  minEffectiveTm?: number;
  maxMismatches?: number;
}

interface SearchedWindow {
  readonly window: IndexedPrimerFindWindow;
  readonly results: PrimerSearchResult[];
}

export interface IndexedPrimerFind {
  drawerProps: {
    searchResults: PrimerSearchResult[];
    isSearching: boolean;
    searchError: Error | null;
    libraryEmpty: boolean;
    onSearch: (constraints: FindConstraints) => void;
    onAttach: (primer: Primer, hit: BindingHit) => Promise<void>;
    onSearchResultClick: (hit: { start: number; end: number }) => void;
    onCandidatePreview: (preview: PrimerDisplay | null) => void;
    autoScope: PrimerAutoScopeRequest | null;
    onAutoScopeConsumed: () => void;
    searchScopeControl: ReactNode;
    searchDisabledReason: UserMessage | null;
    formatSearchHitRange: (hit: BindingHit) => string;
  };
  candidatePreview: Omit<RendererPrimer, 'renderId'> | null;
  openFind: (selection: IndexedPrimerFindWindow | null) => void;
}

export function useIndexedPrimerFind({
  scopeKey,
  bindings,
  persistBindings,
  chromosomes,
  chromGlobalStart,
  viewport,
  selection,
  readSequence,
  onRevealRange,
}: {
  scopeKey: string;
  bindings: readonly IndexedGenomePrimerBinding[];
  persistBindings: (
    updater: (
      previous: readonly IndexedGenomePrimerBinding[]
    ) => readonly IndexedGenomePrimerBinding[]
  ) => void;
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>;
  chromGlobalStart: ReadonlyMap<string, number>;
  viewport: Readonly<{ start: number; end: number }> | null;
  selection: IndexedPrimerFindWindow | null;
  readSequence: (chrom: string, start0: number, end0: number) => Promise<string>;
  onRevealRange: (start: number, end: number) => void;
}): IndexedPrimerFind {
  const [mode, setMode] = useState<IndexedPrimerFindScopeMode>('visible');
  const [intervalText, setIntervalText] = useState('');
  const [searched, setSearched] = useState<SearchedWindow | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<Error | null>(null);
  const [libraryEmpty, setLibraryEmpty] = useState(false);
  const [candidatePreview, setCandidatePreview] = useState<Omit<RendererPrimer, 'renderId'> | null>(
    null
  );
  const [autoScope, setAutoScope] = useState<PrimerAutoScopeRequest | null>(null);
  const autoScopeNonce = useRef(0);
  const generation = useRef(0);
  const waitController = useRef<AbortController | null>(null);
  const searchedRef = useRef(searched);
  searchedRef.current = searched;

  const resolution = useMemo(
    () => resolveIndexedPrimerFindWindow({ mode, viewport, selection, intervalText, chromosomes }),
    [chromosomes, intervalText, mode, selection, viewport]
  );

  useEffect(() => {
    generation.current += 1;
    waitController.current?.abort();
    waitController.current = null;
    setSearched(null);
    setSearchError(null);
    setLibraryEmpty(false);
    setIsSearching(false);
    setCandidatePreview(null);
  }, [scopeKey]);
  useEffect(() => () => waitController.current?.abort(), []);

  const onSearch = useCallback(
    (constraints: FindConstraints) => {
      const window = resolution.window;
      if (!window) return;
      waitController.current?.abort();
      const controller = new AbortController();
      waitController.current = controller;
      const current = ++generation.current;
      setIsSearching(true);
      setSearched(null);
      setSearchError(null);
      setLibraryEmpty(false);
      setCandidatePreview(null);
      void (async () => {
        try {
          const bases = (
            await readSequence(window.chrom, window.start0, window.end0)
          ).toUpperCase();
          if (current !== generation.current) return;
          if (bases.length !== window.end0 - window.start0) {
            throw new Error(
              `Could not read ${formatIndexedScanWindow(window)} from the reference.`
            );
          }
          const found = await primerServices.bindingSearch.findLibraryOnTarget({
            targetDocumentId: `indexed-reference:${scopeKey}:${window.chrom}:${window.start0}-${window.end0}`,
            referenceSequence: bases,
            circular: false,
            maxEditDistance: constraints.maxEditDistance,
            minMatchLength: constraints.minMatchLength,
            minEffectiveTm: constraints.minEffectiveTm,
            maxMismatches: constraints.maxMismatches,
            signal: controller.signal,
            loadAttachedBindingIds: async () => new Map(),
          });
          if (current !== generation.current) return;
          setSearched({ window, results: found.map((result) => shiftResult(result, window)) });
          if (found.length === 0) {
            const library = await primerServices.persistence
              .searchLegacyPrimers({ limit: 1 })
              .catch(() => null);
            if (current === generation.current && library) setLibraryEmpty(library.length === 0);
          }
        } catch (error) {
          if (current !== generation.current) return;
          setSearchError(
            error instanceof Error
              ? error
              : withUserMessage(new Error('Primer search failed.'), 'failure.primer-search-failed')
          );
        } finally {
          if (current === generation.current) {
            if (waitController.current === controller) waitController.current = null;
            setIsSearching(false);
          }
        }
      })();
    },
    [readSequence, resolution.window, scopeKey]
  );

  const searchResults = useMemo(() => {
    if (!searched) return [];
    return searched.results.map((result) => {
      const existing = result.bestHit
        ? bindings.find((binding) =>
            sameSite(binding, result.primer.id, searched.window.chrom, result.bestHit!)
          )
        : undefined;
      return existing
        ? { ...result, isAttached: true, existingBindingId: existing.id }
        : { ...result, isAttached: false, existingBindingId: undefined };
    });
  }, [bindings, searched]);

  const onAttach = useCallback(
    async (primer: Primer, hit: BindingHit) => {
      const current = searchedRef.current;
      if (!current) throw new Error('Run the search again before attaching.');
      const { window } = current;
      if (
        !Number.isSafeInteger(hit.start) ||
        !Number.isSafeInteger(hit.end) ||
        hit.start < window.start0 ||
        hit.end > window.end0 ||
        hit.end <= hit.start ||
        (hit.strand !== 1 && hit.strand !== -1)
      ) {
        throw new Error('This match is outside the searched region. Search again.');
      }
      if (!primer.sequence) throw new Error(`${primer.name} has no bases to attach.`);
      const binding: IndexedGenomePrimerBinding = {
        id: crypto.randomUUID(),
        primerId: primer.id,
        primerName: primer.name,
        primerBases: primer.sequence,
        chrom: window.chrom,
        start0: hit.start,
        end0: hit.end,
        strand: hit.strand === 1 ? '+' : '-',
        source: 'attached',
      };
      persistBindings((previous) =>
        previous.some((existing) => sameSite(existing, primer.id, window.chrom, hit))
          ? previous
          : [...previous, binding]
      );
      setCandidatePreview(null);
    },
    [persistBindings]
  );

  const toGlobal = useCallback(
    (start: number, end: number) => {
      const chrom = searchedRef.current?.window.chrom;
      const offset = chrom === undefined ? undefined : chromGlobalStart.get(chrom);
      return offset === undefined ? null : { start: offset + start, end: offset + end };
    },
    [chromGlobalStart]
  );

  const onSearchResultClick = useCallback(
    (hit: { start: number; end: number }) => {
      const range = toGlobal(hit.start, hit.end);
      if (range) onRevealRange(range.start, range.end);
    },
    [onRevealRange, toGlobal]
  );

  const onCandidatePreview = useCallback(
    (preview: PrimerDisplay | null) => {
      const range = preview ? toGlobal(preview.start, preview.end) : null;
      setCandidatePreview(
        preview && range
          ? {
              id: preview.id,
              name: preview.name,
              start: range.start,
              end: range.end,
              direction: preview.direction,
              color: PRIMER_COLOR,
              bases: preview.bases,
              isCandidate: true,
            }
          : null
      );
    },
    [toGlobal]
  );

  const formatSearchHitRange = useCallback(
    (hit: BindingHit) =>
      formatIndexedScanWindow({
        chrom: searchedRef.current?.window.chrom ?? '',
        start0: hit.start,
        end0: hit.end,
      }),
    []
  );

  const openFind = useCallback((target: IndexedPrimerFindWindow | null) => {
    setMode(target ? 'selection' : 'visible');
    autoScopeNonce.current += 1;
    setAutoScope({ nonce: autoScopeNonce.current, region: null });
  }, []);
  const onAutoScopeConsumed = useCallback(() => setAutoScope(null), []);

  const searchScopeControl = useMemo(
    () => (
      <div className="flex flex-col gap-1" data-testid="indexed-primer-find-scope">
        <div className="flex items-center gap-2">
          <select
            data-testid="indexed-primer-find-mode"
            className="text-xs px-2 py-1 rounded border border-border bg-bg text-fg"
            value={mode}
            onChange={(event) => setMode(event.target.value as IndexedPrimerFindScopeMode)}
          >
            <option value="visible">Visible region</option>
            <option value="selection">Selection</option>
            <option value="interval">Interval</option>
          </select>
          {mode === 'interval' && (
            <input
              data-testid="indexed-primer-find-interval"
              type="text"
              placeholder="chr1:1,000-2,000"
              spellCheck={false}
              className="min-w-0 flex-1 text-xs px-2 py-1 rounded border border-border bg-bg text-fg"
              value={intervalText}
              onChange={(event) => setIntervalText(event.target.value)}
            />
          )}
        </div>
        {resolution.window && (
          <div data-testid="indexed-primer-find-window" className="text-[11px] text-fg-muted">
            Searches {formatIndexedScanWindow(resolution.window)} (
            {(resolution.window.end0 - resolution.window.start0).toLocaleString()} bp)
          </div>
        )}
      </div>
    ),
    [mode, intervalText, resolution.window]
  );

  const drawerProps = useMemo(
    () => ({
      searchResults,
      isSearching,
      searchError,
      libraryEmpty,
      onSearch,
      onAttach,
      onSearchResultClick,
      onCandidatePreview,
      autoScope,
      onAutoScopeConsumed,
      searchScopeControl,
      searchDisabledReason: resolution.disabledReason,
      formatSearchHitRange,
    }),
    [
      autoScope,
      formatSearchHitRange,
      isSearching,
      libraryEmpty,
      onAttach,
      onAutoScopeConsumed,
      onCandidatePreview,
      onSearch,
      onSearchResultClick,
      resolution.disabledReason,
      searchError,
      searchResults,
      searchScopeControl,
    ]
  );

  const shownCandidatePreview = useMemo(() => {
    if (!candidatePreview) return null;
    const showable = candidatePrimerDisplaysFromSearch(searchResults);
    return showable.some((display) => display.id === candidatePreview.id) ? candidatePreview : null;
  }, [candidatePreview, searchResults]);

  return {
    drawerProps,
    candidatePreview: shownCandidatePreview,
    openFind,
  };
}

function shiftHit(hit: BindingHit, start0: number): BindingHit {
  return { ...hit, start: hit.start + start0, end: hit.end + start0 };
}

function shiftResult(
  result: PrimerSearchResult,
  window: IndexedPrimerFindWindow
): PrimerSearchResult {
  return {
    ...result,
    hits: result.hits.map((hit) => shiftHit(hit, window.start0)),
    bestHit: result.bestHit ? shiftHit(result.bestHit, window.start0) : null,
  };
}

function sameSite(
  binding: IndexedGenomePrimerBinding,
  primerId: string,
  chrom: string,
  hit: Pick<BindingHit, 'start' | 'end' | 'strand'>
): boolean {
  return (
    binding.primerId === primerId &&
    binding.chrom === chrom &&
    binding.start0 === hit.start &&
    binding.end0 === hit.end &&
    binding.strand === (hit.strand === 1 ? '+' : '-')
  );
}

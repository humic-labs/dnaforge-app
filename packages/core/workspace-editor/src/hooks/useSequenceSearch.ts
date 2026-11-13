import { userMessage, type UserMessage } from '@waypoint/user-messages';
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import {
  searchNucleotide,
  searchAnnotationsAndProtein,
  expandIUPACToRegex,
  estimateNucleotideSearchMatchCount,
  SearchTooBroadError,
  type SearchMatch,
  type GeneticCodeSpec,
  type RecordGeneticCodeBasis,
  type NucleicAcid,
} from '@waypoint/sequence-utils';

export type SearchMode = 'nucleotide' | 'aminoAcid';

export interface SequenceSearchNavigationObservation {
  readonly consumed: boolean;
  presented: (surface?: 'sequence_canvas' | 'sequence_tracks') => boolean;
  cancel: () => boolean;
}

export interface SequenceSearchNavigation {
  readonly position: number;
  readonly range: { start: number; end: number; wraps?: boolean };
  observe: () => SequenceSearchNavigationObservation | undefined;
}

export interface UseSequenceSearchParams {
  sequence: string;

  annotations: Annotation[];
  sequenceGeneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: RecordGeneticCodeBasis;
  nucleicAcid?: NucleicAcid;

  circular?: boolean;
  onSearchStart?: (input: {
    mode: SearchMode;
    queryLength: number;
    sequenceLength: number;
    circular: boolean;
  }) => {
    readonly consumed: boolean;
    complete: (matchCount: number) => boolean;
    fail: (reason: 'invalid_pattern' | 'too_broad') => boolean;
    cancel: (
      reason: 'superseded' | 'mode_changed' | 'source_changed' | 'closed' | 'unmounted'
    ) => boolean;
    beginNavigation?: () => SequenceSearchNavigationObservation | undefined;
  };
}

export interface UseSequenceSearchReturn {
  isOpen: boolean;

  query: string;

  mode: SearchMode;

  matches: SearchMatch[];

  activeIndex: number;

  matchCount: number;

  isActiveReverse: boolean;

  isError: boolean;

  errorMessage: UserMessage | null;

  openInMode: (mode: SearchMode) => void;

  close: () => void;

  setQuery: (q: string) => void;

  setMode: (mode: SearchMode) => void;

  next: () => void;

  prev: () => void;

  scrollToPosition: number | null;

  navigationRequest: SequenceSearchNavigation | null;

  activeHighlightRange: { start: number; end: number; wraps?: boolean } | null;

  goToMatch: (index: number) => void;

  releaseActiveHighlight: () => void;
}

const DEBOUNCE_MS = 150;

const MIN_QUERY_LENGTH = 2;
const MAX_RENDERABLE_SEARCH_MATCHES = 50_000;

interface RunSequenceSearchParams {
  sequence: string;
  annotations: Annotation[];
  sequenceGeneticCode?: GeneticCodeSpec;
  geneticCodeBasis?: RecordGeneticCodeBasis;
  nucleicAcid?: NucleicAcid;
  circular: boolean;
  query: string;
  mode: SearchMode;
}

export function runSequenceSearchForMode({
  sequence,
  annotations,
  sequenceGeneticCode,
  geneticCodeBasis,
  nucleicAcid,
  circular,
  query,
  mode,
}: RunSequenceSearchParams): SearchMatch[] {
  if (mode === 'nucleotide') {
    const nucleotideOptions = {
      circular,
      reverseComplement: true,
    };

    expandIUPACToRegex(query);
    const estimatedMatches = estimateNucleotideSearchMatchCount(
      sequence.length,
      query,
      nucleotideOptions
    );
    if (estimatedMatches > MAX_RENDERABLE_SEARCH_MATCHES) {
      throw new SearchTooBroadError(MAX_RENDERABLE_SEARCH_MATCHES);
    }
    return searchNucleotide(sequence, query, {
      ...nucleotideOptions,
      maxMatches: MAX_RENDERABLE_SEARCH_MATCHES,
    });
  }

  return searchAnnotationsAndProtein(annotations, sequence, query, {
    sequenceGeneticCode,
    geneticCodeBasis,
    nucleicAcid,
  });
}

function sequenceSearchErrorMessage(err: unknown): UserMessage {
  return userMessage(
    err instanceof SearchTooBroadError
      ? 'sequenceSearch.tooManyMatches'
      : 'sequenceSearch.invalidPattern'
  );
}

export function useSequenceSearch({
  sequence,
  annotations,
  sequenceGeneticCode,
  geneticCodeBasis,
  nucleicAcid,
  circular = false,
  onSearchStart,
}: UseSequenceSearchParams): UseSequenceSearchReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [mode, setModeState] = useState<SearchMode>('nucleotide');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<UserMessage | null>(null);

  const [released, setReleased] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  type Observation = ReturnType<NonNullable<UseSequenceSearchParams['onSearchStart']>>;
  const observationRef = useRef<Observation | null>(null);
  const [navigationRequest, setNavigationRequest] = useState<SequenceSearchNavigation | null>(null);
  const sourceRef = useRef({
    sequence,
    annotations,
    circular,
    sequenceGeneticCode,
    geneticCodeBasis,
    nucleicAcid,
  });
  sourceRef.current = {
    sequence,
    annotations,
    circular,
    sequenceGeneticCode,
    geneticCodeBasis,
    nucleicAcid,
  };
  type ResultOwner = {
    source: typeof sourceRef.current;
    matches: SearchMatch[];
    index: number;
    observation: Observation | null;
  };
  const resultOwnerRef = useRef<ResultOwner | null>(null);
  const navigationRef = useRef<{
    request: SequenceSearchNavigation;
    observation?: SequenceSearchNavigationObservation;
    observed: boolean;
  } | null>(null);
  const retireNavigation = useCallback(() => {
    const pending = navigationRef.current;
    navigationRef.current = null;
    pending?.observation?.cancel();
  }, []);
  const publishNavigation = useCallback(
    (owner: ResultOwner, index: number) => {
      const isCurrent = () =>
        resultOwnerRef.current === owner &&
        owner.source.sequence === sourceRef.current.sequence &&
        owner.source.annotations === sourceRef.current.annotations &&
        owner.source.circular === sourceRef.current.circular &&
        owner.source.sequenceGeneticCode === sourceRef.current.sequenceGeneticCode &&
        owner.source.geneticCodeBasis === sourceRef.current.geneticCodeBasis &&
        owner.source.nucleicAcid === sourceRef.current.nucleicAcid;
      const match = owner.matches[index];
      if (!isCurrent() || !match) return;
      retireNavigation();
      owner.index = index;
      setActiveIndex(index);
      setReleased(false);
      const pending: NonNullable<typeof navigationRef.current> = {
        observed: false,
        request: {
          position: match.start + 1,
          range: { start: match.start, end: match.end, wraps: match.wraps || undefined },
          observe() {
            if (navigationRef.current !== pending || pending.observed || !isCurrent()) return;
            pending.observed = true;
            const observation = owner.observation?.beginNavigation?.();
            if (!observation) return;
            pending.observation = observation;
            return {
              get consumed() {
                return observation.consumed;
              },
              presented: (surface) =>
                navigationRef.current === pending && isCurrent() && observation.presented(surface),
              cancel: () => observation.cancel(),
            };
          },
        },
      };
      navigationRef.current = pending;
      setNavigationRequest(pending.request);
    },
    [retireNavigation]
  );
  const cancelObservation = useCallback(
    (reason: Parameters<Observation['cancel']>[0]) => {
      retireNavigation();
      resultOwnerRef.current = null;
      if (reason !== 'unmounted') setNavigationRequest(null);
      const observation = observationRef.current;
      observationRef.current = null;
      if (observation && !observation.consumed) observation.cancel(reason);
    },
    [retireNavigation]
  );
  const startObservation = useCallback(
    (q: string, m: SearchMode) => {
      const observation =
        q.length >= MIN_QUERY_LENGTH
          ? (onSearchStart?.({
              mode: m,
              queryLength: q.length,
              sequenceLength: sequence.length,
              circular,
            }) ?? null)
          : null;
      observationRef.current = observation;
      return observation;
    },
    [onSearchStart, sequence.length, circular]
  );

  const runSearch = useCallback(
    (q: string, m: SearchMode, observation: Observation | null = null) => {
      if (observation !== observationRef.current) return;
      if (q.length < MIN_QUERY_LENGTH) {
        setMatches([]);
        setActiveIndex(0);
        setIsError(false);
        setErrorMessage(null);
        return;
      }

      try {
        const results = runSequenceSearchForMode({
          sequence,
          annotations,
          sequenceGeneticCode,
          geneticCodeBasis,
          nucleicAcid,
          circular,
          query: q,
          mode: m,
        });
        setMatches(results);
        setActiveIndex(0);
        setIsError(false);
        setErrorMessage(null);
        const accepted =
          observation && !observation.consumed && observation.complete(results.length);
        const owner: ResultOwner = {
          source: {
            sequence,
            annotations,
            circular,
            sequenceGeneticCode,
            geneticCodeBasis,
            nucleicAcid,
          },
          matches: results,
          index: 0,
          observation: accepted ? observation : null,
        };
        resultOwnerRef.current = owner;
        publishNavigation(owner, 0);
      } catch (err) {
        setMatches([]);
        setActiveIndex(0);
        setIsError(true);
        setErrorMessage(sequenceSearchErrorMessage(err));
        if (observation && !observation.consumed) {
          observation.fail(err instanceof SearchTooBroadError ? 'too_broad' : 'invalid_pattern');
        }
      }
    },
    [
      sequence,
      annotations,
      circular,
      sequenceGeneticCode,
      geneticCodeBasis,
      nucleicAcid,
      publishNavigation,
    ]
  );

  const setQuery = useCallback(
    (q: string) => {
      cancelObservation('superseded');
      setQueryState(q);

      setReleased(false);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setMatches([]);
      setActiveIndex(0);
      setIsError(false);
      setErrorMessage(null);
      if (q.length < MIN_QUERY_LENGTH) return;

      const observation = startObservation(q, mode);
      debounceRef.current = setTimeout(() => {
        runSearch(q, mode, observation);
      }, DEBOUNCE_MS);
    },
    [mode, runSearch, cancelObservation, startObservation]
  );

  useEffect(() => {
    cancelObservation('source_changed');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (isOpen && query) {
      runSearch(query, mode, startObservation(query, mode));
    }
  }, [sequence, annotations, circular, sequenceGeneticCode, geneticCodeBasis, nucleicAcid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      cancelObservation('unmounted');
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cancelObservation]);

  const openInMode = useCallback(
    (newMode: SearchMode) => {
      setReleased(false);
      if (isOpen && mode !== newMode) {
        cancelObservation('mode_changed');
        setModeState(newMode);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setMatches([]);
        setActiveIndex(0);
        setIsError(false);
        setErrorMessage(null);
        if (query) {
          const observation = startObservation(query, newMode);
          debounceRef.current = setTimeout(() => {
            runSearch(query, newMode, observation);
          }, 0);
        }
      } else {
        setIsOpen(true);
        setModeState(newMode);
      }
    },
    [isOpen, mode, query, runSearch, cancelObservation, startObservation]
  );

  const close = useCallback(() => {
    cancelObservation('closed');
    setIsOpen(false);
    setQueryState('');
    setMatches([]);
    setActiveIndex(0);
    setIsError(false);
    setErrorMessage(null);

    setReleased(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, [cancelObservation]);

  const setMode = useCallback(
    (newMode: SearchMode) => {
      cancelObservation('mode_changed');
      setModeState(newMode);

      setReleased(false);

      setMatches([]);
      setActiveIndex(0);
      setIsError(false);
      setErrorMessage(null);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (query) {
        const observation = startObservation(query, newMode);
        debounceRef.current = setTimeout(() => {
          runSearch(query, newMode, observation);
        }, DEBOUNCE_MS);
      }
    },
    [query, runSearch, cancelObservation, startObservation]
  );

  const next = useCallback(() => {
    const owner = resultOwnerRef.current;
    if (!owner || owner.matches !== matches || matches.length === 0) return;
    publishNavigation(owner, (owner.index + 1) % matches.length);
  }, [matches, publishNavigation]);

  const prev = useCallback(() => {
    const owner = resultOwnerRef.current;
    if (!owner || owner.matches !== matches || matches.length === 0) return;
    publishNavigation(owner, (owner.index - 1 + matches.length) % matches.length);
  }, [matches, publishNavigation]);

  const isActiveReverse = useMemo(
    () => matches.length > 0 && matches[activeIndex]?.strand === 'reverse',
    [matches, activeIndex]
  );

  const scrollToPosition = useMemo(() => {
    if (released) return null;
    if (matches.length === 0 || !matches[activeIndex]) return null;

    return matches[activeIndex].start + 1;
  }, [matches, activeIndex, released]);

  const activeHighlightRange = useMemo(() => {
    if (released) return null;
    if (matches.length === 0 || !matches[activeIndex]) return null;
    const match = matches[activeIndex];
    return {
      start: match.start,
      end: match.end,
      wraps: match.wraps || undefined,
    };
  }, [matches, activeIndex, released]);

  const goToMatch = useCallback(
    (index: number) => {
      const owner = resultOwnerRef.current;
      if (owner?.matches === matches) publishNavigation(owner, index);
    },
    [matches, publishNavigation]
  );

  const releaseActiveHighlight = useCallback(() => {
    setReleased(true);
  }, []);

  return {
    isOpen,
    query,
    mode,
    matches,
    activeIndex,
    matchCount: matches.length,
    isActiveReverse,
    isError,
    errorMessage,
    openInMode,
    close,
    setQuery,
    setMode,
    next,
    prev,
    scrollToPosition,
    navigationRequest,
    activeHighlightRange,
    goToMatch,
    releaseActiveHighlight,
  };
}

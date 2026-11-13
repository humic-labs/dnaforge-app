import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  toUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SearchMatch } from '@waypoint/sequence-utils';
import { resolveAnnotationTrackIdentity } from '@waypoint/genome-renderer/annotation-track-identity';
import {
  PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1,
  normalizePrepackedProteinSearchQuery,
  type IndexedGenomeManifest,
  type PrepackedProteinSearchMatchV1,
} from '@waypoint/genome-data';

import { platform } from '../../../platform';
import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSearchQueryResultV1,
  AssemblyProteinSearchQueryResultV1,
  AssemblySequenceSearchSourceV1,
} from '../../../shared/indexed-genome';
import type { AnnotationIndex } from '../genome-annotation-index';

export type SearchMode = 'nucleotide' | 'aminoAcid';

export interface IndexedGenomeSearchMatch extends SearchMatch {
  annotationFeatureIndex?: number;
}

const DEBOUNCE_MS = 150;
const MIN_QUERY_LENGTH = 2;
const DISK_ANNOTATION_MIN_QUERY_LENGTH = 3;
const NUCLEOTIDE_MAX_RESULTS = 500;
const ANNOTATION_MAX_RESULTS = 500;
const ASSEMBLY_SEARCH_UNAVAILABLE_MESSAGE = userMessage('genome.searchUnavailable');

export interface UseGenomeSearchParams {
  manifest: IndexedGenomeManifest | null;
  chrom: string | null;
  annotationIndex: AnnotationIndex | null;
  assemblyAnnotationSearchSource?: AssemblyAnnotationSceneReadRequest | null;
  assemblySequenceSearchSource?: AssemblySequenceSearchSourceV1 | null;
  annotationIndexError?: unknown | null;
  visibleAnnotationTrackIds?: ReadonlySet<string> | null;
  onJumpToMatch: (match: IndexedGenomeSearchMatch) => void;
}

export interface UseGenomeSearchReturn {
  isOpen: boolean;
  query: string;
  mode: SearchMode;
  minQueryLength: number;
  matches: IndexedGenomeSearchMatch[];
  activeIndex: number;
  matchCount: number;
  isTruncated: boolean;
  isActiveReverse: boolean;
  isSearching: boolean;
  annotationAuthorityRevision: string | AnnotationIndex | null;
  isError: boolean;
  errorMessage: UserMessage | null;
  annotationIndexReady: boolean;
  openInMode: (mode: SearchMode) => void;
  close: () => void;
  setQuery: (q: string) => void;
  setMode: (m: SearchMode) => void;
  next: () => void;
  prev: () => void;
  goToMatch: (i: number) => void;
}

export function useGenomeSearch(params: UseGenomeSearchParams): UseGenomeSearchReturn {
  const {
    manifest,
    chrom,
    annotationIndex,
    assemblyAnnotationSearchSource,
    assemblySequenceSearchSource,
    annotationIndexError,
    visibleAnnotationTrackIds,
    onJumpToMatch,
  } = params;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [mode, setModeState] = useState<SearchMode>('nucleotide');
  const [matches, setMatches] = useState<IndexedGenomeSearchMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isTruncated, setIsTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<UserMessage | null>(null);
  const [isError, setIsError] = useState(false);
  const minQueryLength = searchMinimumQueryLength(mode, assemblyAnnotationSearchSource);

  const onJumpToMatchRef = useRef(onJumpToMatch);
  useEffect(() => {
    onJumpToMatchRef.current = onJumpToMatch;
  }, [onJumpToMatch]);

  const requestSeqRef = useRef(0);
  const searchQuerySeqRef = useRef(0);
  const searchClientIdRef = useRef<string | null>(null);
  if (!searchClientIdRef.current) {
    searchClientIdRef.current = createAssemblySearchOpaqueId('client');
  }
  const activeSearchQueryRefs = useRef<Set<AbortController>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assemblyAnnotationSearchSourceIdentity = useMemo(
    () => annotationSearchSourceIdentity(assemblyAnnotationSearchSource),
    [assemblyAnnotationSearchSource]
  );
  const assemblySequenceSearchSourceIdentity = useMemo(
    () => sequenceSearchSourceIdentity(assemblySequenceSearchSource),
    [assemblySequenceSearchSource]
  );

  const supersedeSearch = useCallback((): number => {
    for (const controller of activeSearchQueryRefs.current) controller.abort();
    activeSearchQueryRefs.current.clear();
    const generation = ++requestSeqRef.current;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setMatches([]);
    setActiveIndex(0);
    setIsTruncated(false);
    setIsSearching(false);
    setIsError(false);
    setErrorMessage(null);
    return generation;
  }, []);

  const runSearch = useCallback(
    async (rawQuery: string, currentMode: SearchMode, generation: number) => {
      const isCurrent = () => generation === requestSeqRef.current;
      if (!isCurrent()) return;
      const trimmed = rawQuery.trim();
      const normalizedProteinQuery =
        currentMode === 'aminoAcid' ? normalizePrepackedProteinSearchQuery(trimmed) : null;
      setIsError(false);
      setErrorMessage(null);
      if (trimmed.length < searchMinimumQueryLength(currentMode, assemblyAnnotationSearchSource)) {
        setMatches([]);
        setActiveIndex(0);
        return;
      }
      if (
        currentMode === 'aminoAcid' &&
        assemblyAnnotationSearchSource &&
        trimmed.length > PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1 &&
        normalizedProteinQuery === null
      ) {
        setIsError(true);
        setErrorMessage(
          userMessageWithValues('genome.queryLimit', {
            count: userMessageValue(PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1),
          })
        );
        setMatches([]);
        setActiveIndex(0);
        return;
      }

      if (currentMode === 'nucleotide') {
        if (!assemblySequenceSearchSource && (!manifest || !chrom)) {
          setMatches([]);
          setActiveIndex(0);
          return;
        }
        const controller = new AbortController();
        activeSearchQueryRefs.current.add(controller);
        const requestId = createAssemblySearchOpaqueId(`request-${++searchQuerySeqRef.current}`);
        try {
          if (assemblySequenceSearchSource) {
            const result = await platform().genome.searchAssemblySequence(
              {
                source: assemblySequenceSearchSource,
                clientId: searchClientIdRef.current!,
                requestId,
                motif: trimmed,
                limit: NUCLEOTIDE_MAX_RESULTS,
                reverseComplement: true,
              },
              { signal: controller.signal }
            );
            if (!isCurrent()) return;
            setMatches(
              result.hits.map((hit) => ({
                start: hit.globalStartBp,
                end: Math.max(hit.globalStartBp, hit.globalEndBp - 1),
                chrom: hit.chrom,
                localStart: hit.localStartBp,
                localEnd: Math.max(hit.localStartBp, hit.localEndBp - 1),
                strand: hit.strand,
                type: 'nucleotide',
                label: trimmed,
              }))
            );
            setIsTruncated(result.truncated);
            setActiveIndex(0);
            return;
          }
          const hits = await platform().genome.searchSequence(
            manifest!,
            chrom!,
            trimmed,
            {
              reverseComplement: true,
              maxResults: NUCLEOTIDE_MAX_RESULTS,
            },
            {
              clientId: searchClientIdRef.current!,
              requestId,
              signal: controller.signal,
            }
          );
          if (!isCurrent()) return;
          const next: IndexedGenomeSearchMatch[] = hits.map((h) => ({
            start: h.start,
            end: Math.max(h.start, h.end - 1),
            strand: h.strand,
            type: 'nucleotide',
            label: trimmed,
          }));
          setMatches(next);
          setIsTruncated(false);
          setActiveIndex(0);
        } catch (err) {
          if (!isCurrent()) return;
          setIsError(true);
          setErrorMessage(toUserMessage(err, 'genome.searchFailed'));
          setMatches([]);
          setActiveIndex(0);
        } finally {
          activeSearchQueryRefs.current.delete(controller);
        }
        return;
      }

      if (currentMode === 'aminoAcid') {
        if (assemblyAnnotationSearchSource) {
          try {
            const queryAnnotationIndex =
              async (): Promise<AssemblyAnnotationSearchQueryResultV1 | null> => {
                if (!isCurrent()) return null;
                const controller = new AbortController();
                activeSearchQueryRefs.current.add(controller);
                const requestId = createAssemblySearchOpaqueId(
                  `request-${++searchQuerySeqRef.current}`
                );
                try {
                  return await platform().genome.queryAssemblyAnnotationSearch(
                    {
                      source: assemblyAnnotationSearchSource,
                      clientId: searchClientIdRef.current!,
                      requestId,
                      query: trimmed,
                      limit: ANNOTATION_MAX_RESULTS,
                    },
                    { signal: controller.signal }
                  );
                } finally {
                  activeSearchQueryRefs.current.delete(controller);
                }
              };
            const annotationPromise =
              trimmed.length <= PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1
                ? queryAnnotationIndex()
                : Promise.resolve(null);
            const proteinPromise = normalizedProteinQuery
              ? (async (): Promise<AssemblyProteinSearchQueryResultV1 | null> => {
                  if (!isCurrent()) return null;
                  const controller = new AbortController();
                  activeSearchQueryRefs.current.add(controller);
                  const requestId = createAssemblySearchOpaqueId(
                    `request-${++searchQuerySeqRef.current}`
                  );
                  try {
                    return await platform().genome.queryAssemblyProteinSearch(
                      {
                        source: assemblyAnnotationSearchSource,
                        clientId: searchClientIdRef.current!,
                        requestId,
                        query: normalizedProteinQuery,
                        limit: ANNOTATION_MAX_RESULTS,
                      },
                      { signal: controller.signal }
                    );
                  } finally {
                    activeSearchQueryRefs.current.delete(controller);
                  }
                })()
              : Promise.resolve(null);
            const [annotationResult, proteinResult] = await Promise.all([
              annotationPromise,
              proteinPromise,
            ]);
            if (!isCurrent()) return;
            const annotationQueryIssued =
              trimmed.length <= PREPACKED_ANNOTATION_SEARCH_MAX_QUERY_CODE_UNITS_V1;
            const proteinQueryIssued = normalizedProteinQuery !== null;
            if (
              (annotationQueryIssued && annotationResult?.status !== 'hit') ||
              (proteinQueryIssued && proteinResult?.status !== 'hit')
            ) {
              setIsError(true);
              setErrorMessage(ASSEMBLY_SEARCH_UNAVAILABLE_MESSAGE);
              setMatches([]);
              setIsTruncated(false);
              setActiveIndex(0);
              return;
            }
            const annotationMatches: IndexedGenomeSearchMatch[] =
              annotationResult?.status === 'hit'
                ? annotationResult.matches.map((hit) =>
                    indexedAnnotationMatch({
                      ...hit,
                      ...assemblyAnnotationMatchLocation(assemblyAnnotationSearchSource, hit),
                      ...optionalAnnotationTrackVisibility(
                        visibleAnnotationTrackIds,
                        hit.annotationTrackId
                      ),
                    })
                  )
                : [];
            const proteinMatches =
              proteinResult?.status === 'hit'
                ? proteinResult.matches
                    .map((hit) =>
                      indexedProteinMatch(
                        assemblyAnnotationSearchSource,
                        hit,
                        visibleAnnotationTrackIds
                      )
                    )
                    .sort(compareIndexedProteinMatches)
                : [];
            const allMatches = [...proteinMatches, ...annotationMatches];
            setMatches(allMatches.slice(0, ANNOTATION_MAX_RESULTS));
            setIsTruncated(
              Boolean(annotationResult?.status === 'hit' && annotationResult.truncated) ||
                Boolean(proteinResult?.status === 'hit' && proteinResult.truncated) ||
                allMatches.length > ANNOTATION_MAX_RESULTS
            );
            setActiveIndex(0);
          } catch (err) {
            if (!isCurrent()) return;
            setIsError(true);
            setErrorMessage(toUserMessage(err, 'genome.searchFailed'));
            setMatches([]);
            setActiveIndex(0);
          }
          return;
        }
        if (!annotationIndex) {
          if (annotationIndexError) {
            setIsError(true);
            setErrorMessage(toUserMessage(annotationIndexError, 'genome.searchFailed'));
          }
          setMatches([]);
          setActiveIndex(0);
          return;
        }
        const hits = annotationIndex.query(trimmed, ANNOTATION_MAX_RESULTS);
        if (!isCurrent()) return;
        const next: IndexedGenomeSearchMatch[] = hits.map((hit) =>
          indexedAnnotationMatch({
            ...hit,
            annotationFeatureIndex: hit.featureIndex,
            ...optionalAnnotationTrackVisibility(visibleAnnotationTrackIds, hit.annotationTrackId),
          })
        );
        setMatches(next);
        setIsTruncated(false);
        setActiveIndex(0);
      }
    },
    [
      annotationIndex,
      annotationIndexError,
      assemblyAnnotationSearchSource,
      assemblySequenceSearchSource,
      chrom,
      manifest,
      visibleAnnotationTrackIds,
    ]
  );

  const scheduleSearch = useCallback(
    (q: string, m: SearchMode) => {
      const generation = supersedeSearch();
      setIsSearching(
        q.trim().length >= searchMinimumQueryLength(m, assemblyAnnotationSearchSource)
      );
      const timer = setTimeout(() => {
        if (debounceTimerRef.current === timer) debounceTimerRef.current = null;
        void runSearch(q, m, generation).finally(() => {
          if (generation === requestSeqRef.current) setIsSearching(false);
        });
      }, DEBOUNCE_MS);
      debounceTimerRef.current = timer;
    },
    [assemblyAnnotationSearchSource, runSearch, supersedeSearch]
  );

  const lastAnnotationAuthorityRef = useRef({
    index: annotationIndex,
    error: annotationIndexError,
    sourceIdentity: assemblyAnnotationSearchSourceIdentity,
  });
  useEffect(() => {
    if (
      lastAnnotationAuthorityRef.current.index === annotationIndex &&
      lastAnnotationAuthorityRef.current.error === annotationIndexError &&
      lastAnnotationAuthorityRef.current.sourceIdentity === assemblyAnnotationSearchSourceIdentity
    ) {
      return;
    }
    lastAnnotationAuthorityRef.current = {
      index: annotationIndex,
      error: annotationIndexError,
      sourceIdentity: assemblyAnnotationSearchSourceIdentity,
    };

    if (mode !== 'aminoAcid') return;

    const generation = supersedeSearch();

    if (annotationIndexError) {
      setIsError(true);
      setErrorMessage(toUserMessage(annotationIndexError, 'genome.searchFailed'));
    } else if (
      (annotationIndex || assemblyAnnotationSearchSource) &&
      query.trim().length >= searchMinimumQueryLength('aminoAcid', assemblyAnnotationSearchSource)
    ) {
      setIsSearching(true);
      void runSearch(query, 'aminoAcid', generation).finally(() => {
        if (generation === requestSeqRef.current) setIsSearching(false);
      });
    }
  }, [
    annotationIndex,
    annotationIndexError,
    assemblyAnnotationSearchSource,
    assemblyAnnotationSearchSourceIdentity,
    mode,
    query,
    runSearch,
    supersedeSearch,
  ]);

  useEffect(() => {
    if (!visibleAnnotationTrackIds) return;
    setMatches((current) => {
      let changed = false;
      const next = current.map((match) => {
        if ((match.type !== 'annotation' && match.type !== 'protein') || !match.annotationTrackId) {
          return match;
        }
        const visibility = annotationTrackVisibility(
          visibleAnnotationTrackIds,
          match.annotationTrackId
        );
        if (!visibility || visibility === match.annotationTrackVisibility) return match;
        changed = true;
        return { ...match, annotationTrackVisibility: visibility };
      });
      return changed ? next : current;
    });
  }, [visibleAnnotationTrackIds]);

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q);
      scheduleSearch(q, mode);
    },
    [mode, scheduleSearch]
  );

  const setMode = useCallback(
    (m: SearchMode) => {
      setModeState(m);
      scheduleSearch(query, m);
    },
    [query, scheduleSearch]
  );

  const openInMode = useCallback(
    (newMode: SearchMode) => {
      const opening = !isOpen;
      const modeChanged = mode !== newMode;
      if (!opening && !modeChanged) return;
      if (opening) setIsOpen(true);
      if (modeChanged) setModeState(newMode);
      if (query) scheduleSearch(query, newMode);
      else supersedeSearch();
    },
    [isOpen, mode, query, scheduleSearch, supersedeSearch]
  );

  const close = useCallback(() => {
    setIsOpen(false);
    setQueryState('');
    supersedeSearch();
  }, [supersedeSearch]);

  const lastDatasetKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key =
      assemblySequenceSearchSourceIdentity ??
      (manifest && chrom ? `${manifest.fastaPath}::${chrom}` : null);
    if (lastDatasetKeyRef.current !== null && lastDatasetKeyRef.current !== key) {
      setIsOpen(false);
      setQueryState('');
      supersedeSearch();
    }
    lastDatasetKeyRef.current = key;
  }, [assemblySequenceSearchSourceIdentity, chrom, manifest, supersedeSearch]);

  useEffect(() => {
    return () => {
      for (const controller of activeSearchQueryRefs.current) controller.abort();
      activeSearchQueryRefs.current.clear();
      requestSeqRef.current++;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  const goToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0) return;
      const clamped = ((index % matches.length) + matches.length) % matches.length;
      setActiveIndex(clamped);
      const match = matches[clamped];
      onJumpToMatchRef.current(match);
    },
    [matches]
  );

  const next = useCallback(() => {
    if (matches.length === 0) return;
    goToMatch(activeIndex + 1);
  }, [activeIndex, goToMatch, matches.length]);

  const prev = useCallback(() => {
    if (matches.length === 0) return;
    goToMatch(activeIndex - 1);
  }, [activeIndex, goToMatch, matches.length]);

  const matchCount = matches.length;
  const isActiveReverse = useMemo(() => {
    const m = matches[activeIndex];
    return m?.strand === 'reverse';
  }, [activeIndex, matches]);

  return {
    isOpen,
    query,
    mode,
    minQueryLength,
    matches,
    activeIndex,
    matchCount,
    isTruncated,
    isActiveReverse,
    isSearching,
    annotationAuthorityRevision: assemblyAnnotationSearchSourceIdentity ?? annotationIndex,
    isError,
    errorMessage,
    annotationIndexReady: annotationIndex != null || assemblyAnnotationSearchSource != null,
    openInMode,
    close,
    setQuery,
    setMode,
    next,
    prev,
    goToMatch,
  };
}

function searchMinimumQueryLength(
  mode: SearchMode,
  assemblyAnnotationSearchSource: AssemblyAnnotationSceneReadRequest | null | undefined
): number {
  return mode === 'aminoAcid' && assemblyAnnotationSearchSource
    ? DISK_ANNOTATION_MIN_QUERY_LENGTH
    : MIN_QUERY_LENGTH;
}

function createAssemblySearchOpaqueId(scope: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${scope}-${uuid}`;
  return `${scope}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function annotationSearchSourceIdentity(
  source: AssemblyAnnotationSceneReadRequest | null | undefined
): string | null {
  if (!source) return null;
  return JSON.stringify({
    assemblyId: source.assemblyId,
    workspaceRoot: source.workspaceRoot,
    scope: source.scope,
    chromosomes: source.chromosomes.map(({ chrom, length, sourcePath, manifest }) => ({
      chrom,
      length,
      sourcePath: sourcePath ?? '',
      manifest: manifest
        ? {
            fastaPath: manifest.fastaPath,
            faiPath: manifest.faiPath,
            gffPath: manifest.gffPath,
            tbiPath: manifest.tbiPath,
          }
        : null,
    })),
    datasetContract: source.datasetContract,
  });
}

function sequenceSearchSourceIdentity(
  source: AssemblySequenceSearchSourceV1 | null | undefined
): string | null {
  if (!source) return null;
  return JSON.stringify({
    contract: source.contract,
    assemblyId: source.assemblyId,
    chromosomes: source.chromosomes.map(({ chrom, length, manifest }) => ({
      chrom,
      length,
      fastaPath: manifest.fastaPath,
      faiPath: manifest.faiPath,
    })),
  });
}

function annotationTrackVisibility(
  visibleTrackIds: ReadonlySet<string> | null | undefined,
  trackId: string | null | undefined
): 'visible' | 'hidden' | undefined {
  const requested = trackId?.trim() ?? '';
  if (!visibleTrackIds || !requested) return undefined;
  const resolution = resolveAnnotationTrackIdentity(
    requested,
    visibleTrackIds,
    (visibleTrackId) => visibleTrackId
  );
  return resolution.status === 'matched' ? 'visible' : 'hidden';
}

function optionalAnnotationTrackVisibility(
  visibleTrackIds: ReadonlySet<string> | null | undefined,
  trackId: string | null | undefined
): Pick<IndexedGenomeSearchMatch, 'annotationTrackVisibility'> | Record<string, never> {
  const visibility = annotationTrackVisibility(visibleTrackIds, trackId);
  return visibility ? { annotationTrackVisibility: visibility } : {};
}

function indexedProteinMatch(
  source: AssemblyAnnotationSceneReadRequest,
  hit: PrepackedProteinSearchMatchV1,
  visibleTrackIds: ReadonlySet<string> | null | undefined
): IndexedGenomeSearchMatch {
  const end = Math.max(hit.start, hit.end - 1);
  const direction = hit.strand === 'reverse' ? -1 : 1;
  return {
    start: hit.start,
    end,
    strand: hit.strand,
    type: 'protein',
    label: hit.label,
    featureType: hit.featureType,
    annotationTrackId: hit.annotationTrackId,
    canonicalIdentity: hit.canonicalIdentity,
    ...assemblyAnnotationMatchLocation(source, hit),
    ...optionalAnnotationTrackVisibility(visibleTrackIds, hit.annotationTrackId),
    annotation: {
      type: hit.featureType,
      name: hit.label,
      start: hit.start + 1,
      end: end + 1,
      direction,
    },
    protein: {
      ...(hit.geneId ? { geneId: hit.geneId } : {}),
      transcriptId: hit.transcriptId,
      proteinStart: hit.proteinStart,
      proteinEnd: hit.proteinEnd,
      geneticCode: hit.geneticCode,
      segments: hit.segments.map((segment) => ({ ...segment })),
    },
  };
}

function compareIndexedProteinMatches(
  left: IndexedGenomeSearchMatch,
  right: IndexedGenomeSearchMatch
): number {
  const leftGene = left.protein?.geneId ?? '';
  const rightGene = right.protein?.geneId ?? '';
  return (
    leftGene.localeCompare(rightGene) ||
    (left.protein?.transcriptId ?? '').localeCompare(right.protein?.transcriptId ?? '') ||
    (left.protein?.proteinStart ?? 0) - (right.protein?.proteinStart ?? 0) ||
    left.start - right.start
  );
}

function assemblyAnnotationMatchLocation(
  source: AssemblyAnnotationSceneReadRequest,
  hit: { start: number; end: number }
): Pick<IndexedGenomeSearchMatch, 'chrom' | 'localStart' | 'localEnd'> | Record<string, never> {
  let chromosomeStartBp = 0;
  for (const chromosome of source.chromosomes) {
    const chromosomeEndBp = chromosomeStartBp + chromosome.length;
    if (hit.start >= chromosomeStartBp && hit.start < chromosomeEndBp) {
      const localStart = hit.start - chromosomeStartBp;
      const localEndExclusive = Math.min(hit.end, chromosomeEndBp) - chromosomeStartBp;
      return {
        chrom: chromosome.chrom,
        localStart,
        localEnd: Math.max(localStart, localEndExclusive - 1),
      };
    }
    chromosomeStartBp = chromosomeEndBp;
  }
  return {};
}

function indexedAnnotationMatch(hit: {
  start: number;
  end: number;
  label: string;
  featureType: string;
  direction: 'forward' | 'reverse' | 'none';
  annotationTrackId?: string;
  canonicalIdentity?: string;
  annotationFeatureIndex?: number;
  annotationTrackVisibility?: 'visible' | 'hidden';
  chrom?: string;
  localStart?: number;
  localEnd?: number;
}): IndexedGenomeSearchMatch {
  const end = Math.max(hit.start, hit.end - 1);
  const direction = hit.direction === 'reverse' ? -1 : hit.direction === 'forward' ? 1 : 0;
  return {
    start: hit.start,
    end,
    strand: hit.direction === 'reverse' ? 'reverse' : 'forward',
    type: 'annotation',
    label: hit.label,
    featureType: hit.featureType,
    annotation: {
      type: hit.featureType,
      name: hit.label,
      start: hit.start + 1,
      end: end + 1,
      direction,
    },
    ...(hit.annotationFeatureIndex === undefined
      ? {}
      : { annotationFeatureIndex: hit.annotationFeatureIndex }),
    ...(hit.annotationTrackId ? { annotationTrackId: hit.annotationTrackId } : {}),
    ...(hit.canonicalIdentity ? { canonicalIdentity: hit.canonicalIdentity } : {}),
    ...(hit.annotationTrackVisibility
      ? { annotationTrackVisibility: hit.annotationTrackVisibility }
      : {}),
    ...(hit.chrom === undefined ? {} : { chrom: hit.chrom }),
    ...(hit.localStart === undefined ? {} : { localStart: hit.localStart }),
    ...(hit.localEnd === undefined ? {} : { localEnd: hit.localEnd }),
  };
}

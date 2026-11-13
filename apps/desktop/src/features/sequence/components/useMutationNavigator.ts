import {
  toUserMessage,
  userMessage,
  withUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  directTrackAdmissionRequest,
  sameAdmittedTrackSourceIdentity,
  type AdmittedTrackSource,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import { platform } from '../../../platform';
import type {
  IndexedGenomeManifest,
  IndexedGenomeVariantSourceState,
} from '../../../shared/indexed-genome';
import {
  loadMutationAnnotationImpacts,
  type MutationAnnotationImpactState,
} from '../mutation-annotation-impact';
import {
  isVariantSourceChangedError,
  readVariantPage,
  type VariantReferenceIdentity,
  type VariantSummary,
} from '../variant-client';
import {
  forgetPreparedVariantSource,
  preparedVariantSourceFromDurable,
  rememberPreparedVariantSource,
} from '../prepared-variant-source-cache';
import { readRemoteVariantPage } from '../remote-variant-client';
import { readHtsgetVariantPage } from '../htsget-client';
import { attachVariantRequest } from '../attach-variant-request';
import { admitTrackSource } from '../track-admission';
import {
  isHtsgetVariantRuntime,
  isLocalVariantRuntime,
  requireVariantRequest,
} from '../variant-source-state';
import type { VariantTrackRuntime } from '../variant-track-admission';
import {
  startVariantSourceOperation,
  waitForVariantSourceResult,
} from '../variant-source-operation-client';

const PAGE_SIZE = 100;
const MAX_RETAINED_VARIANTS = 1_000;
const REMOTE_GRANT_REFRESH_SKEW_MS = 30_000;

type MutationNavigatorPhase = 'idle' | 'preparing' | 'loading' | 'loading-more';
interface UseMutationNavigatorInput {
  readonly assemblyId?: string;
  readonly references: ReadonlyArray<VariantReferenceIdentity>;
  readonly annotationManifests: ReadonlyMap<string, IndexedGenomeManifest>;
  readonly persistedSource: IndexedGenomeVariantSourceState | null;
  readonly onSourcePrepared: (source: IndexedGenomeVariantSourceState) => void;
}

export function useMutationNavigator({
  assemblyId = 'grch38',
  references,
  annotationManifests,
  persistedSource,
  onSourcePrepared,
}: UseMutationNavigatorInput) {
  const [isOpen, setIsOpen] = useState(false);
  const [source, setSource] = useState<IndexedGenomeVariantSourceState | null>(persistedSource);
  const [variants, setVariants] = useState<ReadonlyArray<VariantSummary>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [phase, setPhase] = useState<MutationNavigatorPhase>('idle');
  const [error, setError] = useState<UserMessage | null>(null);
  const [trimmed, setTrimmed] = useState(false);
  const [annotationImpacts, setAnnotationImpacts] = useState<
    ReadonlyMap<string, MutationAnnotationImpactState>
  >(() => new Map());
  const operationRef = useRef<AbortController | null>(null);
  const runtimeRef = useRef<VariantTrackRuntime | null>(null);
  const annotationOperationTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const referenceNames = useMemo(() => references.map((reference) => reference.name), [references]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.abort();
      annotationOperationTokenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!persistedSource) return;
    const remembered = preparedVariantSourceFromDurable(persistedSource);
    if (remembered) rememberPreparedVariantSource(remembered, references);
  }, [persistedSource, references]);

  useEffect(() => {
    setSource((current) => {
      if (current?.sourceIdentity === persistedSource?.sourceIdentity) return current;
      runtimeRef.current = null;
      annotationOperationTokenRef.current += 1;
      setVariants([]);
      setNextCursor(null);
      setSelectedVariantId(null);
      setTrimmed(false);
      setAnnotationImpacts(new Map());
      return persistedSource;
    });
  }, [persistedSource]);

  const beginOperation = useCallback(() => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  }, []);

  const resetResults = useCallback(() => {
    annotationOperationTokenRef.current += 1;
    setError(null);
    setVariants([]);
    setNextCursor(null);
    setSelectedVariantId(null);
    setTrimmed(false);
    setAnnotationImpacts(new Map());
  }, []);

  const admitDurableRuntime = useCallback(
    async (
      durable: IndexedGenomeVariantSourceState,
      signal: AbortSignal,
      options: { readonly force?: boolean } = {}
    ): Promise<VariantTrackRuntime> => {
      const admitted = requireVariantReceipt(durable);
      const current = runtimeRef.current;
      if (
        !options.force &&
        current?.sourceIdentity === durable.sourceIdentity &&
        runtimeIsFresh(current)
      ) {
        return current;
      }

      let preparedRuntime: VariantTrackRuntime | null = null;
      const refreshed = await admitTrackSource({
        request: requireVariantRequest(admitted),
        assemblyId: admitted.assemblyId,
        assemblyReferences: references,
        signal,
        reuseRememberedPreparation: !options.force,
        onVariantRuntime: ({ runtime }) => {
          preparedRuntime = runtime;
        },
      });
      const runtime = preparedRuntime as VariantTrackRuntime | null;
      if (!runtime) {
        throw new Error('Variant admission did not return a query runtime.');
      }
      if (
        !sameAdmittedTrackSourceIdentity(admitted, refreshed) ||
        runtime.sourceIdentity !== durable.sourceIdentity ||
        runtime.assemblyRevision !== durable.assemblyRevision
      ) {
        throw withUserMessage(
          new Error('The variant source changed after it was attached.'),
          'variant.sourceChanged'
        );
      }
      runtimeRef.current = runtime;
      return runtime;
    },
    [references]
  );

  const readAdmittedPage = useCallback(
    async (
      durable: IndexedGenomeVariantSourceState,
      cursor: string | null,
      signal: AbortSignal
    ) => {
      try {
        const runtime = await admitDurableRuntime(durable, signal);
        return await readRuntimeVariantPage(runtime, references, cursor, signal);
      } catch (error) {
        if (signal.aborted || !isVariantSourceChangedError(error)) throw error;
        forgetPreparedVariantSource(durable.sourcePath);
        const runtime = await admitDurableRuntime(durable, signal, { force: true });
        return readRuntimeVariantPage(runtime, references, cursor, signal);
      }
    },
    [admitDurableRuntime, references]
  );

  const prepareAndLoad = useCallback(
    async (variantPath: string) => {
      const controller = beginOperation();
      resetResults();
      setPhase('preparing');
      try {
        const operation = await startVariantSourceOperation({
          variantPath,
          references: references.map((reference) => ({ ...reference })),
        });
        if (!mountedRef.current || controller.signal.aborted) return;
        const prepared = await waitForVariantSourceResult(operation.id, {
          signal: controller.signal,
        });
        if (!mountedRef.current || controller.signal.aborted) return;
        rememberPreparedVariantSource(prepared, references, variantPath);
        runtimeRef.current = {
          kind: 'local',
          prepared,
          sourceIdentity: prepared.sourceIdentity,
          assemblyRevision: prepared.assemblyRevision,
          matchedReferences: [...prepared.matchedReferences],
          samples: [...prepared.samples],
        };
        const durable: IndexedGenomeVariantSourceState = {
          ...prepared,
          matchedReferences: [...prepared.matchedReferences],
          samples: [...prepared.samples],
          attachedAt: Date.now(),
        };
        setSource(durable);
        onSourcePrepared(durable);
        setPhase('loading');
        const page = await readVariantPage(
          {
            queryPath: prepared.queryPath,
            indexPath: prepared.indexPath,
            references: referenceNames,
            sourceGeneration: prepared.sourceGeneration,
            queryGeneration: prepared.queryGeneration,
            indexGeneration: prepared.indexGeneration,
            assemblyRevision: prepared.assemblyRevision,
            cursor: null,
            limit: PAGE_SIZE,
          },
          fetch,
          { signal: controller.signal }
        );
        if (!mountedRef.current || controller.signal.aborted) return;
        setVariants(page.variants);
        setNextCursor(page.nextCursor);
        setPhase('idle');
      } catch (cause) {
        if (!mountedRef.current || controller.signal.aborted) return;
        setPhase('idle');
        setError(toUserMessage(cause, 'tracks.loadFailed'));
      }
    },
    [beginOperation, onSourcePrepared, referenceNames, references, resetResults]
  );

  const loadAdmittedSource = useCallback(
    async (durable: IndexedGenomeVariantSourceState) => {
      const controller = beginOperation();
      resetResults();
      setPhase('preparing');
      try {
        const page = await readAdmittedPage(durable, null, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setVariants(page.variants);
        setNextCursor(page.nextCursor);
        setPhase('idle');
      } catch (cause) {
        if (!mountedRef.current || controller.signal.aborted) return;
        setPhase('idle');
        setError(toUserMessage(cause, 'tracks.loadFailed'));
      }
    },
    [beginOperation, readAdmittedPage, resetResults]
  );

  const attachNetworkRequest = useCallback(
    async (request: TrackAdmissionRequestV1) => {
      const controller = beginOperation();
      resetResults();
      setIsOpen(true);
      setPhase('preparing');
      try {
        const attached = await attachVariantRequest({
          request,
          assemblyId: request.assemblyId,
          assemblyReferences: references,
          signal: controller.signal,
          commit: () => 'added',
        });
        if (!mountedRef.current || controller.signal.aborted) return;
        const { runtime, source: durable } = attached;
        runtimeRef.current = runtime;
        setSource(durable);
        onSourcePrepared(durable);
        setPhase('loading');
        const page = await readRuntimeVariantPage(runtime, references, null, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setVariants(page.variants);
        setNextCursor(page.nextCursor);
        setPhase('idle');
      } catch (cause) {
        if (!mountedRef.current || controller.signal.aborted) return;
        setPhase('idle');
        setError(toUserMessage(cause, 'variant.preparationFailed'));
        throw cause;
      }
    },
    [beginOperation, onSourcePrepared, references, resetResults]
  );

  const chooseSource = useCallback(async () => {
    setError(null);
    let selection: string | string[] | null;
    try {
      selection = await platform().dialog.open({
        multiple: false,
        title: 'Open mutation calls',
        filters: [
          { name: 'Variant calls (VCF or BCF)', extensions: ['vcf', 'gz', 'bgz', 'bcf'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
    } catch (cause) {
      setError(toUserMessage(cause, 'tracks.loadFailed'));
      return;
    }
    const path = Array.isArray(selection) ? selection[0] : selection;
    if (!path) return;
    try {
      await attachNetworkRequest(
        directTrackAdmissionRequest({
          assemblyId,
          input: { kind: 'path', path },
          scientificKind: 'variants',
          ingress: 'file-picker',
        })
      );
    } catch {}
  }, [assemblyId, attachNetworkRequest]);

  const openNavigator = useCallback(async () => {
    setIsOpen(true);
    if (phase !== 'idle') return;
    if (source && variants.length > 0) return;
    if (source) {
      if (isAdmittedVariantSource(source)) await loadAdmittedSource(source);
      else await prepareAndLoad(source.sourcePath);
    } else await chooseSource();
  }, [chooseSource, loadAdmittedSource, phase, prepareAndLoad, source, variants.length]);

  const closeNavigator = useCallback(() => {
    setIsOpen(false);
    operationRef.current?.abort();
    setPhase('idle');
  }, []);

  useEffect(() => {
    if (variants.length === 0) return;
    const pending = variants.filter((variant) => {
      const state = annotationImpacts.get(variant.id);
      return state === undefined;
    });
    if (pending.length === 0) return;

    const token = annotationOperationTokenRef.current;
    setAnnotationImpacts((current) => {
      const next = new Map(current);
      for (const variant of pending) next.set(variant.id, { status: 'loading' });
      return next;
    });
    void loadMutationAnnotationImpacts({
      variants: pending,
      manifests: annotationManifests,
      readFeatures: (manifest, chrom, start, end, zoomLevel) =>
        platform().genome.getFeatures(manifest, chrom, start, end, zoomLevel),
    }).then((loaded) => {
      if (!mountedRef.current || token !== annotationOperationTokenRef.current) return;
      setAnnotationImpacts((current) => {
        const next = new Map(current);
        for (const [variantId, impact] of loaded) next.set(variantId, impact);
        return next;
      });
    });
  }, [annotationImpacts, annotationManifests, variants]);

  useEffect(() => {
    if (!isOpen || !source || !isNetworkVariantSource(source)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const schedule = (delayMs?: number) => {
      if (cancelled) return;
      const runtime = runtimeRef.current;
      const delay =
        delayMs ??
        Math.max(1_000, runtimeGrantExpiresAt(runtime) - Date.now() - REMOTE_GRANT_REFRESH_SKEW_MS);
      timer = setTimeout(() => {
        controller = new AbortController();
        void admitDurableRuntime(source, controller.signal, { force: true })
          .catch((cause) => {
            if (!cancelled && mountedRef.current) {
              setError(toUserMessage(cause, 'tracks.loadFailed'));
            }
          })
          .finally(() => schedule(30_000));
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [admitDurableRuntime, isOpen, source]);

  const loadMore = useCallback(async () => {
    if (!source || !nextCursor || phase !== 'idle') return;
    if (!isAdmittedVariantSource(source) && !hasVariantPageReceipt(source)) {
      setNextCursor(null);
      setError(
        userMessage(
          'failure.this-saved-mutation-source-must-be-prepared-again-before-more-calls-ca'
        )
      );
      return;
    }
    const controller = beginOperation();
    setError(null);
    setPhase('loading-more');
    try {
      const page = isAdmittedVariantSource(source)
        ? await readAdmittedPage(source, nextCursor, controller.signal)
        : await readVariantPage(
            {
              queryPath: source.queryPath,
              indexPath: source.indexPath,
              references: referenceNames,
              sourceGeneration: source.sourceGeneration,
              queryGeneration: source.queryGeneration,
              indexGeneration: source.indexGeneration,
              assemblyRevision: source.assemblyRevision,
              cursor: nextCursor,
              limit: PAGE_SIZE,
            },
            fetch,
            { signal: controller.signal }
          );
      if (!mountedRef.current || controller.signal.aborted) return;
      setVariants((current) => {
        const byId = new Map(current.map((variant) => [variant.id, variant]));
        for (const variant of page.variants) byId.set(variant.id, variant);
        const merged = [...byId.values()];
        if (merged.length <= MAX_RETAINED_VARIANTS) return merged;
        setTrimmed(true);
        return merged.slice(merged.length - MAX_RETAINED_VARIANTS);
      });
      setNextCursor(page.nextCursor);
      setPhase('idle');
    } catch (cause) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setPhase('idle');
      setError(toUserMessage(cause, 'tracks.loadFailed'));
    }
  }, [beginOperation, nextCursor, phase, readAdmittedPage, referenceNames, source]);

  return {
    isOpen,
    source,
    variants,
    nextCursor,
    selectedVariantId,
    phase,
    error,
    trimmed,
    annotationImpacts,
    isBusy: phase !== 'idle',
    openNavigator,
    closeNavigator,
    chooseSource,
    attachNetworkRequest,
    loadMore,
    selectVariant: setSelectedVariantId,
  };
}

function isNetworkVariantSource(
  source: IndexedGenomeVariantSourceState
): source is IndexedGenomeVariantSourceState & { readonly admittedSource: AdmittedTrackSource } {
  const admitted = source.admittedSource;
  return Boolean(
    admitted?.readerKind === 'variant' &&
    (admitted.input?.kind === 'url' || admitted.request?.source.kind === 'htsget')
  );
}

function isAdmittedVariantSource(
  source: IndexedGenomeVariantSourceState
): source is IndexedGenomeVariantSourceState & { readonly admittedSource: AdmittedTrackSource } {
  return source.admittedSource?.readerKind === 'variant';
}

function requireVariantReceipt(source: IndexedGenomeVariantSourceState): AdmittedTrackSource {
  if (!isAdmittedVariantSource(source)) {
    throw new Error('The saved mutation source has no admission receipt.');
  }
  return source.admittedSource;
}

function readRuntimeVariantPage(
  runtime: VariantTrackRuntime,
  references: ReadonlyArray<VariantReferenceIdentity>,
  cursor: string | null,
  signal: AbortSignal
) {
  if (isLocalVariantRuntime(runtime)) {
    return readVariantPage(
      {
        queryPath: runtime.prepared.queryPath,
        indexPath: runtime.prepared.indexPath,
        references: references.map((reference) => reference.name),
        sourceGeneration: runtime.prepared.sourceGeneration,
        queryGeneration: runtime.prepared.queryGeneration,
        indexGeneration: runtime.prepared.indexGeneration,
        assemblyRevision: runtime.assemblyRevision,
        cursor,
        limit: PAGE_SIZE,
      },
      fetch,
      { signal }
    );
  }
  const input = { runtime, references, cursor, limit: PAGE_SIZE };
  return isHtsgetVariantRuntime(runtime)
    ? readHtsgetVariantPage({ ...input, runtime }, { signal })
    : readRemoteVariantPage({ ...input, runtime }, { signal });
}

function runtimeIsFresh(runtime: VariantTrackRuntime): boolean {
  return (
    isLocalVariantRuntime(runtime) ||
    Date.now() < runtime.grantExpiresAtMs - REMOTE_GRANT_REFRESH_SKEW_MS
  );
}

function runtimeGrantExpiresAt(runtime: VariantTrackRuntime | null): number {
  return runtime && !isLocalVariantRuntime(runtime) ? runtime.grantExpiresAtMs : Date.now();
}

type VariantSourceWithPageReceipt = IndexedGenomeVariantSourceState &
  Required<
    Pick<
      IndexedGenomeVariantSourceState,
      'sourceGeneration' | 'queryGeneration' | 'indexGeneration' | 'assemblyRevision'
    >
  >;

function hasVariantPageReceipt(
  source: IndexedGenomeVariantSourceState
): source is VariantSourceWithPageReceipt {
  return Boolean(
    source.sourceGeneration &&
    source.queryGeneration &&
    source.indexGeneration &&
    source.assemblyRevision
  );
}

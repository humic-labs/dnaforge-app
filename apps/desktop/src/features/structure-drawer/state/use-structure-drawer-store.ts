import { create } from 'zustand';
import type { MolecularCatalogObservation } from '../../../shared/molecular-catalog';
import {
  candidateRowsForResolved,
  deriveResolvedForStructureCandidate,
  findStructureCandidateById,
} from '../api/candidates';
import { withRevision } from '../../../shared/store-revision';
import type {
  ResolverResult,
  ResolverSource,
  StructureDrawerError,
  StructureDrawerRequest,
  StructureDrawerStatus,
  StructureResolver,
} from '../types/structure-drawer';
import { productionStructureResolver } from '../api/production-structure-resolver';
import {
  beginWorkflowAction,
  observeWorkflowAction,
  type WorkflowOperation,
} from '../../../lib/workflow-telemetry';

export type { StructureResolver };

let activeStructureResolver: StructureResolver = productionStructureResolver;

interface StructureDrawerState {
  revision: number;

  requestId: number;

  request: StructureDrawerRequest | null;

  status: StructureDrawerStatus;

  resolved: ResolverResult | null;

  cacheHit: boolean;
  error: StructureDrawerError | null;

  abortController: AbortController | null;

  currentStep: ResolverSource | null;
  previewCandidateId: string | null;
  committedCandidateId: string | null;
  candidatePickerOpen: boolean;

  isSlowLoad: boolean;

  setResolver(resolver: StructureResolver): void;

  open(request: StructureDrawerRequest): Promise<void>;

  openSavedCoordinates(
    request: StructureDrawerRequest,
    candidateId: string,
    coordinates: {
      text: string;
      format: 'pdb' | 'cif';
      coordinateModel?: { blockIndex: number; modelIndex: number };
      catalogProvenance?: MolecularCatalogObservation;
    },
    provenance?: {
      source: 'computed_coordinates' | 'saved_coordinates';
      confidenceNote: string;
      chainId?: string;
    }
  ): void;

  close(): void;

  retry(): Promise<void>;

  handleViewerError(message: string, requestId?: number): void;

  handleViewerSlow(requestId?: number): void;
  previewCandidate(candidateId: string, requestId?: number): void;
  commitCandidate(candidateId: string, requestId?: number): void;
  cancelPreview(): void;
  openCandidatePicker(): void;
  closeCandidatePicker(): void;

  _markRendering(requestId: number, result: ResolverResult, cacheHit: boolean): void;
  _markReady(requestId: number): void;
  _markNoMatch(requestId: number): void;
  _markError(requestId: number, error: StructureDrawerError): void;
}

const INITIAL_STATE = {
  revision: 0,
  requestId: 0,
  request: null,
  status: 'idle' as StructureDrawerStatus,
  resolved: null,
  cacheHit: false,
  error: null,
  abortController: null,
  currentStep: null,
  previewCandidateId: null,
  committedCandidateId: null,
  candidatePickerOpen: false,
  isSlowLoad: false,
};

async function runResolution(
  state: StructureDrawerState,
  set: (partial: Partial<StructureDrawerState>) => void,
  get: () => StructureDrawerState,
  request: StructureDrawerRequest,
  structureResolutionOperations: Map<number, WorkflowOperation>
): Promise<void> {
  state.abortController?.abort();
  structureResolutionOperations.get(state.requestId)?.cancel();
  structureResolutionOperations.delete(state.requestId);

  const newId = state.requestId + 1;
  structureResolutionOperations.set(
    newId,
    beginWorkflowAction({
      workflow: 'structure',
      action: 'open',
    })
  );

  if (request.refusal) {
    set({
      requestId: newId,
      request,
      status: 'error',
      error: request.refusal,
      resolved: null,
      cacheHit: false,
      abortController: null,
      currentStep: null,
      previewCandidateId: null,
      committedCandidateId: null,
      candidatePickerOpen: false,
      isSlowLoad: false,
    });
    structureResolutionOperations.get(newId)?.fail(request.refusal.code, { status: 'failed' });
    structureResolutionOperations.delete(newId);
    return;
  }

  const controller = new AbortController();
  set({
    requestId: newId,
    request,
    status: 'resolving',
    resolved: null,
    cacheHit: false,
    error: null,
    abortController: controller,
    currentStep: null,
    previewCandidateId: null,
    committedCandidateId: null,
    candidatePickerOpen: false,
    isSlowLoad: false,
  });

  try {
    const { result, cacheHit } = await activeStructureResolver(request, controller.signal);

    if (get().requestId !== newId) {
      structureResolutionOperations.get(newId)?.cancel();
      structureResolutionOperations.delete(newId);
      return;
    }

    if (result === null) {
      set({ cacheHit });
      get()._markNoMatch(newId);
      return;
    }
    get()._markRendering(newId, result, cacheHit);
  } catch (err) {
    if (get().requestId !== newId) {
      structureResolutionOperations.get(newId)?.cancel();
      structureResolutionOperations.delete(newId);
      return;
    }
    if ((err as Error).name === 'AbortError') {
      structureResolutionOperations.get(newId)?.cancel();
      structureResolutionOperations.delete(newId);
      return;
    }
    const isProviderError = (err as Error).name === 'SidecarProviderError';
    get()._markError(newId, {
      code: isProviderError ? 'provider_error' : 'resolver_threw',
      message: (err as Error).message ?? 'Resolver failed',
    });
  }
}

export function createStructureDrawerStore() {
  const structureResolutionOperations = new Map<number, WorkflowOperation>();
  const advanceViewerOperation = (previousId: number, nextId: number): WorkflowOperation => {
    const pending = structureResolutionOperations.get(previousId);
    structureResolutionOperations.delete(previousId);
    const operation = pending ?? beginWorkflowAction({ workflow: 'structure', action: 'view' });
    structureResolutionOperations.set(nextId, operation);
    return operation;
  };
  return create<StructureDrawerState>()(
    withRevision((set, get) => ({
      ...INITIAL_STATE,

      setResolver(resolver) {
        if (typeof resolver !== 'function') {
          throw new TypeError('Structure resolver override must be callable');
        }
        activeStructureResolver = resolver;

        set({});
      },

      async open(request) {
        const state = get();

        if (
          state.status === 'ready' &&
          state.request !== null &&
          requestBailoutKey(state.request) === requestBailoutKey(request) &&
          JSON.stringify(state.request.skipSteps ?? []) === JSON.stringify(request.skipSteps ?? [])
        ) {
          if (request.variantContext || state.request.variantContext) {
            set({ request, requestId: state.requestId + 1 });
          }
          observeWorkflowAction({
            workflow: 'structure',
            action: 'view',
            status: 'ready',
            cached: state.cacheHit,
            phase: 'result',
          });
          return;
        }
        await runResolution(state, set, get, request, structureResolutionOperations);
      },

      openSavedCoordinates(request, candidateId, coordinates, provenance) {
        const state = get();
        const structure = state.resolved?.structure;
        if (
          state.request &&
          requestBailoutKey(state.request) === requestBailoutKey(request) &&
          structure?.kind === 'data' &&
          structure.data === coordinates.text &&
          structure.format === coordinates.format &&
          JSON.stringify(structure.coordinateModel) ===
            JSON.stringify(coordinates.coordinateModel) &&
          JSON.stringify(structure.labelAsymIds ?? []) ===
            JSON.stringify(provenance?.chainId ? [provenance.chainId] : []) &&
          (state.status === 'ready' || state.status === 'rendering')
        ) {
          if (state.request !== request) {
            const nextId = state.requestId + 1;
            advanceViewerOperation(state.requestId, nextId);
            set({
              request,
              committedCandidateId: candidateId,
              requestId: nextId,
              status: 'rendering',
            });
          } else if (state.committedCandidateId !== candidateId) {
            set({ committedCandidateId: candidateId });
          }
          return;
        }
        state.abortController?.abort();
        structureResolutionOperations.get(state.requestId)?.cancel();
        structureResolutionOperations.delete(state.requestId);
        const nextId = state.requestId + 1;
        structureResolutionOperations.set(
          nextId,
          beginWorkflowAction({ workflow: 'structure', action: 'view' })
        );
        set({
          ...INITIAL_STATE,
          requestId: nextId,
          request,
          status: 'rendering',
          committedCandidateId: candidateId,
          resolved: {
            source: provenance?.source ?? 'saved_coordinates',
            identity: 0,
            structure: {
              kind: 'data',
              format: coordinates.format,
              data: coordinates.text,
              coordinateModel: coordinates.coordinateModel,
              catalogProvenance: coordinates.catalogProvenance,
              ...(provenance?.chainId ? { labelAsymIds: [provenance.chainId] } : {}),
            },
            confidenceNote:
              provenance?.confidenceNote ??
              'Saved coordinate snapshot; residue mapping is checked against the reference protein.',
          },
        });
      },

      close() {
        const state = get();
        state.abortController?.abort();
        structureResolutionOperations.get(state.requestId)?.cancel();
        structureResolutionOperations.delete(state.requestId);
        set({
          ...INITIAL_STATE,

          requestId: state.requestId + 1,
        });
      },

      async retry() {
        const state = get();
        if (state.status !== 'error' || !state.request || state.request.refusal) return;
        const skipSteps = state.error?.failedStep
          ? [...(state.request.skipSteps ?? []), state.error.failedStep]
          : state.request.skipSteps;
        await runResolution(
          state,
          set,
          get,
          { ...state.request, skipSteps },
          structureResolutionOperations
        );
      },

      handleViewerError(message: string, requestId?: number) {
        const state = get();
        if (requestId !== undefined && requestId !== state.requestId) return;
        const resolved = state.resolved;

        if (isLargeComplexViewerFailure(message)) {
          state._markError(state.requestId, {
            code: 'large_complex',
            message,
            failedStep: resolved?.source,
          });
          if (resolved && candidateRowsForResolved(resolved).length > 1) {
            set({ candidatePickerOpen: true, previewCandidateId: null, isSlowLoad: false });
          }
          return;
        }

        const candidateAlternates = resolved
          ? candidateRowsForResolved(resolved).length > 1
          : false;

        if (candidateAlternates) {
          state._markError(state.requestId, {
            code: 'viewer_error',
            message,
            failedStep: resolved?.source,
          });
          set({ candidatePickerOpen: true, previewCandidateId: null, isSlowLoad: false });
          return;
        }

        if (!resolved || resolved.structure.kind !== 'pdb') {
          state._markError(state.requestId, {
            code: 'viewer_error',
            message,
            failedStep: resolved?.source,
          });
          return;
        }

        const fallback = resolved.structure.uniprotFallback;
        if (!fallback) {
          state._markError(state.requestId, {
            code: 'viewer_error',
            message,
            failedStep: resolved.source,
          });
          return;
        }
        const fallbackCandidate =
          resolved.candidates?.find(
            (candidate) =>
              candidate.provider === 'alphafold' &&
              candidate.structure.kind === 'uniprot' &&
              candidate.structure.accession.toUpperCase() === fallback.accession.toUpperCase()
          ) ?? null;
        const baseFallback = fallbackCandidate
          ? deriveResolvedForStructureCandidate(resolved, fallbackCandidate)
          : {
              ...resolved,
              recommendedCandidateId: null,
              structure: { kind: 'uniprot' as const, accession: fallback.accession },
            };
        const swapped: ResolverResult = {
          ...baseFallback,
          recommendedCandidateId:
            fallbackCandidate?.id ?? baseFallback.recommendedCandidateId ?? undefined,
          confidenceNote:
            `${resolved.confidenceNote ?? ''} · fell back to AlphaFold after ${resolved.structure.pdbId} failed to render`.trim(),
        };

        state._markRendering(state.requestId, swapped, state.cacheHit);
        const fallbackCommit = fallbackCandidate ?? candidateRowsForResolved(swapped)[0] ?? null;
        if (fallbackCommit && get().requestId === state.requestId) {
          set({
            committedCandidateId: fallbackCommit.id,
            previewCandidateId: null,
            candidatePickerOpen: false,
            isSlowLoad: false,
            resolved: deriveResolvedForStructureCandidate(swapped, fallbackCommit),
          });
        }
      },

      handleViewerSlow(requestId) {
        const state = get();
        if (requestId !== undefined && requestId !== state.requestId) return;
        if (state.status !== 'rendering') return;
        if (state.isSlowLoad) return;
        set({ isSlowLoad: true });
      },

      previewCandidate(candidateId, requestId) {
        const state = get();
        if (requestId !== undefined && requestId !== state.requestId) return;
        if (!findStructureCandidateById(state.resolved, candidateId)) return;
        set({ previewCandidateId: candidateId });
      },

      commitCandidate(candidateId, requestId) {
        const state = get();
        if (requestId !== undefined && requestId !== state.requestId) return;
        const candidate = findStructureCandidateById(state.resolved, candidateId);
        if (!candidate || !state.resolved) return;
        const shouldRemount =
          state.committedCandidateId !== candidate.id || state.status === 'error';
        const nextId = shouldRemount ? state.requestId + 1 : state.requestId;
        if (shouldRemount) advanceViewerOperation(state.requestId, nextId);
        set({
          requestId: nextId,
          status: shouldRemount ? 'rendering' : state.status,
          committedCandidateId: candidate.id,
          previewCandidateId: null,
          candidatePickerOpen: false,
          error: null,
          resolved: deriveResolvedForStructureCandidate(state.resolved, candidate),
        });
        observeWorkflowAction({
          workflow: 'structure',
          action: 'commit',
          status: 'selected',
          operationId: structureResolutionOperations.get(nextId)?.actionId,
        });
      },

      cancelPreview() {
        set({ previewCandidateId: null, candidatePickerOpen: false });
      },

      openCandidatePicker() {
        set({ candidatePickerOpen: true });
      },

      closeCandidatePicker() {
        set({ previewCandidateId: null, candidatePickerOpen: false });
      },

      _markRendering(requestId, result, cacheHit) {
        if (get().requestId !== requestId) return;
        const candidates = candidateRowsForResolved(result);
        const previewCandidateId =
          candidates.find((candidate) => candidate.id === result.recommendedCandidateId)?.id ??
          candidates[0]?.id ??
          null;
        set({
          status: 'rendering',
          resolved: result,
          cacheHit,
          currentStep: result.source,
          error: null,
          isSlowLoad: false,
          committedCandidateId: null,
          previewCandidateId,
          candidatePickerOpen: candidates.length > 0,
        });
      },

      _markReady(requestId) {
        const state = get();
        if (state.requestId !== requestId || state.status === 'error') return;
        set({ status: 'ready', isSlowLoad: false });
        structureResolutionOperations.get(requestId)?.complete({
          resultCount: state.resolved ? candidateRowsForResolved(state.resolved).length : 0,
          status: 'ready',
          cached: state.cacheHit,
          stateRevision: state.revision + 1,
        });
        structureResolutionOperations.delete(requestId);
      },

      _markNoMatch(requestId) {
        if (get().requestId !== requestId) return;
        const state = get();
        set({
          status: 'no_match',
          resolved: null,
          currentStep: null,
          previewCandidateId: null,
          committedCandidateId: null,
          candidatePickerOpen: false,
          isSlowLoad: false,
        });
        structureResolutionOperations.get(requestId)?.complete({
          resultCount: 0,
          status: 'no_match',
          cached: state.cacheHit,
          stateRevision: state.revision + 1,
        });
        structureResolutionOperations.delete(requestId);
      },

      _markError(requestId, error) {
        const state = get();
        if (state.requestId !== requestId) return;
        set({ status: 'error', error, isSlowLoad: false });
        structureResolutionOperations.get(requestId)?.fail(error.code, {
          status: 'failed',
          stateRevision: state.revision + 1,
        });
        structureResolutionOperations.delete(requestId);
      },
    }))
  );
}

export const useStructureDrawerStore = createStructureDrawerStore();

export function isLargeComplexViewerFailure(message: string): boolean {
  const lower = message.toLowerCase();

  return (
    lower.includes('hard ceiling') ||
    lower.includes('structure load timeout') ||
    lower.includes('out of memory') ||
    /\boom\b/.test(lower)
  );
}

function requestBailoutKey(request: StructureDrawerRequest | null): string | null {
  if (!request) return null;
  return JSON.stringify({
    translation: request.translation,
    moleculeType: request.moleculeType ?? 'protein',
    proteinIdentityKey: request.proteinIdentity?.sequence.identityKey ?? null,
    identityRequestKey: request.identityRequestKey ?? null,
    entityId: request.entityId ?? null,
    hints: stableRequestKeyPart(request.hints),
  });
}

function stableRequestKeyPart(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableRequestKeyPart);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, stableRequestKeyPart(record[key])])
    );
  }
  return value ?? null;
}

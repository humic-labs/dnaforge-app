import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createStructureDrawerStore,
  useStructureDrawerStore,
  type StructureResolver,
} from './use-structure-drawer-store';
import { productionStructureResolver } from '../api/production-structure-resolver';
import type {
  ResolverResult,
  StructureCandidate,
  StructureDrawerRequest,
} from '../types/structure-drawer';

const PDB_RESULT: ResolverResult = {
  source: 'pdb_xref',
  identity: 1,
  structure: { kind: 'pdb', pdbId: '1TUP' },
};

const UNIPROT_RESULT: ResolverResult = {
  source: 'uniprot_xref',
  identity: 1,
  structure: { kind: 'uniprot', accession: 'P00000' },
};

const PDB_CANDIDATE: StructureCandidate = {
  id: 'rcsb:1RBL:all',
  provider: 'pdb',
  structure: { kind: 'pdb', pdbId: '1RBL' },
  label: '1RBL',
  group: 'rcsb',
  rank: 0,
  metadata: { pdbId: '1RBL', resolution: 2.2 },
  provenance: { resolverSource: 'protein_sequence', identity: 1 },
};

const AFDB_CANDIDATE: StructureCandidate = {
  id: 'alphafold:P00880:all',
  provider: 'alphafold',
  structure: { kind: 'uniprot', accession: 'P00880' },
  label: 'P00880',
  group: 'alphafold',
  rank: 1,
  metadata: { uniprotAccession: 'P00880', meanPlddt: 91.4 },
  provenance: { resolverSource: 'protein_sequence', identity: 1 },
};

const CANDIDATE_RESULT: ResolverResult = {
  source: 'protein_sequence',
  identity: 1,
  structure: PDB_CANDIDATE.structure,
  recommendedCandidateId: PDB_CANDIDATE.id,
  candidates: [PDB_CANDIDATE, AFDB_CANDIDATE],
};

function makeRequest(overrides: Partial<StructureDrawerRequest> = {}): StructureDrawerRequest {
  return {
    translation: 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNV',
    cdsLabel: 'TP53',
    hints: { dbXrefs: ['PDB:1TUP'] },
    ...overrides,
  };
}

function fakeResolver(
  result: ResolverResult | null,
  options: { cacheHit?: boolean; delayMs?: number; observeSignal?: AbortSignal[] } = {}
): StructureResolver {
  return async (_req, signal) => {
    if (options.observeSignal) options.observeSignal.push(signal);
    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, options.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      });
    }
    return { result, cacheHit: options.cacheHit ?? false };
  };
}

describe('useStructureDrawerStore', () => {
  it('isolates pane requests and cancellation from other panes and the ordinary drawer', async () => {
    const first = createStructureDrawerStore();
    const second = createStructureDrawerStore();
    const signals: AbortSignal[] = [];
    useStructureDrawerStore
      .getState()
      .setResolver(fakeResolver(PDB_RESULT, { observeSignal: signals }));
    await first.getState().open(makeRequest({ entityId: 'first' }));
    await second.getState().open(makeRequest({ entityId: 'second' }));
    first.getState().close();
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(second.getState().status).toBe('rendering');
    expect(second.getState().request?.entityId).toBe('second');
    expect(useStructureDrawerStore.getState().status).toBe('idle');
    second.getState()._markReady(second.getState().requestId);
    expect(second.getState().status).toBe('ready');
    second.getState().close();
  });

  beforeEach(() => {
    useStructureDrawerStore.getState().setResolver(productionStructureResolver);
    useStructureDrawerStore.setState({
      requestId: 0,
      request: null,
      status: 'idle',
      resolved: null,
      cacheHit: false,
      error: null,
      abortController: null,
      currentStep: null,
      previewCandidateId: null,
      committedCandidateId: null,
      candidatePickerOpen: false,
    });
  });

  describe('initial state', () => {
    it('starts idle with the application resolver outside mutable store state', () => {
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('idle');
      expect(s.request).toBeNull();
      expect(s.resolved).toBeNull();
      expect(s.requestId).toBe(0);
      expect(s).not.toHaveProperty('_resolver');
    });

    it('rejects a non-callable override without replacing the active resolver', async () => {
      const resolver = fakeResolver(PDB_RESULT);
      useStructureDrawerStore.getState().setResolver(resolver);

      expect(() =>
        useStructureDrawerStore.getState().setResolver(null as unknown as StructureResolver)
      ).toThrow('Structure resolver override must be callable');

      await useStructureDrawerStore.getState().open(makeRequest());
      expect(useStructureDrawerStore.getState().resolved).toBe(PDB_RESULT);
    });

    it('exposes a numeric .revision field (per-store-invariants)', () => {
      expect(typeof useStructureDrawerStore.getState().revision).toBe('number');
    });
  });

  describe('happy path: idle → resolving → rendering → ready', () => {
    it('open() publishes resolving synchronously so the drawer can appear before hits load', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT, { delayMs: 30 }));

      const opening = useStructureDrawerStore.getState().open(makeRequest());

      expect(useStructureDrawerStore.getState()).toMatchObject({
        status: 'resolving',
        request: makeRequest(),
        resolved: null,
      });
      await opening;
    });

    it('open() with a hit transitions to rendering with the resolved result', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('rendering');
      expect(s.resolved).toEqual(PDB_RESULT);
      expect(s.currentStep).toBe('pdb_xref');
      expect(s.cacheHit).toBe(false);
    });

    it('initializes candidate results as uncommitted with the recommendation previewed', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const s = useStructureDrawerStore.getState();
      expect(s.committedCandidateId).toBeNull();
      expect(s.previewCandidateId).toBe('rcsb:1RBL:all');
      expect(s.candidatePickerOpen).toBe(true);
      expect(s.resolved?.structure).toEqual(PDB_CANDIDATE.structure);
    });

    it('previewing a candidate before selection does not commit the structure bridge', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      useStructureDrawerStore.getState().previewCandidate('alphafold:P00880:all');
      const s = useStructureDrawerStore.getState();
      expect(s.previewCandidateId).toBe('alphafold:P00880:all');
      expect(s.committedCandidateId).toBeNull();
      expect(s.resolved?.structure).toEqual(PDB_CANDIDATE.structure);
    });

    it('committing the currently poster-previewed candidate starts the interactive viewer load', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const initialRequestId = useStructureDrawerStore.getState().requestId;
      useStructureDrawerStore.getState().openCandidatePicker();
      useStructureDrawerStore.getState().previewCandidate('alphafold:P00880:all');
      useStructureDrawerStore.getState().commitCandidate('alphafold:P00880:all');
      const s = useStructureDrawerStore.getState();
      expect(s.requestId).toBe(initialRequestId + 1);
      expect(s.status).toBe('rendering');
      expect(s.committedCandidateId).toBe('alphafold:P00880:all');
      expect(s.previewCandidateId).toBeNull();
      expect(s.candidatePickerOpen).toBe(false);
      expect(s.resolved?.structure).toEqual(AFDB_CANDIDATE.structure);
    });

    it('committing a non-previewed candidate remounts so stale callbacks are isolated', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const initialRequestId = useStructureDrawerStore.getState().requestId;
      expect(useStructureDrawerStore.getState().previewCandidateId).toBe('rcsb:1RBL:all');

      useStructureDrawerStore.getState().commitCandidate('alphafold:P00880:all');

      const s = useStructureDrawerStore.getState();
      expect(s.requestId).toBe(initialRequestId + 1);
      expect(s.status).toBe('rendering');
      expect(s.committedCandidateId).toBe('alphafold:P00880:all');
      expect(s.resolved?.structure).toEqual(AFDB_CANDIDATE.structure);
    });

    it('candidate commits reject stale Molstar load and error callbacks from the previous viewer', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const oldRequestId = useStructureDrawerStore.getState().requestId;

      useStructureDrawerStore.getState().commitCandidate('alphafold:P00880:all');
      const newRequestId = useStructureDrawerStore.getState().requestId;

      useStructureDrawerStore.getState()._markReady(oldRequestId);
      expect(useStructureDrawerStore.getState().status).toBe('rendering');

      useStructureDrawerStore.getState().handleViewerError('old viewer failed', oldRequestId);
      expect(useStructureDrawerStore.getState().status).toBe('rendering');
      expect(useStructureDrawerStore.getState().error).toBeNull();

      useStructureDrawerStore.getState()._markReady(newRequestId);
      expect(useStructureDrawerStore.getState().status).toBe('ready');
    });

    it('invalid and stale candidate actions are no-ops', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState().previewCandidate('missing');
      useStructureDrawerStore.getState().commitCandidate('alphafold:P00880:all', requestId + 1);
      const s = useStructureDrawerStore.getState();
      expect(s.previewCandidateId).toBe('rcsb:1RBL:all');
      expect(s.committedCandidateId).toBeNull();
      expect(s.resolved?.structure).toEqual(PDB_CANDIDATE.structure);
    });

    it('cacheHit flag flows through from the resolver', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT, { cacheHit: true }));
      await useStructureDrawerStore.getState().open(makeRequest());
      expect(useStructureDrawerStore.getState().cacheHit).toBe(true);
    });

    it('_markReady transitions rendering → ready', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);
      expect(useStructureDrawerStore.getState().status).toBe('ready');
    });

    it('_markReady cannot revive an errored drawer for the same request', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const { requestId } = useStructureDrawerStore.getState();

      useStructureDrawerStore.getState()._markError(requestId, {
        message: 'Molstar canvas did not paint before reveal',
        failedStep: 'pdb_xref',
      });
      expect(useStructureDrawerStore.getState().status).toBe('error');

      useStructureDrawerStore.getState()._markReady(requestId);
      expect(useStructureDrawerStore.getState().status).toBe('error');
      expect(useStructureDrawerStore.getState().error?.message).toBe(
        'Molstar canvas did not paint before reveal'
      );
    });
  });

  describe('no-match path', () => {
    it('resolver returning null transitions to no_match', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(null));
      await useStructureDrawerStore.getState().open(makeRequest());
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('no_match');
      expect(s.resolved).toBeNull();
      expect(s.currentStep).toBeNull();
    });
  });

  describe('error path', () => {
    it('resolver throwing (non-abort) transitions to error', async () => {
      useStructureDrawerStore.getState().setResolver(async () => {
        throw new Error('rest.uniprot.org timed out');
      });
      await useStructureDrawerStore.getState().open(makeRequest());
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error?.code).toBe('resolver_threw');
      expect(s.error?.message).toContain('uniprot');
    });

    it('_markError records failedStep so retry can skip it', () => {
      useStructureDrawerStore.setState({
        requestId: 5,
        status: 'rendering',
        request: makeRequest(),
        resolved: PDB_RESULT,
      });
      useStructureDrawerStore.getState()._markError(5, {
        code: 'molstar_failed',
        message: 'Could not parse 1TUP',
        failedStep: 'pdb_xref',
      });
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error?.failedStep).toBe('pdb_xref');
    });
  });

  describe('retry()', () => {
    it('retry skips the failed step', async () => {
      let callCount = 0;
      const seenSkips: (readonly string[] | undefined)[] = [];
      const resolver: StructureResolver = async (req) => {
        callCount += 1;
        seenSkips.push(req.skipSteps as readonly string[] | undefined);
        if (callCount === 1) {
          return { result: PDB_RESULT, cacheHit: false };
        }
        return { result: UNIPROT_RESULT, cacheHit: false };
      };
      useStructureDrawerStore.getState().setResolver(resolver);
      await useStructureDrawerStore.getState().open(makeRequest());

      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markError(requestId, {
        code: 'molstar_failed',
        message: '1TUP not found in RCSB',
        failedStep: 'pdb_xref',
      });

      await useStructureDrawerStore.getState().retry();

      expect(callCount).toBe(2);
      expect(seenSkips[1]).toEqual(['pdb_xref']);
      expect(useStructureDrawerStore.getState().resolved).toEqual(UNIPROT_RESULT);
    });

    it('retry no-ops when status is not error', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const before = useStructureDrawerStore.getState().requestId;
      await useStructureDrawerStore.getState().retry();
      expect(useStructureDrawerStore.getState().requestId).toBe(before);
    });
  });

  describe('concurrency: stale responses drop', () => {
    it('a slow first request is silently dropped when a second open() lands', async () => {
      const signals: AbortSignal[] = [];
      const slowResolver = fakeResolver(PDB_RESULT, { delayMs: 50, observeSignal: signals });
      const fastResolver = fakeResolver(UNIPROT_RESULT);

      useStructureDrawerStore.getState().setResolver(slowResolver);
      const slowOpen = useStructureDrawerStore.getState().open(makeRequest());

      useStructureDrawerStore.getState().setResolver(fastResolver);
      await useStructureDrawerStore.getState().open(makeRequest({ translation: 'DIFFERENT' }));

      await slowOpen;

      const s = useStructureDrawerStore.getState();
      expect(s.resolved).toEqual(UNIPROT_RESULT);
      expect(signals[0]?.aborted).toBe(true);
    });
  });

  describe('bail-out short-circuit', () => {
    it('reopens cached protein context for another mutation without resolving again', async () => {
      const resolver = vi.fn(fakeResolver(PDB_RESULT));
      useStructureDrawerStore.getState().setResolver(resolver);
      const req = makeRequest();
      await useStructureDrawerStore.getState().open(req);
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);
      const variantContext = {
        trackId: 'clone-7',
        trackLabel: 'Clone 7',
        mutationId: 'mut-5',
        position: 5,
        referenceBase: 'A',
        alternateBase: 'G',
        residueIndices: [1],
      };
      await useStructureDrawerStore.getState().open({ ...req, variantContext });
      expect(useStructureDrawerStore.getState()).toMatchObject({
        status: 'ready',
        requestId: requestId + 1,
        resolved: PDB_RESULT,
        request: { variantContext },
      });
      await useStructureDrawerStore.getState().open({
        ...req,
        variantContext: {
          ...variantContext,
          mutationId: 'mut-8',
          position: 8,
          residueIndices: [2],
        },
      });
      expect(useStructureDrawerStore.getState().request?.variantContext?.residueIndices).toEqual([
        2,
      ]);
      expect(useStructureDrawerStore.getState().requestId).toBe(requestId + 2);
      await useStructureDrawerStore.getState().open(req);
      expect(useStructureDrawerStore.getState().request?.variantContext).toBeUndefined();
      expect(resolver).toHaveBeenCalledTimes(1);
    });

    it('open() with same translation while ready is a no-op', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      const req = makeRequest();
      await useStructureDrawerStore.getState().open(req);
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);

      await useStructureDrawerStore.getState().open(req);
      expect(useStructureDrawerStore.getState().requestId).toBe(requestId);
    });

    it('open() with same translation while resolving is NOT short-circuited', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT, { delayMs: 30 }));
      const req = makeRequest();
      const first = useStructureDrawerStore.getState().open(req);
      const second = useStructureDrawerStore.getState().open(req);
      await Promise.allSettled([first, second]);
      expect(useStructureDrawerStore.getState().requestId).toBe(2);
    });

    it('open() with same translation but different skipSteps re-resolves', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      const req = makeRequest();
      await useStructureDrawerStore.getState().open(req);
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);

      await useStructureDrawerStore.getState().open({ ...req, skipSteps: ['pdb_xref'] });
      expect(useStructureDrawerStore.getState().requestId).toBe(requestId + 1);
    });

    it('open() with same translation but different identityRequestKey re-resolves', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      const req = makeRequest({
        identityRequestKey: 'req:feature:v2:left:protein-sequence:v2:shared',
      });
      await useStructureDrawerStore.getState().open(req);
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);

      await useStructureDrawerStore.getState().open({
        ...req,
        identityRequestKey: 'req:feature:v2:right:protein-sequence:v2:shared',
      });

      expect(useStructureDrawerStore.getState().requestId).toBe(requestId + 1);
    });

    it('open() with same identityRequestKey but different hints re-resolves', async () => {
      const seenRequests: StructureDrawerRequest[] = [];
      const resolver: StructureResolver = async (req) => {
        seenRequests.push(req);
        return { result: seenRequests.length === 1 ? PDB_RESULT : UNIPROT_RESULT, cacheHit: false };
      };
      useStructureDrawerStore.getState().setResolver(resolver);
      const req = makeRequest({
        identityRequestKey: 'req:feature:v2:shared:protein-sequence:v2:digest',
        hints: { dbXrefs: ['PDB:1RBL', 'UniProtKB:P00880'] },
      });
      await useStructureDrawerStore.getState().open(req);
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);

      await useStructureDrawerStore.getState().open({
        ...req,
        hints: { dbXrefs: ['UniProtKB:P00880'] },
      });

      expect(seenRequests).toHaveLength(2);
      expect(useStructureDrawerStore.getState().requestId).toBe(requestId + 1);
      expect(useStructureDrawerStore.getState().resolved).toEqual(UNIPROT_RESULT);
    });

    it('open() with same translation but different identity hints re-resolves', async () => {
      const seenRequests: StructureDrawerRequest[] = [];
      const resolver: StructureResolver = async (req) => {
        seenRequests.push(req);
        return {
          result: seenRequests.length === 1 ? PDB_RESULT : UNIPROT_RESULT,
          cacheHit: false,
        };
      };
      useStructureDrawerStore.getState().setResolver(resolver);
      const first = makeRequest({
        hints: { dbXrefs: ['UniProtKB:P0AB96'], geneName: 'arsC' },
      });
      await useStructureDrawerStore.getState().open(first);
      const { requestId } = useStructureDrawerStore.getState();
      useStructureDrawerStore.getState()._markReady(requestId);

      await useStructureDrawerStore.getState().open({
        ...first,
        hints: { dbXrefs: ['UniProtKB:P0A9Q1'], geneName: 'arcA' },
      });

      expect(seenRequests).toHaveLength(2);
      expect(seenRequests[1]?.hints).toEqual({
        dbXrefs: ['UniProtKB:P0A9Q1'],
        geneName: 'arcA',
      });
      expect(useStructureDrawerStore.getState().requestId).toBe(requestId + 1);
      expect(useStructureDrawerStore.getState().resolved).toEqual(UNIPROT_RESULT);
    });
  });

  describe('handleViewerSlow() —  non-fatal soft timeout', () => {
    it('stays in rendering and sets isSlowLoad for the current request', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        requestId: 42,
        isSlowLoad: false,
      });
      useStructureDrawerStore.getState().handleViewerSlow(42);
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('rendering');
      expect(s.isSlowLoad).toBe(true);
    });

    it('ignores stale requestIds and is idempotent', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        requestId: 7,
        isSlowLoad: false,
      });
      useStructureDrawerStore.getState().handleViewerSlow(6);
      expect(useStructureDrawerStore.getState().isSlowLoad).toBe(false);

      useStructureDrawerStore.getState().handleViewerSlow(7);
      expect(useStructureDrawerStore.getState().isSlowLoad).toBe(true);
      useStructureDrawerStore.getState().handleViewerSlow(7);
      expect(useStructureDrawerStore.getState().isSlowLoad).toBe(true);
    });
  });

  describe('handleViewerError() — Mol* load failure recovery', () => {
    it('codes hard-ceiling hangs as large_complex', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: CANDIDATE_RESULT,
        currentStep: 'protein_sequence',
        requestId: 3,
        committedCandidateId: PDB_CANDIDATE.id,
      });
      useStructureDrawerStore
        .getState()
        .handleViewerError('Structure load timeout - took longer than the hard ceiling', 3);
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error?.code).toBe('large_complex');
      expect(s.isSlowLoad).toBe(false);
    });

    it('keeps HTTP 413 Content Too Large as viewer_error (not large_complex)', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: CANDIDATE_RESULT,
        currentStep: 'protein_sequence',
        requestId: 4,
        committedCandidateId: PDB_CANDIDATE.id,
      });
      useStructureDrawerStore
        .getState()
        .handleViewerError('Failed to fetch structure bytes: 413 Content Too Large', 4);
      expect(useStructureDrawerStore.getState().error?.code).toBe('viewer_error');
    });

    it('routes to _markError when there is no resolved result', () => {
      useStructureDrawerStore.getState().handleViewerError('boom');
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error?.message).toBe('boom');
    });

    it('routes to _markError for kind:uniprot resolutions (no PDB fallback path applies)', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: UNIPROT_RESULT,
        currentStep: 'uniprot_xref',
      });
      useStructureDrawerStore.getState().handleViewerError('afdb 503');
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error?.failedStep).toBe('uniprot_xref');
    });

    it('routes to _markError for kind:pdb without a uniprotFallback (legacy curated PDB xref)', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: PDB_RESULT,
        currentStep: 'pdb_xref',
      });
      useStructureDrawerStore.getState().handleViewerError('rcsb 404');
      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error?.failedStep).toBe('pdb_xref');
    });

    it('keeps candidate choices open when the selected PDB bytes fail to load', () => {
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: CANDIDATE_RESULT,
        currentStep: 'protein_sequence',
        requestId: 9,
        committedCandidateId: PDB_CANDIDATE.id,
        candidatePickerOpen: false,
      });

      useStructureDrawerStore
        .getState()
        .handleViewerError('Failed to fetch structure bytes: 413 Content Too Large', 9);

      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toEqual({
        code: 'viewer_error',
        message: 'Failed to fetch structure bytes: 413 Content Too Large',
        failedStep: 'protein_sequence',
      });
      expect(s.resolved?.candidates).toEqual(CANDIDATE_RESULT.candidates);
      expect(s.committedCandidateId).toBe(PDB_CANDIDATE.id);
      expect(s.previewCandidateId).toBeNull();
      expect(s.candidatePickerOpen).toBe(true);

      useStructureDrawerStore.getState().commitCandidate(AFDB_CANDIDATE.id);

      expect(useStructureDrawerStore.getState().status).toBe('rendering');
      expect(useStructureDrawerStore.getState().committedCandidateId).toBe(AFDB_CANDIDATE.id);
      expect(useStructureDrawerStore.getState().candidatePickerOpen).toBe(false);
      expect(useStructureDrawerStore.getState().resolved?.candidates).toEqual(
        CANDIDATE_RESULT.candidates
      );
      expect(useStructureDrawerStore.getState().resolved?.structure).toEqual(
        AFDB_CANDIDATE.structure
      );
    });

    it('does not collapse a multi-candidate PDB result into its AlphaFold fallback on 413', () => {
      const pdbWithFallback: StructureCandidate = {
        ...PDB_CANDIDATE,
        structure: {
          kind: 'pdb',
          pdbId: '2A6S',
          uniprotFallback: { accession: 'P69348' },
        },
      };
      const afCandidate: StructureCandidate = {
        ...AFDB_CANDIDATE,
        id: 'alphafold:AF:P69348:F1:V6:MODEL:AF-P69348-F1-model_v6:all',
        structure: {
          kind: 'uniprot',
          accession: 'P69348',
          providerIdentityKey: 'AF:P69348:F1:V6:MODEL:AF-P69348-F1-model_v6',
          fragment: 'F1',
          version: 'V6',
          modelId: 'AF-P69348-F1-model_v6',
        },
        label: 'P69348',
        metadata: { uniprotAccession: 'P69348', meanPlddt: 86.7 },
      };
      const result: ResolverResult = {
        source: 'protein_sequence',
        identity: 1,
        structure: pdbWithFallback.structure,
        recommendedCandidateId: pdbWithFallback.id,
        candidates: [pdbWithFallback, afCandidate],
      };
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: result,
        currentStep: 'protein_sequence',
        requestId: 11,
        committedCandidateId: pdbWithFallback.id,
        candidatePickerOpen: false,
      });

      useStructureDrawerStore
        .getState()
        .handleViewerError('Failed to fetch structure bytes: 413 Content Too Large', 11);

      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toMatchObject({
        code: 'viewer_error',
        failedStep: 'protein_sequence',
      });
      expect(s.resolved?.structure).toEqual(pdbWithFallback.structure);
      expect(s.resolved?.candidates).toEqual(result.candidates);
      expect(s.committedCandidateId).toBe(pdbWithFallback.id);
      expect(s.previewCandidateId).toBeNull();
      expect(s.candidatePickerOpen).toBe(true);
    });

    it(': hard-ceiling hang does not silent-AFDB-swap when uniprotFallback exists', () => {
      const PREFER_PDB_RESULT: ResolverResult = {
        source: 'protein_sequence',
        identity: 1.0,
        structure: {
          kind: 'pdb',
          pdbId: '1XYZ',
          uniprotFallback: { accession: 'P03817' },
        },
        confidenceNote: 'Experimental structure 1XYZ · exact protein-sequence match',
      };
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: PREFER_PDB_RESULT,
        currentStep: 'protein_sequence',
        cacheHit: false,
        requestId: 7,
      });

      useStructureDrawerStore
        .getState()
        .handleViewerError('Structure load timeout - took longer than the hard ceiling');

      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toMatchObject({
        code: 'large_complex',
        failedStep: 'protein_sequence',
      });
      expect(s.resolved?.structure).toEqual(PREFER_PDB_RESULT.structure);
    });

    it('swaps to AFDB without re-running the chain when a prefer-PDB result has uniprotFallback', () => {
      const PREFER_PDB_RESULT: ResolverResult = {
        source: 'protein_sequence',
        identity: 1.0,
        structure: {
          kind: 'pdb',
          pdbId: '1XYZ',
          uniprotFallback: { accession: 'P03817' },
        },
        confidenceNote: 'Experimental structure 1XYZ · exact protein-sequence match',
      };
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: PREFER_PDB_RESULT,
        currentStep: 'protein_sequence',
        cacheHit: false,
        requestId: 7,
      });

      useStructureDrawerStore.getState().handleViewerError('mol* parse error');

      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('rendering');
      expect(s.resolved?.structure).toEqual({
        kind: 'uniprot',
        accession: 'P03817',
      });
      expect(s.resolved?.confidenceNote).toMatch(/fell back to AlphaFold/);
      expect(s.resolved?.confidenceNote).toMatch(/1XYZ/);
      expect(s.resolved?.source).toBe('protein_sequence');
      expect(s.error).toBeNull();
    });

    it('committing a candidate from an error state remounts the viewer even if it was previewed', () => {
      const afCandidate: StructureCandidate = {
        id: 'alphafold:AF:P03817:F1:V6:MODEL:AF-P03817-F1-model_v6:all',
        provider: 'alphafold',
        structure: {
          kind: 'uniprot',
          accession: 'P03817',
          providerIdentityKey: 'AF:P03817:F1:V6:MODEL:AF-P03817-F1-model_v6',
          fragment: 'F1',
          version: 'V6',
          modelId: 'AF-P03817-F1-model_v6',
        },
        label: 'P03817',
        group: 'alphafold',
        rank: 1,
        metadata: { uniprotAccession: 'P03817', meanPlddt: 92.4 },
        provenance: {
          resolverSource: 'protein_sequence',
          identity: 1,
          structureIdentity: {
            kind: 'alphafold',
            providerIdentityKey: 'AF:P03817:F1:V6:MODEL:AF-P03817-F1-model_v6',
            accession: 'P03817',
            fragment: 'F1',
            version: 'V6',
            modelId: 'AF-P03817-F1-model_v6',
          },
        },
      };
      const result: ResolverResult = {
        source: 'protein_sequence',
        identity: 1,
        structure: {
          kind: 'pdb',
          pdbId: '1XYZ',
          uniprotFallback: { accession: 'P03817' },
        },
        recommendedCandidateId: 'rcsb:1XYZ:all',
        candidates: [
          {
            ...PDB_CANDIDATE,
            id: 'rcsb:1XYZ:all',
            structure: {
              kind: 'pdb',
              pdbId: '1XYZ',
              uniprotFallback: { accession: 'P03817' },
            },
          },
          afCandidate,
        ],
      };
      useStructureDrawerStore.setState({
        status: 'error',
        error: {
          code: 'viewer_error',
          message: 'Failed to fetch structure bytes: 413 Content Too Large',
          failedStep: 'protein_sequence',
        },
        resolved: result,
        currentStep: 'protein_sequence',
        requestId: 8,
        previewCandidateId: afCandidate.id,
        committedCandidateId: 'rcsb:1XYZ:all',
        candidatePickerOpen: true,
      });

      useStructureDrawerStore.getState().commitCandidate(afCandidate.id);

      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('rendering');
      expect(s.requestId).toBe(9);
      expect(s.committedCandidateId).toBe(afCandidate.id);
      expect(s.resolved?.structure).toEqual(afCandidate.structure);
      expect(s.error).toBeNull();
    });

    it('drops a swap targeted at a stale request (after a fresh open() landed)', () => {
      const PREFER_PDB_RESULT: ResolverResult = {
        source: 'protein_sequence',
        identity: 1.0,
        structure: {
          kind: 'pdb',
          pdbId: '1XYZ',
          uniprotFallback: { accession: 'P03817' },
        },
      };
      useStructureDrawerStore.setState({
        status: 'rendering',
        resolved: PREFER_PDB_RESULT,
        requestId: 5,
      });
      useStructureDrawerStore.setState({
        requestId: 6,
        resolved: UNIPROT_RESULT,
        status: 'rendering',
      });
      const stale = useStructureDrawerStore.getState();
      stale.handleViewerError('mol* error from prior request');
      expect(useStructureDrawerStore.getState().status).toBe('error');
      expect(useStructureDrawerStore.getState().resolved?.structure).toEqual(
        UNIPROT_RESULT.structure
      );
    });
  });

  describe('store .revision (per-store-invariants)', () => {
    it('open() bumps revision', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      const before = useStructureDrawerStore.getState().revision;
      await useStructureDrawerStore.getState().open(makeRequest());
      expect(useStructureDrawerStore.getState().revision).toBeGreaterThan(before);
    });

    it('close() bumps revision', () => {
      const before = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState().close();
      expect(useStructureDrawerStore.getState().revision).toBeGreaterThan(before);
    });

    it('setResolver bumps revision', () => {
      const before = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      expect(useStructureDrawerStore.getState().revision).toBe(before + 1);
    });

    it('previewCandidate bumps revision when the candidate is valid', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const before = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState().previewCandidate('alphafold:P00880:all');
      expect(useStructureDrawerStore.getState().revision).toBe(before + 1);
    });

    it('previewCandidate with unknown id does NOT bump revision', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const before = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState().previewCandidate('does-not-exist');
      expect(useStructureDrawerStore.getState().revision).toBe(before);
    });

    it('commitCandidate bumps revision', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(CANDIDATE_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const before = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState().commitCandidate('alphafold:P00880:all');
      expect(useStructureDrawerStore.getState().revision).toBe(before + 1);
    });

    it('_markReady bumps revision when requestId matches; stale call does not', async () => {
      useStructureDrawerStore.getState().setResolver(fakeResolver(PDB_RESULT));
      await useStructureDrawerStore.getState().open(makeRequest());
      const { requestId } = useStructureDrawerStore.getState();
      const before = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState()._markReady(requestId);
      expect(useStructureDrawerStore.getState().revision).toBe(before + 1);

      const after = useStructureDrawerStore.getState().revision;
      useStructureDrawerStore.getState()._markReady(requestId - 1);
      expect(useStructureDrawerStore.getState().revision).toBe(after);
    });
  });

  describe('close()', () => {
    it('aborts the in-flight controller and resets to idle', async () => {
      const signals: AbortSignal[] = [];
      useStructureDrawerStore
        .getState()
        .setResolver(fakeResolver(PDB_RESULT, { delayMs: 50, observeSignal: signals }));

      const opening = useStructureDrawerStore.getState().open(makeRequest());

      useStructureDrawerStore.getState().close();

      await opening;

      const s = useStructureDrawerStore.getState();
      expect(s.status).toBe('idle');
      expect(s.request).toBeNull();
      expect(signals[0]?.aborted).toBe(true);
      expect(s).not.toHaveProperty('_resolver');
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowActionInput, WorkflowOperation } from '../../../lib/workflow-telemetry';
import type { ResolverResult, StructureDrawerRequest } from '../types/structure-drawer';

const telemetry = vi.hoisted(() => ({
  operations: [] as Array<{ input: WorkflowActionInput; operation: WorkflowOperation }>,
  observe: vi.fn(),
}));
vi.mock('../../../lib/workflow-telemetry', () => ({
  observeWorkflowAction: telemetry.observe,
  beginWorkflowAction: (input: WorkflowActionInput) => {
    let consumed = false;
    const finish = () => {
      if (consumed) return false;
      consumed = true;
      return true;
    };
    const operation = {
      actionId: crypto.randomUUID(),
      get consumed() {
        return consumed;
      },
      complete: vi.fn(finish),
      fail: vi.fn(finish),
      cancel: vi.fn(finish),
    };
    telemetry.operations.push({ input, operation });
    return operation;
  },
}));
import { createStructureDrawerStore } from './use-structure-drawer-store';

const request: StructureDrawerRequest = {
  translation: 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNV',
  cdsLabel: 'Private protein label',
  hints: {},
};
const result: ResolverResult = {
  source: 'protein_sequence',
  identity: 1,
  structure: { kind: 'pdb', pdbId: '1RBL' },
  candidates: [
    {
      id: 'pdb:a',
      provider: 'pdb',
      structure: { kind: 'pdb', pdbId: '1RBL' },
      label: 'A',
      group: 'rcsb',
      rank: 0,
      metadata: { pdbId: '1RBL' },
      provenance: { resolverSource: 'protein_sequence', identity: 1 },
    },
    {
      id: 'pdb:b',
      provider: 'pdb',
      structure: { kind: 'pdb', pdbId: '1TUP' },
      label: 'B',
      group: 'rcsb',
      rank: 1,
      metadata: { pdbId: '1TUP' },
      provenance: { resolverSource: 'protein_sequence', identity: 1 },
    },
  ],
};
let store: ReturnType<typeof createStructureDrawerStore>;
beforeEach(() => {
  telemetry.operations.length = 0;
  telemetry.observe.mockClear();
  store = createStructureDrawerStore();
  store.getState().setResolver(async () => ({ result, cacheHit: false }));
});
afterEach(() => store.getState().close());

describe('structure opening operation across viewer generations', () => {
  it('reuses a ready cached view without another lookup or duplicate opening terminal', async () => {
    const resolver = vi.fn(async () => ({ result, cacheHit: true }));
    store.getState().setResolver(resolver);
    await store.getState().open(request);
    store.getState().commitCandidate('pdb:a');
    const generation = store.getState().requestId;
    store.getState()._markReady(generation);
    await store.getState().open({ ...request });
    store.getState()._markReady(generation);
    expect(resolver).toHaveBeenCalledOnce();
    expect(telemetry.operations).toHaveLength(1);
    expect(telemetry.operations[0].operation.complete).toHaveBeenCalledOnce();
    expect(telemetry.observe).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'view', status: 'ready', cached: true })
    );
  });

  it('records cached no-match as one completed lookup with no usable result', async () => {
    store.getState().setResolver(async () => ({ result: null, cacheHit: true }));
    await store.getState().open(request);
    expect(telemetry.operations[0].operation.complete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no_match', resultCount: 0, cached: true })
    );
    expect(telemetry.operations[0].operation.consumed).toBe(true);
    expect(store.getState().cacheHit).toBe(true);
  });

  it('keeps saved-coordinate view ownership through an equivalent-context remount', () => {
    const coordinates = { text: 'saved coordinate fixture', format: 'pdb' as const };
    store.getState().openSavedCoordinates(request, 'saved-fixture', coordinates);
    expect(telemetry.operations).toHaveLength(1);
    expect(telemetry.operations[0].input.action).toBe('view');
    const original = telemetry.operations[0].operation;
    const previous = store.getState().requestId;
    store.getState().openSavedCoordinates({ ...request }, 'saved-fixture', coordinates);
    store.getState()._markReady(previous);
    expect(original.complete).not.toHaveBeenCalled();
    store.getState()._markReady(store.getState().requestId);
    expect(original.complete).toHaveBeenCalledOnce();
    expect(telemetry.operations).toHaveLength(1);
  });

  it('updates saved-coordinate candidate identity while preserving a pending remount receipt', () => {
    const coordinates = { text: 'saved coordinate fixture', format: 'pdb' as const };
    store.getState().openSavedCoordinates(request, 'saved-original', coordinates);
    const previous = store.getState().requestId;
    const original = telemetry.operations[0].operation;

    store.getState().openSavedCoordinates({ ...request }, 'saved-alternate', coordinates);

    expect(store.getState().committedCandidateId).toBe('saved-alternate');
    expect(store.getState().requestId).toBe(previous + 1);
    expect(store.getState().status).toBe('rendering');
    store.getState()._markReady(previous);
    expect(original.complete).not.toHaveBeenCalled();
    store.getState()._markReady(store.getState().requestId);
    expect(original.complete).toHaveBeenCalledOnce();
    expect(telemetry.operations).toHaveLength(1);
  });

  it('updates an identical saved-coordinate request candidate without a new viewer generation', () => {
    const coordinates = { text: 'saved coordinate fixture', format: 'pdb' as const };
    store.getState().openSavedCoordinates(request, 'saved-original', coordinates);
    const previous = store.getState().requestId;
    const original = telemetry.operations[0].operation;

    store.getState().openSavedCoordinates(request, 'saved-alternate', coordinates);

    expect(store.getState().committedCandidateId).toBe('saved-alternate');
    expect(store.getState().requestId).toBe(previous);
    expect(telemetry.operations).toHaveLength(1);
    store.getState()._markReady(previous);
    expect(original.complete).toHaveBeenCalledOnce();
  });

  it('fails the current selection once and never settles a new opening from stale callbacks', async () => {
    await store.getState().open(request);
    store.getState().commitCandidate('pdb:a');
    const failedViewer = store.getState().requestId;
    store.getState().handleViewerError('viewer load failed', failedViewer);
    expect(telemetry.operations[0].operation.fail).toHaveBeenCalledOnce();
    await store.getState().open({ ...request, translation: 'MACDEFGHIKLMNPQRSTVWY' });
    store.getState()._markReady(failedViewer);
    store.getState().handleViewerError('old error', failedViewer);
    expect(store.getState().status).toBe('rendering');
    expect(telemetry.operations[1].operation.consumed).toBe(false);
    store.getState().close();
    expect(telemetry.operations[1].operation.cancel).toHaveBeenCalledOnce();
  });

  it('settles the original opening after candidate remount without another resolution', async () => {
    await store.getState().open(request);
    const original = telemetry.operations[0].operation;
    store.getState().commitCandidate('pdb:a');
    store.getState()._markReady(store.getState().requestId);
    expect(original.complete).toHaveBeenCalledOnce();
    expect(original.consumed).toBe(true);
    expect(telemetry.operations).toHaveLength(1);
    expect(telemetry.observe).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'commit', status: 'selected' })
    );
    expect(JSON.stringify(telemetry.operations.map((entry) => entry.input))).not.toContain(
      request.translation
    );
    expect(JSON.stringify(telemetry.operations.map((entry) => entry.input))).not.toContain(
      request.cdsLabel
    );
  });

  it('cancels the original pending opening on close after selection and rejects stale ready', async () => {
    await store.getState().open(request);
    const original = telemetry.operations[0].operation;
    store.getState().commitCandidate('pdb:a');
    const viewer = store.getState().requestId;
    store.getState().close();
    store.getState()._markReady(viewer);
    expect(original.cancel).toHaveBeenCalledOnce();
    expect(original.complete).not.toHaveBeenCalled();
    expect(store.getState().status).toBe('idle');
  });

  it('keeps one pending operation across alternate selection and ignores an old viewer callback', async () => {
    await store.getState().open(request);
    const original = telemetry.operations[0].operation;
    store.getState().commitCandidate('pdb:a');
    const firstViewer = store.getState().requestId;
    store.getState().commitCandidate('pdb:b');
    store.getState()._markReady(firstViewer);
    expect(original.complete).not.toHaveBeenCalled();
    store.getState()._markReady(store.getState().requestId);
    store.getState()._markReady(store.getState().requestId);
    expect(original.complete).toHaveBeenCalledOnce();
    expect(telemetry.operations).toHaveLength(1);
  });

  it('admits a separate viewer operation for an alternate after the original is ready', async () => {
    await store.getState().open(request);
    store.getState().commitCandidate('pdb:a');
    store.getState()._markReady(store.getState().requestId);
    const original = telemetry.operations[0].operation;
    store.getState().commitCandidate('pdb:b');
    expect(telemetry.operations).toHaveLength(2);
    expect(telemetry.operations[1].input.action).toBe('view');
    expect(telemetry.operations[1].operation.actionId).not.toBe(original.actionId);
    store.getState()._markReady(store.getState().requestId);
    expect(original.complete).toHaveBeenCalledOnce();
    expect(telemetry.operations[1].operation.complete).toHaveBeenCalledOnce();
  });

  it('reruns a provider error with no failed-step hint and settles a fresh opening', async () => {
    const resolver = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('connection refused'), { name: 'SidecarProviderError' })
      )
      .mockResolvedValue({ result, cacheHit: false });
    store.getState().setResolver(resolver);
    await store.getState().open(request);
    expect(telemetry.operations[0].operation.fail).toHaveBeenCalledOnce();
    await store.getState().retry();
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe('rendering');
    store.getState()._markReady(store.getState().requestId);
    expect(telemetry.operations[1].operation.complete).toHaveBeenCalledOnce();
  });
});

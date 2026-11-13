import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from './store';
import {
  acceptDesignArtifact,
  captureDesignRecovery,
  designContentIdentity,
  hasUnrecoverableDesignWork,
  loadDesignRecovery,
  persistDesignRecovery,
  useDesignRecoveryStore,
} from './design-recovery';
import {
  hasPendingDesignArtifactMirror,
  resolveDesignArtifactConflict,
  startDesignArtifactMirroring,
  stopDesignArtifactMirroring,
} from './design-artifact-mirror';
import {
  prepareWorkspaceRendererMutation,
  abortWorkspaceRendererMutation,
} from '../../services/workspace-renderer-mutation';

const writer = vi.hoisted(() => vi.fn());
vi.mock('../../db/workspace-artifacts', async (original) => ({
  ...(await original<typeof import('../../db/workspace-artifacts')>()),
  writeDesignArtifactSnapshot: writer,
}));

beforeEach(() => {
  localStorage.clear();
  useDesignRecoveryStore.setState({ records: {} });
  useDesignStore.setState({ designs: {}, activeDesignId: null });
  writer.mockReset().mockRejectedValue(new Error('EACCES: injected workspace write failure'));
  vi.useFakeTimers();
});
afterEach(() => {
  stopDesignArtifactMirroring();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createBoundBaseline() {
  const id = useDesignStore.getState().createDesign('A');
  const baseline = useDesignStore.getState().designs[id];
  acceptDesignArtifact(baseline);
  startDesignArtifactMirroring();
  return { id, baseline };
}

describe('draft recovery with the real design store and renderer update guard', () => {
  it('protects reopening and refuses an incoming update after a failed attempt', async () => {
    const { id, baseline } = createBoundBaseline();
    useDesignStore.getState().updateDesign(id, { name: 'B' });
    await vi.advanceTimersByTimeAsync(250);
    expect(hasPendingDesignArtifactMirror([id])).toBe(true);
    useDesignStore.getState().upsertDesignFromArtifact(baseline);
    expect(useDesignStore.getState().designs[id].name).toBe('B');
    const event = {
      deliveryId: 'recovery-incoming',
      phase: 'preparing' as const,
      workspaceRoot: '/workspace',
      source: {
        kind: 'cloud-sync' as const,
        workspaceUuid: 'workspace',
        remoteVersionId: 'remote',
      },
      affectedNotebookIds: [],
      affectedDesignIds: [id],
      affectedEntityIds: [id],
    };
    expect(() => prepareWorkspaceRendererMutation(event)).toThrow(/unsaved/);
    abortWorkspaceRendererMutation(event);
    expect(useDesignRecoveryStore.getState().records[id].durable).toBe(true);
    expect(hasUnrecoverableDesignWork()).toEqual([]);
  });

  it('restores the exact unfinished draft even when the old design cache is older', async () => {
    const { id, baseline } = createBoundBaseline();
    useDesignStore.getState().updateDesign(id, { name: 'B' });
    await vi.advanceTimersByTimeAsync(250);
    const savedJournal = localStorage.getItem(`waypoint-design-recovery-v1:${id}`);
    expect(savedJournal).toContain('B');
    stopDesignArtifactMirroring();
    useDesignRecoveryStore.setState({ records: {} });
    useDesignStore.setState({ designs: { [id]: baseline } });
    startDesignArtifactMirroring();
    expect(useDesignStore.getState().designs[id].name).toBe('B');
    expect(hasPendingDesignArtifactMirror([id])).toBe(true);
  });

  it('tracks a persisted change without advancing the scientific version', () => {
    const { id } = createBoundBaseline();
    const baseline = useDesignStore.getState().designs[id];
    const changed = { ...baseline, constructId: 'new-construct' };
    captureDesignRecovery(changed, baseline);
    expect(changed.version).toBe(baseline.version);
    expect(useDesignRecoveryStore.getState().records[id].revision).not.toBe(
      designContentIdentity(baseline)
    );
    expect(hasPendingDesignArtifactMirror([id])).toBe(true);
  });

  it('keeps both independently changed versions through a content decision', async () => {
    const { id, baseline } = createBoundBaseline();
    useDesignStore.getState().updateDesign(id, { name: 'B' });
    useDesignStore.getState().upsertDesignFromArtifact({ ...baseline, name: 'C' });
    expect(useDesignStore.getState().designs[id].name).toBe('B');
    expect(useDesignRecoveryStore.getState().records[id]).toMatchObject({
      status: 'conflict',
      conflict: { name: 'C' },
    });
    resolveDesignArtifactConflict(id, 'external');
    expect(useDesignStore.getState().designs[id].name).toBe('C');
    expect(useDesignRecoveryStore.getState().records[id].alternatives?.[0].name).toBe('B');
    await vi.advanceTimersByTimeAsync(250);
    expect(writer).toHaveBeenLastCalledWith(
      expect.objectContaining({ design: expect.objectContaining({ name: 'C' }) })
    );
  });

  it('keeps edits in memory and reports unsaved work when recovery persistence also fails', async () => {
    const { id } = createBoundBaseline();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    expect(() =>
      useDesignStore.getState().updateDesign(id, { name: 'Only in memory' })
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(250);
    expect(useDesignStore.getState().designs[id].name).toBe('Only in memory');
    expect(hasUnrecoverableDesignWork()).toEqual([id]);
    vi.restoreAllMocks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(hasUnrecoverableDesignWork()).toEqual([]);
    expect(hasPendingDesignArtifactMirror([id])).toBe(true);
  });

  it('does not infer durability from an in-memory record after a failed write', () => {
    const { id } = createBoundBaseline();
    const before = useDesignRecoveryStore.getState().records[id];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    persistDesignRecovery(id, { ...before, pending: true });
    loadDesignRecovery();
    expect(useDesignRecoveryStore.getState().records[id].durable).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenomeLiveSession } from './genome-live-session';
import {
  ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
  type GenomeOpenSource,
  type GenomeSessionShell,
  type GenomeSessionUpdate,
} from '../../shared/indexed-genome';

const native = vi.hoisted(() => ({
  open: vi.fn(),
  getSession: vi.fn(),
  closeSession: vi.fn(),
  upgradeSessionCapabilities: vi.fn(),
  listeners: new Set<(update: GenomeSessionUpdate) => void>(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    genome: native,
    on: (_event: string, listener: (update: GenomeSessionUpdate) => void) => {
      native.listeners.add(listener);
      return () => native.listeners.delete(listener);
    },
  }),
}));
vi.mock('./indexed-genome-lifecycle-telemetry', () => ({
  claimIndexedGenomeOpen: () => undefined,
  beginIndexedGenomeOpen: () => ({
    coordinateReady: vi.fn(),
    firstViewportPresented: vi.fn(),
    viewportPresented: vi.fn(),
    acceptViewport: vi.fn(),
    refuseViewport: vi.fn(),
    end: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function generation(fingerprint: string) {
  return {
    contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
    sourceFingerprint: 'source',
    inventoryFingerprint: fingerprint,
    themeMode: 'light' as const,
  };
}
function shell(id = 'session-1'): GenomeSessionShell {
  return {
    sessionId: id,
    sourcePath: '/reference.fa',
    sourceFingerprint: 'source',
    chrom: 'chr1',
    openReady: false,
    coordinateReady: false,
    validationState: 'metadata_match',
    tracks: [
      {
        id: 'sequence',
        kind: 'sequence',
        label: 'Sequence',
        state: 'coordinate_ready',
        userState: 'Showing overview',
      },
    ],
    openedAt: 1,
  };
}
function source(): GenomeOpenSource {
  return { sourcePath: '/reference.fa', intent: { kind: 'reference-single' } };
}
function open(owner: GenomeLiveSession, input = source()) {
  return owner.open({
    tabId: 'tab',
    ownerKey: '/reference.fa',
    hasManifest: false,
    retainPresentation: false,
    restorationSource: { sourcePath: '/reference.fa', sourceExt: 'fa', chrom: 'chr1' },
    prepareSource: async () => input,
    projectReadyState: (state) => state,
    persist: vi.fn(),
  });
}
function emit(update: GenomeSessionUpdate) {
  for (const listener of native.listeners) listener(update);
}

describe('genome live resource ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.listeners.clear();
    native.closeSession.mockResolvedValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('closes a late native lease after its tab has already closed', async () => {
    const pending = deferred<GenomeSessionShell>();
    native.open.mockReturnValueOnce(pending.promise);
    const owner = new GenomeLiveSession(false);
    const close = open(owner);
    await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
    close('closed');
    pending.resolve(shell('late-session'));
    await vi.waitFor(() => expect(native.closeSession).toHaveBeenCalledWith('late-session'));
    expect(owner.getSnapshot().shell).toBeNull();
    expect(owner.getSnapshot().ownerKey).toBeNull();
    expect(native.listeners.size).toBe(0);
  });

  it('keeps one recovery request in flight and ignores it after a terminal event', async () => {
    vi.useFakeTimers();
    const pending = deferred<GenomeSessionShell>();
    native.open.mockResolvedValueOnce(shell());
    native.getSession.mockReturnValueOnce(pending.promise);
    const owner = new GenomeLiveSession(false);
    const close = open(owner);
    await vi.advanceTimersByTimeAsync(3000);
    expect(native.getSession).toHaveBeenCalledOnce();
    emit({
      sessionId: 'session-1',
      shell: { ...shell(), openReady: true },
      prepareStatus: 'ready',
      prepareLoadPhase: 'opening',
    });
    pending.resolve(shell());
    await vi.advanceTimersByTimeAsync(3000);
    expect(owner.getSnapshot().shell?.openReady).toBe(true);
    expect(owner.getSnapshot().preparation.status).toBe('ready');
    expect(native.getSession).toHaveBeenCalledOnce();
    close('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the admitted generation when an older generation arrives afterward', async () => {
    const old = {
      ...shell(),
      openReady: true,
      assemblyAnnotationProductsReadiness: 'ready' as const,
      assemblySearchReadiness: 'ready' as const,
      assemblyAssetGeneration: generation('old'),
    };
    const latest = { ...old, assemblyAssetGeneration: generation('new') };
    native.open.mockResolvedValueOnce(old);
    native.getSession.mockReturnValueOnce(new Promise(() => {}));
    native.upgradeSessionCapabilities.mockResolvedValueOnce(latest);
    const owner = new GenomeLiveSession(false);
    const close = open(owner);
    await vi.waitFor(() => expect(owner.getSnapshot().shell).toBe(old));
    emit({
      sessionId: old.sessionId,
      shell: old,
      prepareStatus: 'ready',
      prepareLoadPhase: 'opening',
    });
    owner.trackError(owner.getSnapshot().generation, 'sequence', 'Old generation failed');
    expect(owner.getSnapshot().shell?.tracks[0]?.state).toBe('error');
    owner.requestCapabilities({
      sourcePath: '/reference.fa',
      intent: {
        kind: 'reference-assembly',
        assetGeneration: generation('new'),
        annotationProductsReadiness: 'ready',
        searchReadiness: 'ready',
      },
    });
    await vi.waitFor(() =>
      expect(owner.getSnapshot().shell?.assemblyAssetGeneration).toEqual(generation('new'))
    );
    emit({
      sessionId: old.sessionId,
      shell: old,
      prepareStatus: 'ready',
      prepareLoadPhase: 'opening',
    });
    expect(owner.getSnapshot().shell?.assemblyAssetGeneration).toEqual(generation('new'));
    expect(owner.getSnapshot().shell?.tracks[0]?.state).toBe('coordinate_ready');
    close('closed');
  });

  it('continues accepting the admitted generation after an upgrade is refused', async () => {
    const admitted = {
      ...shell(),
      openReady: true,
      assemblyAssetGeneration: generation('admitted'),
    };
    native.open.mockResolvedValueOnce(admitted);
    native.getSession.mockReturnValueOnce(new Promise(() => {}));
    native.upgradeSessionCapabilities.mockRejectedValueOnce(new Error('Unavailable product'));
    const owner = new GenomeLiveSession(false);
    const close = open(owner);
    await vi.waitFor(() => expect(owner.getSnapshot().shell).toBe(admitted));
    owner.requestCapabilities({
      sourcePath: '/reference.fa',
      intent: {
        kind: 'reference-assembly',
        assetGeneration: generation('refused'),
        annotationProductsReadiness: 'ready',
        searchReadiness: 'ready',
      },
    });
    await vi.waitFor(() => expect(owner.getSnapshot().capabilityError).not.toBeNull());
    emit({
      sessionId: admitted.sessionId,
      shell: { ...admitted, coordinateReady: true },
      prepareStatus: 'ready',
      prepareLoadPhase: 'opening',
    });
    expect(owner.getSnapshot().shell?.coordinateReady).toBe(true);
    expect(owner.getSnapshot().shell?.assemblyAssetGeneration).toEqual(generation('admitted'));
    close('closed');
  });
});

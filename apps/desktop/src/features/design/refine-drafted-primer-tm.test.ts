import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore, refineDraftedPrimerTm, scheduleDraftedPrimerTmRefinement } from './store';
import { getTmProviderRegistry, setTmProviderRegistry } from './algorithms/design-tm-refinement';
import { TmProviderRegistry, createLocalTmProvider } from './algorithms/tm-provider';
import type { DesignPrimerPair } from './types';
import { useSettingsStore } from '../junction-workbench/settings';
import { DEFAULT_TM_MODEL } from './algorithms/tm-model';

function primerPair(pbs: string): DesignPrimerPair {
  const primer = (id: string) => ({
    id,
    name: id,
    sequence: pbs,
    pbs: { start: 0, end: pbs.length, sequence: pbs },
    overhang: { length: 0, sequence: '' },
    direction: 'forward' as const,
    fragmentIndex: 0,
    junctionIndex: 0,
    tm: 50,
  });
  return {
    forward: primer('f'),
    reverse: primer('r'),
    fragmentIndex: 0,
  } as unknown as DesignPrimerPair;
}

function deferredNebRegistry() {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = new TmProviderRegistry().register(createLocalTmProvider(() => 50)).register({
    id: 'neb',
    supports: (model) => model.kind === 'neb',
    measure: async () => {
      await gate;
      return { tm: 68.4, source: 'neb', verified: true };
    },
  });
  return { registry, release: () => release?.() };
}

function seedDesign(id: string, version: number, polymerase: string | null, pbs = 'AAAACCCC') {
  useDesignStore.setState({
    designs: {
      [id]: {
        id,
        name: 'd',
        regions: [],
        topology: 'circular',
        assemblyMethod: 'gibson',
        defaultHomologyLength: 30,
        homologyRegions: [],
        designPrimers: [primerPair(pbs)],
        spacers: [],
        status: 'draft',
        assemblyState: 'drafting',
        validationErrors: [],
        version,
        pcrPolymerase: polymerase,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
    activeDesignId: id,
    pendingDispatchId: null,
  });
}

describe('refineDraftedPrimerTm — the staleness guard', () => {
  const original = getTmProviderRegistry();

  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
    });
  });
  afterEach(() => {
    setTmProviderRegistry(original);
    localStorage.removeItem('waypoint-designs');
  });

  it('commits authoritative Tm values without bumping the design version', async () => {
    const { registry, release } = deferredNebRegistry();
    setTmProviderRegistry(registry);
    seedDesign('d1', 7, 'q5');

    const pending = refineDraftedPrimerTm('d1');
    release();
    await pending;

    const after = useDesignStore.getState().designs['d1'];
    expect(after.designPrimers[0].forward.tm).toBe(68.4);
    expect(after.designPrimers[0].forward.tmProvenance).toMatchObject({ verified: true });
    expect(after.version).toBe(7);
  });

  it('DROPS a result whose design moved on while the call was in flight', async () => {
    const { registry, release } = deferredNebRegistry();
    setTmProviderRegistry(registry);
    seedDesign('d1', 7, 'q5');

    const pending = refineDraftedPrimerTm('d1');

    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        d1: { ...state.designs['d1'], version: 8, designPrimers: [primerPair('TTTTGGGG')] },
      },
    }));

    release();
    await pending;

    const after = useDesignStore.getState().designs['d1'];
    expect(after.version).toBe(8);
    expect(after.designPrimers[0].forward.pbs.sequence).toBe('TTTTGGGG');
    expect(after.designPrimers[0].forward.tm).toBe(50);
  });

  it('DROPS a result when the effective Tm settings change while the call is in flight', async () => {
    const { registry, release } = deferredNebRegistry();
    setTmProviderRegistry(registry);
    useSettingsStore.setState({ primerConcNm: 500 });
    seedDesign('d1', 7, 'q5');

    const pending = refineDraftedPrimerTm('d1');
    useSettingsStore.setState({ primerConcNm: 250 });

    release();
    await pending;

    const after = useDesignStore.getState().designs['d1'];
    expect(after.version).toBe(7);
    expect(after.designPrimers[0].forward.tm).toBe(50);
    expect(after.designPrimers[0].forward.tmProvenance).toBeUndefined();
  });

  it.each(['replace', 'delete and restore'] as const)(
    'keeps restored artifact primers when an old same-version calculation finishes: %s',
    async (replacement) => {
      const { registry, release } = deferredNebRegistry();
      setTmProviderRegistry(registry);
      seedDesign('restored', 7, 'q5');
      const originalDesign = useDesignStore.getState().designs.restored;
      const pending = refineDraftedPrimerTm('restored');

      if (replacement === 'delete and restore') {
        useDesignStore.getState().deleteDesign('restored');
      }
      useDesignStore.getState().upsertDesignFromArtifact({
        ...originalDesign,
        designPrimers: [primerPair('TTTTGGGG')],
      });
      const restored = useDesignStore.getState().designs.restored;
      expect(restored.version).toBe(originalDesign.version);
      expect(restored.designPrimers[0].forward.pbs.sequence).toBe('TTTTGGGG');

      release();
      await pending;

      expect(useDesignStore.getState().designs.restored).toBe(restored);
      expect(restored.designPrimers[0].forward.tm).toBe(50);
    }
  );

  it('cancels obsolete provider work before starting the replacement refinement', async () => {
    const signals: AbortSignal[] = [];
    let measurementNumber = 0;
    setTmProviderRegistry(
      new TmProviderRegistry().register(createLocalTmProvider(() => 50)).register({
        id: 'neb',
        supports: (model) => model.kind === 'neb',
        measure: async ({ signal }) => {
          measurementNumber += 1;
          if (signal) signals.push(signal);
          if (measurementNumber > 1) {
            return { tm: 72.1, source: 'neb', verified: true };
          }
          return await new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('superseded');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          });
        },
      })
    );
    seedDesign('scheduled', 7, 'q5', 'AACCGGTT');

    scheduleDraftedPrimerTmRefinement('scheduled');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    scheduleDraftedPrimerTmRefinement('scheduled');

    await vi.waitFor(() => {
      expect(signals[0].aborted).toBe(true);
      expect(measurementNumber).toBeGreaterThan(1);
      expect(useDesignStore.getState().designs.scheduled.designPrimers[0].forward.tm).toBe(72.1);
    });
  });

  it('does nothing when no polymerase is recorded', async () => {
    const { registry } = deferredNebRegistry();
    setTmProviderRegistry(registry);
    seedDesign('d1', 3, null);

    await refineDraftedPrimerTm('d1');
    expect(useDesignStore.getState().designs['d1'].designPrimers[0].forward.tm).toBe(50);
  });

  it('uses an explicit app-wide provider model when no design polymerase is recorded', async () => {
    const measure = vi.fn(async () => ({ tm: 71.2, source: 'neb', verified: true }));
    setTmProviderRegistry(
      new TmProviderRegistry().register(createLocalTmProvider(() => 50)).register({
        id: 'neb',
        supports: (model) => model.kind === 'neb',
        measure,
      })
    );
    useSettingsStore.setState({
      tmModel: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
      tmModelExplicit: true,
    });
    seedDesign('app-setting', 4, null, 'CGCGATATCG');

    await refineDraftedPrimerTm('app-setting');

    expect(measure).toHaveBeenCalled();
    expect(useDesignStore.getState().designs['app-setting'].designPrimers[0].forward.tm).toBe(71.2);
  });

  it('schedules provider refinement after persisted designs are rehydrated', async () => {
    const measure = vi.fn(async () => ({ tm: 69.7, source: 'neb', verified: true }));
    setTmProviderRegistry(
      new TmProviderRegistry().register(createLocalTmProvider(() => 50)).register({
        id: 'neb',
        supports: (model) => model.kind === 'neb',
        measure,
      })
    );
    seedDesign('rehydrated', 9, 'q5', 'GCGCTATAGC');
    const persisted = localStorage.getItem('waypoint-designs');
    expect(persisted).not.toBeNull();

    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    localStorage.setItem('waypoint-designs', persisted!);

    await useDesignStore.persist.rehydrate();

    await vi.waitFor(() => {
      expect(measure).toHaveBeenCalled();
      expect(useDesignStore.getState().designs.rehydrated.designPrimers[0].forward.tm).toBe(69.7);
    });
  });

  it('is a no-op for a design with no primers', async () => {
    seedDesign('d1', 1, 'q5');
    useDesignStore.setState((state) => ({
      designs: { ...state.designs, d1: { ...state.designs['d1'], designPrimers: [] } },
    }));
    await expect(refineDraftedPrimerTm('d1')).resolves.toBeUndefined();
  });
});

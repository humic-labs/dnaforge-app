import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assemblyDispatcher, hydrateDesign, useDesignStore } from './store';
import type { DesignPrimer, SequenceDesign } from './types';

async function savedFourPartDesign(): Promise<SequenceDesign> {
  const store = useDesignStore.getState();
  const id = store.createDesign('Four-part expression construct', 'circular', 'gibson');
  for (const [index, bases] of ['ATGC', 'CGTA', 'GACT', 'TCAG'].entries()) {
    store.addRegion(id, {
      sourceSequenceId: `source-${index}`,
      sourceSequenceName: `Source ${index + 1}`,
      sourceStart: 0,
      sourceEnd: 160,
      sequence: bases.repeat(40),
      annotations: [],
    });
  }
  const dispatch = vi.spyOn(assemblyDispatcher, 'dispatch');
  store.draftAssembly(id);
  const result = dispatch.mock.results.at(-1)?.value;
  dispatch.mockRestore();
  await result?.result;
  const design = useDesignStore.getState().designs[id];
  expect(design.designPrimers).toHaveLength(4);
  return JSON.parse(JSON.stringify(design));
}

function withSavedPrimerEdits(design: SequenceDesign, manuallyEdited: boolean): SequenceDesign {
  const lengths = [30, 20, 30, 51, 30, 51, 30, 30];
  const edited = (primer: DesignPrimer, index: number): DesignPrimer => {
    const sequence = 'ACGT'.repeat(13).slice(0, lengths[index]);
    return {
      ...primer,
      manuallyEdited,
      overhang: { length: sequence.length, tailLength: sequence.length, sequence },
      sequence: sequence + primer.pbs.sequence,
    };
  };
  return {
    ...design,
    version: 39,
    designPrimers: design.designPrimers.map((pair, index) => ({
      ...pair,
      forward: edited(pair.forward, index * 2),
      reverse: edited(pair.reverse, index * 2 + 1),
    })),
    assemblyWorkbench: {
      junctions: [],
      primers: [],
      ...design.assemblyWorkbench,
      primerEditIntents: design.regions.flatMap((region, index) =>
        (['forward', 'reverse'] as const).map((direction, offset) => ({
          id: `tail-${index}-${direction}`,
          regionId: region.id,
          direction,
          junctionIndex: design.designPrimers[index][direction].junctionIndex,
          field: 'tailLength' as const,
          length: lengths[index * 2 + offset],
          updatedAtVersion: 38,
        }))
      ),
    },
  };
}

describe('saved assembly primer hydration', () => {
  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null, pendingDispatchId: null });
  });

  it.each([true, false])(
    'preserves explicit saved tails at the same version (manual=%s)',
    async (manual) => {
      const saved = withSavedPrimerEdits(await savedFourPartDesign(), manual);
      const original = JSON.stringify(saved);
      const hydrated = hydrateDesign(saved);
      expect(hydrated.designPrimers).toEqual(saved.designPrimers);
      expect(hydrated.version).toBe(39);
      expect(hydrated.updatedAt).toEqual(saved.updatedAt);
      expect(hydrated.assemblyWorkbench?.primerEditIntents).toEqual(
        saved.assemblyWorkbench?.primerEditIntents
      );
      expect(JSON.stringify(saved)).toBe(original);

      useDesignStore.getState().upsertDesignFromArtifact(saved);
      const installed = useDesignStore.getState().designs[saved.id];
      expect(installed.designPrimers).toEqual(saved.designPrimers);
      expect(installed.version).toBe(39);
      expect(installed.updatedAt.toISOString()).toBe(new Date(saved.updatedAt).toISOString());
      expect(JSON.stringify(saved)).toBe(original);
    }
  );

  it('preserves manually edited oligos saved before edit intents existed', async () => {
    const saved = withSavedPrimerEdits(await savedFourPartDesign(), true);
    saved.assemblyWorkbench!.primerEditIntents = [];
    expect(hydrateDesign(saved).designPrimers).toEqual(saved.designPrimers);
  });

  it('still rebuilds stale default overhangs in legacy designs without explicit edits', async () => {
    const saved = await savedFourPartDesign();
    saved.assemblyWorkbench = { junctions: [], primers: [], primerEditIntents: [] };
    for (const pair of saved.designPrimers) {
      pair.forward.manuallyEdited = false;
      pair.reverse.manuallyEdited = false;
    }
    const expected = hydrateDesign(saved).designPrimers;
    const legacy = {
      ...saved,
      designPrimers: saved.designPrimers.map((pair) => ({
        ...pair,
        forward: {
          ...pair.forward,
          manuallyEdited: false,
          overhang: { sequence: 'AAAA', length: 4 },
          sequence: 'AAAA' + pair.forward.pbs.sequence,
        },
        reverse: {
          ...pair.reverse,
          manuallyEdited: false,
          overhang: { sequence: 'CCCC', length: 4 },
          sequence: 'CCCC' + pair.reverse.pbs.sequence,
        },
      })),
    };
    expect(hydrateDesign(legacy).designPrimers).toEqual(expected);
  });
});

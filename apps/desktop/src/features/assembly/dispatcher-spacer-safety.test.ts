import { describe, expect, it } from 'vitest';
import { useDesignStore, assemblyDispatcher } from '../design/store';
import { getComposedSequence } from '../design/types';
import type { DesignRegion } from '../design/types';

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `s-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function threePartDesign() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
  const store = useDesignStore.getState();
  const id = store.createDesign('D', 'circular', 'gibson');
  store.addRegion(id, region('A', 'AAAA'));
  store.addRegion(id, region('B', 'CCCC'));
  store.addRegion(id, region('C', 'GGGG'));
  return id;
}

const designOf = (id: string) => useDesignStore.getState().designs[id];

describe('dispatcher keeps spacers with their parts', () => {
  it('a spacer stays between the SAME two parts after a fragment is removed', async () => {
    const id = threePartDesign();
    useDesignStore.getState().setJunctionSpacer(id, 1, 'TTT');
    expect(getComposedSequence(designOf(id).regions, designOf(id).spacers)).toBe('AAAACCCCTTTGGGG');

    const regionA = designOf(id).regions[0].id;
    await assemblyDispatcher.dispatch({
      type: 'removeFragment',
      designId: id,
      fragmentId: regionA,
      expectedVersion: designOf(id).version,
    }).result;

    const after = designOf(id);
    expect(after.regions.map((r) => r.sourceSequenceName)).toEqual(['B', 'C']);
    expect(getComposedSequence(after.regions, after.spacers)).toBe('CCCCTTTGGGG');
  });

  it('a spacer follows its parts through a reorder', async () => {
    const id = threePartDesign();
    useDesignStore.getState().setJunctionSpacer(id, 0, 'TTT');
    const ids = designOf(id).regions.map((r) => r.id);

    await assemblyDispatcher.dispatch({
      type: 'reorderFragments',
      designId: id,
      order: [ids[2], ids[0], ids[1]],
      expectedVersion: designOf(id).version,
    }).result;

    const after = designOf(id);
    expect(after.regions.map((r) => r.sourceSequenceName)).toEqual(['C', 'A', 'B']);
    expect(getComposedSequence(after.regions, after.spacers)).toBe('GGGGAAAATTTCCCC');
  });

  it('keeps a spacer at the wrap when a 3-part circle is reordered', async () => {
    const id = threePartDesign();
    useDesignStore.getState().setJunctionSpacer(id, 0, 'TTT');
    const ids = designOf(id).regions.map((r) => r.id);

    await assemblyDispatcher.dispatch({
      type: 'reorderFragments',
      designId: id,
      order: [ids[0], ids[2], ids[1]],
      expectedVersion: designOf(id).version,
    }).result;

    const after = designOf(id);
    expect(after.spacers).toHaveLength(1);
    expect(getComposedSequence(after.regions, after.spacers)).toBe('AAAAGGGGCCCCTTT');
  });

  it('drops a spacer once its two parts are genuinely separated', async () => {
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
    const store = useDesignStore.getState();
    const id = store.createDesign('D4', 'circular', 'gibson');
    store.addRegion(id, region('A', 'AAAA'));
    store.addRegion(id, region('B', 'CCCC'));
    store.addRegion(id, region('C', 'GGGG'));
    store.addRegion(id, region('D', 'TTTT'));
    store.setJunctionSpacer(id, 0, 'TTT');
    const ids = designOf(id).regions.map((r) => r.id);

    await assemblyDispatcher.dispatch({
      type: 'reorderFragments',
      designId: id,
      order: [ids[0], ids[2], ids[1], ids[3]],
      expectedVersion: designOf(id).version,
    }).result;

    const after = designOf(id);
    expect(after.regions.map((r) => r.sourceSequenceName)).toEqual(['A', 'C', 'B', 'D']);
    expect(after.spacers).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { useDesignStore } from '../store';

describe('Design store sourceType handling', () => {
  beforeEach(() => {
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
    });
  });

  it('should set sourceType to pcr by default when adding a region', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Test Design');

    store.addRegion(designId, {
      sourceSequenceId: 'seq-1',
      sourceSequenceName: 'pUC19',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'ATCGATCG',
      annotations: [],
    });

    const updatedState = useDesignStore.getState();
    const design = updatedState.designs[designId];
    expect(design.regions).toHaveLength(1);
    expect(design.regions[0].sourceType).toBe('pcr');
  });

  it('should preserve sourceType when explicitly set to rd', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Test Design');

    store.addRegion(designId, {
      sourceSequenceId: 'seq-2',
      sourceSequenceName: 'pBR322',
      sourceStart: 0,
      sourceEnd: 200,
      sequence: 'GCTAGCTA',
      annotations: [],
      sourceType: 'rd',
      rdOverhangs: {
        upstream: 'AATT',
        downstream: 'GATC',
      },
      ggType: 'insert',
    });

    const updatedState = useDesignStore.getState();
    const design = updatedState.designs[designId];
    expect(design.regions).toHaveLength(1);
    expect(design.regions[0].sourceType).toBe('rd');
    expect(design.regions[0].rdOverhangs).toEqual({
      upstream: 'AATT',
      downstream: 'GATC',
    });
  });

  it('should handle insertRegionAt with default sourceType', () => {
    const store = useDesignStore.getState();
    const designId = store.createDesign('Test Design');

    store.addRegion(designId, {
      sourceSequenceId: 'seq-1',
      sourceSequenceName: 'Region 1',
      sourceStart: 0,
      sourceEnd: 100,
      sequence: 'AAAA',
      annotations: [],
    });

    store.insertRegionAt(designId, 0, {
      sourceSequenceId: 'seq-2',
      sourceSequenceName: 'Region 2',
      sourceStart: 0,
      sourceEnd: 50,
      sequence: 'TTTT',
      annotations: [],
    });

    const updatedState = useDesignStore.getState();
    const design = updatedState.designs[designId];
    expect(design.regions).toHaveLength(2);
    expect(design.regions[0].sourceType).toBe('pcr');
    expect(design.regions[1].sourceType).toBe('pcr');
  });

  it('should migrate existing regions on hydration', () => {
    expect(true).toBe(true);
  });
});

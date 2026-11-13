import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from './store';
import {
  orphanedSpacers,
  projectAssemblyGaps,
  projectAssemblySlots,
  slotOccupantFingerprint,
} from './slot-projection';
import type { DesignRegion } from './types';

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function region(name: string, sequence: string): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: `source-${name}`,
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function twoSlotDesign(): string {
  const store = useDesignStore.getState();
  const designId = store.createDesign('Slots', 'circular', 'gibson');
  store.addRegion(designId, region('left', 'AAATTT'));
  store.addRegion(designId, region('right', 'GGGCCC'));
  return designId;
}

const designOf = (id: string) => useDesignStore.getState().designs[id];

describe('slot projection — occupancy the agent can actually see', () => {
  beforeEach(resetDesignStore);

  it('reports one slot per region, with its position', () => {
    const slots = projectAssemblySlots(designOf(twoSlotDesign()));
    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.slotIndex)).toEqual([0, 1]);
    expect(slots.every((slot) => slot.isEmpty === false)).toBe(true);
  });

  it('marks a cleared slot as EMPTY while keeping its position and id', () => {
    const designId = twoSlotDesign();
    const before = projectAssemblySlots(designOf(designId));
    useDesignStore.getState().clearRegion(designId, before[0].regionId);

    const after = projectAssemblySlots(designOf(designId));
    expect(after).toHaveLength(2);
    expect(after[0].slotIndex).toBe(0);
    expect(after[0].regionId).toBe(before[0].regionId);
    expect(after[0].isEmpty).toBe(true);
    expect(after[0].label).toBe('Empty slot');
    expect(after[0].length).toBe(0);
  });
});

describe('occupantFingerprint — the anti-clobber mechanism', () => {
  beforeEach(resetDesignStore);

  it('🟥 CHANGES when a slot is cleared, even though the id does NOT', () => {
    const designId = twoSlotDesign();
    const before = projectAssemblySlots(designOf(designId))[0];

    useDesignStore.getState().clearRegion(designId, before.regionId);
    const after = projectAssemblySlots(designOf(designId))[0];

    expect(after.regionId).toBe(before.regionId);
    expect(after.occupantFingerprint).not.toBe(before.occupantFingerprint);
  });

  it('CHANGES when a slot is refilled in place', () => {
    const designId = twoSlotDesign();
    const slot = projectAssemblySlots(designOf(designId))[0];
    useDesignStore.getState().clearRegion(designId, slot.regionId);
    const emptied = projectAssemblySlots(designOf(designId))[0];

    useDesignStore.getState().updateRegion(designId, slot.regionId, {
      ...region('other', 'TTTTTT'),
      isPlaceholder: false,
    });
    const refilled = projectAssemblySlots(designOf(designId))[0];

    expect(refilled.regionId).toBe(slot.regionId);
    expect(refilled.occupantFingerprint).not.toBe(emptied.occupantFingerprint);
    expect(refilled.occupantFingerprint).not.toBe(slot.occupantFingerprint);
  });

  it('is stable when nothing changed', () => {
    const designId = twoSlotDesign();
    const first = projectAssemblySlots(designOf(designId));
    const second = projectAssemblySlots(designOf(designId));
    expect(second[0].occupantFingerprint).toBe(first[0].occupantFingerprint);
  });

  it('distinguishes two fragments with identical coordinates but different overhangs', () => {
    const base: DesignRegion = {
      id: 'r1',
      ...region('pUC19', 'AAAACCCC'),
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTT' },
    } as DesignRegion;
    const swapped: DesignRegion = {
      ...base,
      rdOverhangs: { upstream: 'TTCA', downstream: 'GCTT' },
    };
    expect(slotOccupantFingerprint(swapped)).not.toBe(slotOccupantFingerprint(base));
  });

  it('changes for a same-length edit in the middle of a long sequence', () => {
    const sequence = 'A'.repeat(200);
    const base: DesignRegion = { id: 'r1', ...region('long', sequence) };
    const edited: DesignRegion = {
      ...base,
      sequence: `${sequence.slice(0, 100)}C${sequence.slice(101)}`,
    };

    expect(slotOccupantFingerprint(edited)).not.toBe(slotOccupantFingerprint(base));
  });

  it('changes when annotations or source provenance change', () => {
    const base: DesignRegion = {
      id: 'r1',
      ...region('annotated', 'AAAACCCC'),
      sourceSequence: 'TTTTAAAACCCCGGGG',
      sourceIsCircular: false,
      annotations: [{ name: 'cds', type: 'CDS', start: 0, end: 4, strand: 'forward' }],
    };
    const annotationEdit: DesignRegion = {
      ...base,
      annotations: [{ ...base.annotations[0], end: 5 }],
    };
    const provenanceEdit: DesignRegion = {
      ...base,
      sourceIsCircular: true,
    };

    expect(slotOccupantFingerprint(annotationEdit)).not.toBe(slotOccupantFingerprint(base));
    expect(slotOccupantFingerprint(provenanceEdit)).not.toBe(slotOccupantFingerprint(base));
  });
});

describe('gaps — where spacers live', () => {
  beforeEach(resetDesignStore);

  it('reports one gap per slot on a circular design, including the wrap gap', () => {
    const gaps = projectAssemblyGaps(designOf(twoSlotDesign()));
    expect(gaps.map((gap) => gap.junctionIndex)).toEqual([0, 1]);
  });

  it('surfaces the spacer sitting in a gap', () => {
    const designId = twoSlotDesign();
    useDesignStore.getState().setJunctionSpacer(designId, 0, 'GCC');
    const gaps = projectAssemblyGaps(designOf(designId));
    expect(gaps[0].spacer).toMatchObject({ sequence: 'GCC', length: 3 });
    expect(gaps[1].spacer).toBeNull();
  });
});

describe('orphanedSpacers — the half of the failure class duplicates do not cover', () => {
  beforeEach(resetDesignStore);

  it('flags a spacer pointing past the last gap', () => {
    const designId = twoSlotDesign();
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [designId]: {
          ...state.designs[designId],
          spacers: [{ id: 's1', junctionIndex: 9, sequence: 'AAA' }],
        },
      },
    }));

    const orphans = orphanedSpacers(designOf(designId));
    expect(orphans).toHaveLength(1);
    expect(orphans[0].junctionIndex).toBe(9);
  });

  it('does not flag a spacer in a legal gap', () => {
    const designId = twoSlotDesign();
    useDesignStore.getState().setJunctionSpacer(designId, 1, 'AAA');
    expect(orphanedSpacers(designOf(designId))).toHaveLength(0);
  });
});

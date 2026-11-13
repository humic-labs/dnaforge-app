import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from './store';
import { getComposedSequence } from './types';
import { deriveAssemblyIssues } from '../assembly/issues/assembly-issues';
import {
  dedupeSpacersByJunction,
  findDuplicateSpacerGroups,
  repositionSpacersFromAnchors,
} from './spacer-invariants';
import type { DesignRegion, DesignSpacer, SequenceDesign } from './types';

const spacer = (id: string, junctionIndex: number, sequence: string): DesignSpacer => ({
  id,
  junctionIndex,
  sequence,
});

describe('one spacer per gap — the rule itself', () => {
  it('finds a gap holding more than one spacer', () => {
    const groups = findDuplicateSpacerGroups([
      spacer('a', 0, 'AAA'),
      spacer('b', 2, 'TTT'),
      spacer('c', 2, 'GGG'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ junctionIndex: 2, keptId: 'b', droppedIds: ['c'] });
  });

  it('reports nothing when every gap holds at most one', () => {
    expect(findDuplicateSpacerGroups([spacer('a', 0, 'AAA'), spacer('b', 1, 'TTT')])).toEqual([]);
    expect(findDuplicateSpacerGroups([])).toEqual([]);
    expect(findDuplicateSpacerGroups(undefined)).toEqual([]);
  });

  it('keeps the FIRST spacer in a gap, so the construct sequence does not change', () => {
    const kept = dedupeSpacersByJunction([spacer('first', 1, 'AAA'), spacer('second', 1, 'TTT')]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('first');
  });

  it('leaves an untouched list alone by reference', () => {
    const clean = [spacer('a', 0, 'AAA'), spacer('b', 1, 'TTT')];
    expect(dedupeSpacersByJunction(clean)).toBe(clean);
  });

  it('does NOT drop a spacer whose gap is past the end of the assembly', () => {
    const orphaned = [spacer('a', 0, 'AAA'), spacer('orphan', 99, 'TTT')];
    expect(dedupeSpacersByJunction(orphaned)).toHaveLength(2);
  });
});

describe('why it mattered — the construct and the primers disagree', () => {
  it('the composed sequence takes the first spacer in a gap', () => {
    const regions = [{ sequence: 'AAA' } as DesignRegion, { sequence: 'CCC' } as DesignRegion];
    const composed = getComposedSequence(regions, [spacer('x', 0, 'GGG'), spacer('y', 0, 'TTT')]);
    expect(composed).toBe('AAAGGGCCC');
    expect(composed).not.toContain('TTT');
  });
});

function resetStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

describe('enforcement — loading preserves invalid DNA so it can be reported', () => {
  beforeEach(resetStore);

  it('does not silently delete a duplicate when a design is loaded through the real load path', () => {
    const persisted = {
      id: 'd1',
      name: 'legacy',
      regions: [
        { id: 'r0', sequence: 'AAA', annotations: [], sourceType: 'pcr' },
        { id: 'r1', sequence: 'CCC', annotations: [], sourceType: 'pcr' },
      ],
      spacers: [spacer('keep', 0, 'GGG'), spacer('drop', 0, 'TTT')],
      topology: 'circular',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      status: 'draft',
      validationErrors: [],
      version: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as SequenceDesign;

    useDesignStore.getState().upsertDesignFromArtifact(persisted);

    const loaded = useDesignStore.getState().designs['d1'];
    expect(loaded.spacers.map((item) => item.id)).toEqual(['keep', 'drop']);
    expect(
      deriveAssemblyIssues({ design: loaded }).some(
        (issue) => issue.kind === 'spacer-duplicate-junction' && issue.gates.run
      )
    ).toBe(true);
    expect(getComposedSequence(loaded.regions, loaded.spacers)).toBe('AAAGGGCCC');
  });

  it('leaves a clean design untouched on load', () => {
    const clean = {
      id: 'd2',
      name: 'clean',
      regions: [
        { id: 'r0', sequence: 'AAA', annotations: [], sourceType: 'pcr' },
        { id: 'r1', sequence: 'CCC', annotations: [], sourceType: 'pcr' },
      ],
      spacers: [spacer('a', 0, 'GGG'), spacer('b', 1, 'TTT')],
      topology: 'circular',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      status: 'draft',
      validationErrors: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as SequenceDesign;

    useDesignStore.getState().upsertDesignFromArtifact(clean);
    expect(useDesignStore.getState().designs['d2'].spacers).toHaveLength(2);
  });
});

describe('enforcement — a duplicate is reported, never silent', () => {
  it('raises a blocking validation error naming the gap', () => {
    const design = {
      id: 'd1',
      name: 'dup',
      regions: [
        { id: 'r0', sequence: 'AAATTT', annotations: [], sourceType: 'pcr' },
        { id: 'r1', sequence: 'GGGCCC', annotations: [], sourceType: 'pcr' },
      ],
      spacers: [spacer('a', 1, 'GGG'), spacer('b', 1, 'TTT')],
      topology: 'circular',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      status: 'draft',
      assemblyState: 'drafting',
      validationErrors: [],
      version: 0,
    } as unknown as SequenceDesign;

    const issues = deriveAssemblyIssues({ design });
    const duplicate = issues.filter((issue) => issue.kind === 'spacer-duplicate-junction');

    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].severity).toBe('error');
    expect(duplicate[0].detail).toContain('Gap 1');
    expect(duplicate[0].gates.run).toBe(true);
  });

  it('says nothing when every gap holds one spacer', () => {
    const design = {
      id: 'd1',
      name: 'ok',
      regions: [
        { id: 'r0', sequence: 'AAATTT', annotations: [], sourceType: 'pcr' },
        { id: 'r1', sequence: 'GGGCCC', annotations: [], sourceType: 'pcr' },
      ],
      spacers: [spacer('a', 0, 'GGG')],
      topology: 'circular',
      assemblyMethod: 'gibson',
      defaultHomologyLength: 30,
      homologyRegions: [],
      designPrimers: [],
      status: 'draft',
      assemblyState: 'drafting',
      validationErrors: [],
      version: 0,
    } as unknown as SequenceDesign;

    expect(
      deriveAssemblyIssues({ design }).filter((i) => i.kind === 'spacer-duplicate-junction')
    ).toHaveLength(0);
  });
});

describe('position derived from identity — the actual fix', () => {
  const R = (id: string) => ({ id });

  it('moves a spacer with its parts instead of doing arithmetic on its index', () => {
    const anchored: DesignSpacer = {
      id: 's',
      junctionIndex: 0,
      sequence: 'AAGC',
      anchor: { leftRegionId: 'A', rightRegionId: 'B' },
    };
    const result = repositionSpacersFromAnchors([anchored], [R('C'), R('A'), R('B')]);
    expect(result.spacers[0].junctionIndex).toBe(1);
    expect(result.moved).toEqual([{ id: 's', from: 0, to: 1 }]);
  });

  it('keeps a spacer when its two parts swap order', () => {
    const anchored: DesignSpacer = {
      id: 's',
      junctionIndex: 0,
      sequence: 'AAGC',
      anchor: { leftRegionId: 'A', rightRegionId: 'B' },
    };
    const result = repositionSpacersFromAnchors([anchored], [R('B'), R('A'), R('C')]);
    expect(result.spacers).toHaveLength(1);
    expect(result.spacers[0].junctionIndex).toBe(0);
    expect(result.detached).toHaveLength(0);
  });

  it('resolves the two-part circular case, where both gaps join the same pair', () => {
    const atZero: DesignSpacer = {
      id: 's0',
      junctionIndex: 0,
      sequence: 'AAA',
      anchor: { leftRegionId: 'A', rightRegionId: 'B' },
    };
    const atOne: DesignSpacer = {
      id: 's1',
      junctionIndex: 1,
      sequence: 'TTT',
      anchor: { leftRegionId: 'B', rightRegionId: 'A' },
    };
    const result = repositionSpacersFromAnchors([atZero, atOne], [R('A'), R('B')]);
    expect(result.spacers.map((s) => s.junctionIndex).sort()).toEqual([0, 1]);
    expect(result.spacers).toHaveLength(2);
  });

  it('🟥 two spacers can never land on the same gap', () => {
    const a: DesignSpacer = {
      id: 'a',
      junctionIndex: 5,
      sequence: 'AAA',
      anchor: { leftRegionId: 'A', rightRegionId: 'B' },
    };
    const b: DesignSpacer = {
      id: 'b',
      junctionIndex: 6,
      sequence: 'TTT',
      anchor: { leftRegionId: 'B', rightRegionId: 'C' },
    };
    const result = repositionSpacersFromAnchors([a, b], [R('A'), R('B'), R('C')]);
    const gaps = result.spacers.map((s) => s.junctionIndex);
    expect(new Set(gaps).size).toBe(gaps.length);
    expect(gaps.sort()).toEqual([0, 1]);
  });

  it('reports a spacer whose parts are no longer adjacent instead of guessing', () => {
    const orphaned: DesignSpacer = {
      id: 's',
      junctionIndex: 0,
      sequence: 'AAA',
      anchor: { leftRegionId: 'A', rightRegionId: 'B' },
    };
    const result = repositionSpacersFromAnchors([orphaned], [R('A'), R('C'), R('D')]);
    expect(result.spacers).toHaveLength(0);
    expect(result.detached.map((s) => s.id)).toEqual(['s']);
  });

  it('leaves a spacer written before anchors existed exactly where it is', () => {
    const legacy: DesignSpacer = { id: 'old', junctionIndex: 1, sequence: 'AAA' };
    const result = repositionSpacersFromAnchors([legacy], [R('A'), R('B'), R('C')]);
    expect(result.spacers[0].junctionIndex).toBe(1);
    expect(result.moved).toEqual([]);
  });
});

describe('every spacer write records where it sits', () => {
  beforeEach(resetStore);

  it('stamps the two parts a spacer sits between', () => {
    const store = useDesignStore.getState();
    const id = store.createDesign('anchored', 'circular', 'gibson');
    store.addRegion(id, {
      sequence: 'AAATTT',
      annotations: [],
      sourceSequenceId: 's',
      sourceSequenceName: 'A',
      sourceStart: 0,
      sourceEnd: 6,
    } as never);
    store.addRegion(id, {
      sequence: 'GGGCCC',
      annotations: [],
      sourceSequenceId: 's',
      sourceSequenceName: 'B',
      sourceStart: 0,
      sourceEnd: 6,
    } as never);

    store.setJunctionSpacer(id, 0, 'AAGC');

    const design = useDesignStore.getState().designs[id];
    const written = design.spacers[0];
    expect(written.anchor).toEqual({
      leftRegionId: design.regions[0].id,
      rightRegionId: design.regions[1].id,
    });
  });
});

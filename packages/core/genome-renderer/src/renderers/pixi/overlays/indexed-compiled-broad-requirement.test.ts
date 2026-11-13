import { describe, expect, it } from 'vitest';
import { IndexedCompiledBroadRequirement } from './indexed-compiled-broad-requirement';

describe('IndexedCompiledBroadRequirement', () => {
  it('rejects invalid corridor bounds', () => {
    const requirement = new IndexedCompiledBroadRequirement();
    expect(
      requirement.require(
        { genomeLengthBp: 0, broadCorridorFinestSpanBp: 100 },
        { genomeLength: 0, hasAdmittedSurface: false }
      )
    ).toBe(false);
    expect(requirement.current).toBeNull();
  });

  it('arms a first valid requirement', () => {
    const requirement = new IndexedCompiledBroadRequirement();
    expect(
      requirement.require(
        { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 100 },
        { genomeLength: 0, hasAdmittedSurface: false }
      )
    ).toBe(true);
    expect(requirement.current).toEqual({
      genomeLengthBp: 1000,
      broadCorridorFinestSpanBp: 100,
    });
  });

  it('keeps an exact repeat and refuses a different genome length', () => {
    const requirement = new IndexedCompiledBroadRequirement();
    requirement.require(
      { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 100 },
      { genomeLength: 1000, hasAdmittedSurface: false }
    );
    expect(
      requirement.require(
        { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 100 },
        { genomeLength: 1000, hasAdmittedSurface: false }
      )
    ).toBe(true);
    expect(
      requirement.require(
        { genomeLengthBp: 2000, broadCorridorFinestSpanBp: 100 },
        { genomeLength: 1000, hasAdmittedSurface: false }
      )
    ).toBe(false);
  });

  it('lets an admitted surface keep a same-genome provisional corridor', () => {
    const requirement = new IndexedCompiledBroadRequirement();
    requirement.require(
      { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 100 },
      { genomeLength: 1000, hasAdmittedSurface: false }
    );
    expect(
      requirement.require(
        { genomeLengthBp: 1000, broadCorridorFinestSpanBp: 250 },
        { genomeLength: 1000, hasAdmittedSurface: true }
      )
    ).toBe(true);
    expect(requirement.current?.broadCorridorFinestSpanBp).toBe(100);
  });
});

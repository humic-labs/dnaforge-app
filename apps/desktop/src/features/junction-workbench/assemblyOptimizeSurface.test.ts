// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../design/types';
import { assemblyOptimizeSurface } from './assemblyOptimizeSurface';

describe('assemblyOptimizeSurface', () => {
  it('hides optimize chrome until the active method has drafted junctions', () => {
    expect(assemblyOptimizeSurface(baseDesign('gibson')).kind).toBe('none');
    expect(assemblyOptimizeSurface(baseDesign('goldengate')).kind).toBe('none');
    expect(
      assemblyOptimizeSurface({
        ...baseDesign('goldengate'),
        homologyRegions: [homology(0)],
      }).kind
    ).toBe('none');
  });

  it('offers one-click Auto optimize only for drafted homology methods', () => {
    expect(
      assemblyOptimizeSurface({
        ...baseDesign('gibson'),
        homologyRegions: [homology(0)],
      })
    ).toEqual({ kind: 'homology-one-click', label: 'Auto optimize' });
    expect(
      assemblyOptimizeSurface({
        ...baseDesign('nebuilder'),
        homologyRegions: [homology(0)],
      })
    ).toEqual({ kind: 'homology-one-click', label: 'Auto optimize' });
  });

  it('offers ranked Optimize overhangs only for drafted Golden Gate', () => {
    expect(
      assemblyOptimizeSurface({
        ...baseDesign('goldengate'),
        goldenGateJunctions: [goldenGate(0)],
      })
    ).toEqual({ kind: 'goldengate-ranked', label: 'Optimize overhangs' });
  });

  it('switches the surface when the same design changes method', () => {
    const gibsonDrafted: SequenceDesign = {
      ...baseDesign('gibson'),
      homologyRegions: [homology(0)],
      goldenGateJunctions: undefined,
    };
    const switchedToGoldenGate: SequenceDesign = {
      ...gibsonDrafted,
      assemblyMethod: 'goldengate',
      homologyRegions: [],
      goldenGateJunctions: [],
    };
    const restoredGoldenGate: SequenceDesign = {
      ...switchedToGoldenGate,
      goldenGateJunctions: [goldenGate(0)],
    };

    expect(assemblyOptimizeSurface(gibsonDrafted).kind).toBe('homology-one-click');
    expect(assemblyOptimizeSurface(switchedToGoldenGate).kind).toBe('none');
    expect(assemblyOptimizeSurface(restoredGoldenGate).kind).toBe('goldengate-ranked');
  });
});

function homology(junctionIndex: number): SequenceDesign['homologyRegions'][number] {
  return {
    id: `h${junctionIndex}`,
    junctionIndex,
    junctionPosition: 24,
    start: 0,
    end: 48,
    encoding: { onLeft: 20, onRight: 20 },
    templateBasis: {
      leftHomologyEnd: 24,
      rightHomologyStart: 24,
    },
  };
}

function goldenGate(
  junctionIndex: number
): NonNullable<SequenceDesign['goldenGateJunctions']>[number] {
  return {
    junctionIndex,
    overhang: 'ATGC',
    isValid: true,
    validationError: undefined,
    offset: 0,
    junctionPosition: 24,
    overhangStart: 22,
    overhangEnd: 26,
    source: { type: 'pcr-designed' },
  };
}

function baseDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const now = new Date('2026-08-12T00:00:00.000Z');
  return {
    id: `design-${method}`,
    name: method,
    topology: 'circular',
    regions: [
      {
        id: 'r1',
        sourceSequenceId: 's1',
        sourceSequenceName: 's1',
        sourceStart: 0,
        sourceEnd: 80,
        sequence: 'A'.repeat(80),
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'r2',
        sourceSequenceId: 's2',
        sourceSequenceName: 's2',
        sourceStart: 0,
        sourceEnd: 80,
        sequence: 'C'.repeat(80),
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: method,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: method === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: method === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

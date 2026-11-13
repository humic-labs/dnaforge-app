import { describe, expect, it } from 'vitest';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import {
  acceptedAssemblyJunctionIndicators,
  acceptedHistoryBackboneSegments,
} from './accepted-history-presentation';
import {
  getAssemblyBackboneProvenanceStyleForRegion,
  getAssemblySpacerProvenanceStyle,
} from '../design/public/colors';

function savedAssembly() {
  const regions = [
    {
      id: 'digest',
      colorIndex: 4,
      sourceSequenceName: 'Backbone',
      sequence: 'A'.repeat(10),
      sourceType: 'rd',
      rdEnds: { upstream: { retainedScarLength: 5 } },
    },
    {
      id: 'pcr',
      colorIndex: 1,
      sourceSequenceName: 'Insert',
      sequence: 'C'.repeat(20),
      sourceType: 'pcr',
    },
  ];
  return {
    projectionInput: {
      topology: 'circular',
      regions,
      spacers: [{ id: 'spacer', junctionIndex: 0, sequence: 'G'.repeat(2) }],
      productSequence: regions[0].sequence + 'G'.repeat(2) + regions[1].sequence,
    },
  } as unknown as AcceptedAssemblySidecarPayload;
}

describe('accepted assembly history provenance', () => {
  it('uses the saved product coordinates, including scars and spacers, not recomputed draft coordinates', () => {
    const saved = savedAssembly();
    const segments = acceptedHistoryBackboneSegments(
      saved,
      saved.projectionInput.productSequence,
      null,
      'carbon'
    );
    expect(segments?.map(({ start, end, regionId }) => ({ start, end, regionId }))).toEqual([
      { start: 0, end: 10, regionId: 'digest' },
      { start: 10, end: 12, regionId: undefined },
      { start: 12, end: 32, regionId: 'pcr' },
    ]);
    expect(segments?.[0]).toMatchObject(
      getAssemblyBackboneProvenanceStyleForRegion(saved.projectionInput.regions[0], 0, {}, 'carbon')
    );
    expect(segments?.[1]).toMatchObject(getAssemblySpacerProvenanceStyle());
  });

  it('emphasizes only the hovered part with the assembly viewer styling', () => {
    const saved = savedAssembly();
    const segments = acceptedHistoryBackboneSegments(
      saved,
      saved.projectionInput.productSequence,
      1,
      'carbon'
    );
    expect(segments?.[0]).toMatchObject(
      getAssemblyBackboneProvenanceStyleForRegion(saved.projectionInput.regions[0], 0, {}, 'carbon')
    );
    expect(segments?.[2]).toMatchObject(
      getAssemblyBackboneProvenanceStyleForRegion(
        saved.projectionInput.regions[1],
        1,
        { hovered: true },
        'carbon'
      )
    );
  });

  it('does not paint historical ranges over a different current product', () => {
    const saved = savedAssembly();
    expect(acceptedHistoryBackboneSegments(saved, 'T'.repeat(32), null, 'carbon')).toBeUndefined();
  });

  it('marks both sides of a saved spacer and the circular closure from recorded coordinates', () => {
    const saved = savedAssembly();
    const segments = acceptedHistoryBackboneSegments(
      saved,
      saved.projectionInput.productSequence,
      null,
      'carbon'
    );
    expect(acceptedAssemblyJunctionIndicators(saved, segments ?? [])).toEqual([
      { position: 10, leftColor: segments?.[0].color, rightColor: segments?.[1].color },
      { position: 12, leftColor: segments?.[1].color, rightColor: segments?.[2].color },
      { position: 0, leftColor: segments?.[2].color, rightColor: segments?.[0].color },
    ]);
  });
});

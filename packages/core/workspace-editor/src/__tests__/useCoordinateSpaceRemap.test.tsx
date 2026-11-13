/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react';
import type { ORF } from '@waypoint/sequence-utils';
import { expect, it } from 'vitest';
import { useCoordinateSpaceRemap } from '../hooks/useCoordinateSpaceRemap';
import type { CoordinateSpace } from '../types';

const spaces: Array<[string, CoordinateSpace | undefined]> = [
  ['unspecified', undefined],
  ['biological', { mode: 'biological' }],
  ['gapped', { mode: 'gapped', gappedSequence: 'ATG--AAATAA' }],
];

it.each(spaces)(
  'preserves an accepted empty ORF model in %s coordinates',
  (_name, coordinateSpace) => {
    const initialProps: { orfs?: readonly ORF[] } = {};
    const { result, rerender } = renderHook(
      ({ orfs }: typeof initialProps) =>
        useCoordinateSpaceRemap({
          sequence: {
            id: 'empty-orf-model',
            name: 'empty-orf-model',
            sequence: 'ATGAAATAA',
            length: 9,
            circular: false,
            annotations: [],
          },
          coordinateSpace,
          orfs,
        }),
      { initialProps }
    );
    expect(result.current.effectiveOrfs).toBeUndefined();
    const acceptedEmpty: readonly ORF[] = [];
    rerender({ orfs: acceptedEmpty });
    expect(result.current.effectiveOrfs).toEqual([]);
    const presentedModel = result.current.effectiveOrfs;
    rerender({ orfs: acceptedEmpty });
    expect(result.current.effectiveOrfs).toBe(presentedModel);
    rerender({});
    expect(result.current.effectiveOrfs).toBeUndefined();
  }
);

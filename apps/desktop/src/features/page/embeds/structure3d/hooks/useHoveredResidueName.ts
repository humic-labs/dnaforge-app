import { useMemo } from 'react';
import type { ResidueLocation, ChainSequence } from '../types';

export function useHoveredResidueName(
  hovered: ResidueLocation | null | undefined,
  sequenceData: ChainSequence[] | null
): string | undefined {
  return useMemo(() => {
    if (!hovered) return undefined;

    if (hovered.compId) return undefined;

    const chain = sequenceData?.find((c) => c.chainId === hovered.chain);
    const residue = chain?.residues.find((r) => r.position === hovered.position);

    return residue?.name3;
  }, [hovered, sequenceData]);
}

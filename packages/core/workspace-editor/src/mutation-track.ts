import type { MutationMarker, MutationType } from './types';
import { MUTATION_COLORS } from './types';

export function getMutationColor(type: MutationType): string {
  return MUTATION_COLORS[type];
}

export function getMutationWidth(mutation: MutationMarker): number {
  const baseWidth = 2;
  const maxWidth = 6;

  if (mutation.type === 'substitution') {
    return baseWidth;
  }

  const length =
    mutation.type === 'insertion'
      ? mutation.queryBase?.replace(/-/g, '').length || 1
      : mutation.refBase?.replace(/-/g, '').length || 1;

  const scaledWidth = baseWidth + Math.min(Math.floor(length / 2), maxWidth - baseWidth);
  return Math.min(maxWidth, scaledWidth);
}

export function getMutationsForLine(
  mutations: MutationMarker[],
  startCol: number,
  endCol: number
): MutationMarker[] {
  return mutations.filter((m) => m.column >= startCol && m.column < endCol);
}

export function generateMutationMarkers(
  alignedRef: string,
  alignedQuery: string
): MutationMarker[] {
  const markers: MutationMarker[] = [];

  if (alignedRef.length === 0 || alignedQuery.length === 0) {
    return markers;
  }

  const maxLen = Math.min(alignedRef.length, alignedQuery.length);
  let refBioPos = 0;

  for (let col = 0; col < maxLen; col++) {
    const refBase = alignedRef[col];
    const queryBase = alignedQuery[col];

    if (refBase !== '-') {
      refBioPos++;
    }

    if (refBase !== queryBase) {
      let type: MutationType;

      if (refBase === '-') {
        type = 'insertion';
      } else if (queryBase === '-') {
        type = 'deletion';
      } else {
        type = 'substitution';
      }

      markers.push({
        column: col,
        type,
        refBase,
        queryBase,
        refPosition: refBase !== '-' ? refBioPos : undefined,
      });
    }
  }

  return markers;
}

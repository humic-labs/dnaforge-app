import type { MutationType } from './types';

export interface RefCoordBase {
  base: string;
  refBase: string;
  mutation: MutationType | null;
}

export interface InsertionMarker {
  afterRefPos: number;
  bases: string;
}

export interface RefCoordAlignment {
  bases: RefCoordBase[];
  insertions: InsertionMarker[];
}

export function mapAlignmentToRefCoords(
  alignedRef: string,
  alignedQuery: string
): RefCoordAlignment {
  const bases: RefCoordBase[] = [];
  const insertions: InsertionMarker[] = [];
  let refPos = -1;

  const len = Math.min(alignedRef.length, alignedQuery.length);

  for (let col = 0; col < len; col++) {
    const refBase = alignedRef[col];
    const queryBase = alignedQuery[col];

    if (refBase !== '-') {
      refPos++;
      let mutation: MutationType | null = null;

      if (queryBase === '-') {
        mutation = 'deletion';
      } else if (queryBase !== refBase) {
        mutation = 'substitution';
      }

      bases.push({ base: queryBase, refBase, mutation });
    } else {
      if (queryBase !== '-') {
        const lastIns = insertions.length > 0 ? insertions[insertions.length - 1] : null;
        if (lastIns && lastIns.afterRefPos === refPos) {
          lastIns.bases += queryBase;
        } else {
          insertions.push({ afterRefPos: refPos, bases: queryBase });
        }
      }
    }
  }

  return { bases, insertions };
}

export interface MSATrackData {
  id: string;
  label: string;
  alignment: RefCoordAlignment;
  status: 'pass' | 'variants' | 'fail' | 'incomplete';
  identity: number;
}

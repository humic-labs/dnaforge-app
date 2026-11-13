import { useMemo } from 'react';
import type { ReferenceColumnOverlay, BpHighlight } from '@waypoint/workspace-editor';
import { type HoveredResidueStore } from '../state/hovered-residue-store';
import { useResolvedHover } from './useResolvedHover';
export { computeResidueLinkBpRange } from './residue-link-range';

const HOVER_OVERLAY_ALPHA = 0.5;
const HOVER_OVERLAY_ALPHA_2D = 0.4;

export function useResidueLinkOverlays(
  documentId: string | null | undefined,
  store?: HoveredResidueStore | null
): ReadonlyArray<ReferenceColumnOverlay> | null {
  const resolved = useResolvedHover(documentId, store);
  return useMemo(() => {
    if (!resolved) return null;
    const start = resolved.bpRange.start;
    const columns: number[] = [start, start + 1, start + 2];
    return [
      {
        id: resolved.id,
        target: 'sequenceBand',
        columns,
        color: resolved.color,
        kind: 'columnWash',
        alpha: resolved.alpha ?? HOVER_OVERLAY_ALPHA,
      },
    ];
  }, [resolved]);
}

export function useResidueLinkBpHighlights(
  filePath: string | null | undefined,
  store?: HoveredResidueStore | null
): ReadonlyArray<BpHighlight> | null {
  const resolved = useResolvedHover(filePath, store);
  return useMemo(() => {
    if (!resolved) return null;
    return [
      {
        start: resolved.bpRange.start,
        end: resolved.bpRange.end,
        color: resolved.color,
        alpha: resolved.alpha ?? HOVER_OVERLAY_ALPHA_2D,
      },
    ];
  }, [resolved]);
}

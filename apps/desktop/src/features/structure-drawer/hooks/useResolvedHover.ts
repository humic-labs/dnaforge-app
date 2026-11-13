import { useMemo, useSyncExternalStore } from 'react';
import {
  useHoveredResidue,
  type HoveredResidueKey,
  type HoveredResidueStore,
} from '../state/hovered-residue-store';
import { useStructureLinkRegistry } from '../state/use-structure-link-registry';
import { computeResidueLinkBpRange } from './residue-link-range';

export const HOVER_OVERLAY_COLOR = '#fbbf24';

export interface ResolvedHover {
  id: string;
  filePath: string;
  bpRange: { start: number; end: number };
  color: string;
  alpha: number | null;
  sourceStructureId: string;
}

const NOOP_SUBSCRIBE = () => () => {};
const NULL_SNAPSHOT = (): HoveredResidueKey | null => null;

export function useResolvedHover(
  filePath: string | null | undefined,
  store?: HoveredResidueStore | null
): ResolvedHover | null {
  const hoveredFromStore = useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NULL_SNAPSHOT
  );
  const hoveredFromContext = useHoveredResidue();
  const hovered = store ? hoveredFromStore : hoveredFromContext;

  const links = useStructureLinkRegistry((s) => s.links);

  return useMemo(() => {
    if (!filePath || !hovered) return null;
    const range = computeResidueLinkBpRange(hovered, links, filePath);
    if (!range) return null;
    return {
      id: range.id,
      filePath,
      bpRange: { start: range.start, end: range.end },
      color: HOVER_OVERLAY_COLOR,
      alpha: null,
      sourceStructureId: hovered.structureId,
    };
  }, [hovered, links, filePath]);
}

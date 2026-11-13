import { useEffect, useRef } from 'react';
import type { HoveredCodonStore } from '@waypoint/workspace-editor';
import type { HoveredResidueKey, HoveredResidueStore } from '../state/hovered-residue-store';
import { useStructureLinkRegistry } from '../state/use-structure-link-registry';
import { hoveredResidueForSequenceCodon } from '../utils/sequence-structure-hover';

export function useSequenceCodonResidueBridge({
  entityId,
  hoveredCodonStore,
  hoveredResidueStore,
}: {
  entityId: string | null | undefined;
  hoveredCodonStore: HoveredCodonStore;
  hoveredResidueStore: HoveredResidueStore;
}) {
  const lastSequenceResidueRef = useRef<HoveredResidueKey | null>(null);

  useEffect(() => {
    const sync = () => {
      const hoveredCodon = hoveredCodonStore.getSnapshot();
      if (hoveredCodon?.source === 'structure') return;

      const links = useStructureLinkRegistry.getState().links;
      if (hoveredCodon && entityId) {
        const hoveredResidue = hoveredResidueForSequenceCodon(hoveredCodon, entityId, links);
        if (hoveredResidue) {
          lastSequenceResidueRef.current = hoveredResidue;
          hoveredResidueStore.set(hoveredResidue);
          return;
        }
      }

      const currentResidue = hoveredResidueStore.getSnapshot();
      const lastSequenceResidue = lastSequenceResidueRef.current;
      lastSequenceResidueRef.current = null;
      if (sameResidue(currentResidue, lastSequenceResidue)) {
        hoveredResidueStore.set(null);
      }
    };

    sync();
    return hoveredCodonStore.subscribe(sync);
  }, [entityId, hoveredCodonStore, hoveredResidueStore]);
}

function sameResidue(
  left: HoveredResidueKey | null | undefined,
  right: HoveredResidueKey | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.structureId === right.structureId &&
    left.chain === right.chain &&
    left.position === right.position &&
    left.baseChain === right.baseChain &&
    left.labelAsymId === right.labelAsymId &&
    left.authAsymId === right.authAsymId &&
    left.entityId === right.entityId &&
    left.labelSeqId === right.labelSeqId &&
    left.operator === right.operator
  );
}

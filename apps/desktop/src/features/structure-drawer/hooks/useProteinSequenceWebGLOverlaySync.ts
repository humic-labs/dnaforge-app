import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type {
  CodingDnaSelectionRange,
  HoveredCodonKey,
  HoveredCodonStore,
  ResidueSelectionsStore,
} from '@waypoint/workspace-editor';
import {
  residueSelectionsToCodingDnaRanges,
  sameCodingDnaSelectionRanges,
} from '@waypoint/workspace-editor';
import type { HoveredResidueStore } from '../state/hovered-residue-store';
import { useStructureLinkRegistry } from '../state/use-structure-link-registry';
import { computeResidueLinkBpRange } from './useResidueLinkOverlays';

type CodonIdentity = Omit<HoveredCodonKey, 'source'>;

export interface ProteinSequenceWebGLOverlayHandle {
  setResidueLinkRange?: (range: [number, number] | null) => void;
  setHoveredCodon?: (codon: CodonIdentity | null) => void;
  setSelectedCodons?: (codons: ReadonlyArray<CodingDnaSelectionRange>) => void;
}

export function useProteinSequenceWebGLOverlaySync({
  entityId,
  hoveredCodonStore,
  residueSelectionsStore,
  hoveredResidueStore,
  targetRef,
  enabled,
}: {
  entityId: string | null | undefined;
  hoveredCodonStore: HoveredCodonStore;
  residueSelectionsStore: ResidueSelectionsStore;
  hoveredResidueStore: HoveredResidueStore;
  targetRef: RefObject<ProteinSequenceWebGLOverlayHandle | null>;
  enabled: boolean;
}): (target: ProteinSequenceWebGLOverlayHandle | null) => void {
  const lastResidueLinkRangeRef = useRef<[number, number] | null>(null);
  const lastResidueLinkTargetRef = useRef<ProteinSequenceWebGLOverlayHandle | null>(null);
  const lastHoveredCodonRef = useRef<CodonIdentity | null>(null);
  const lastHoveredCodonTargetRef = useRef<ProteinSequenceWebGLOverlayHandle | null>(null);
  const lastSelectedCodonsRef = useRef<ReadonlyArray<CodingDnaSelectionRange>>([]);
  const lastSelectedCodonsTargetRef = useRef<ProteinSequenceWebGLOverlayHandle | null>(null);

  const syncResidueLink = useCallback(
    (target = targetRef.current) => {
      let next: [number, number] | null = null;
      if (!hoveredCodonStore.getSnapshot()) {
        const range = computeResidueLinkBpRange(
          hoveredResidueStore.getSnapshot(),
          useStructureLinkRegistry.getState().links,
          entityId ?? null
        );
        next = range ? [range.start, range.end] : null;
      }
      if (!target?.setResidueLinkRange) return;
      if (
        lastResidueLinkTargetRef.current === target &&
        sameRange(lastResidueLinkRangeRef.current, next)
      )
        return;
      target.setResidueLinkRange(next);
      lastResidueLinkRangeRef.current = next;
      lastResidueLinkTargetRef.current = target;
    },
    [entityId, hoveredCodonStore, hoveredResidueStore, targetRef]
  );

  const syncHoveredCodon = useCallback(
    (target = targetRef.current) => {
      const codon = hoveredCodonStore.getSnapshot();
      const next = codon ? { start: codon.start, end: codon.end, strand: codon.strand } : null;
      if (!target?.setHoveredCodon) return;
      if (
        lastHoveredCodonTargetRef.current === target &&
        sameCodon(lastHoveredCodonRef.current, next)
      )
        return;
      target.setHoveredCodon(next);
      lastHoveredCodonRef.current = next;
      lastHoveredCodonTargetRef.current = target;
    },
    [hoveredCodonStore, targetRef]
  );

  const syncSelectedCodons = useCallback(
    (target = targetRef.current) => {
      const next = residueSelectionsToCodingDnaRanges(
        residueSelectionsStore.getSnapshot(),
        entityId ?? undefined
      );
      if (!target?.setSelectedCodons) return;
      if (
        lastSelectedCodonsTargetRef.current === target &&
        sameCodingDnaSelectionRanges(lastSelectedCodonsRef.current, next)
      )
        return;
      target.setSelectedCodons(next);
      lastSelectedCodonsRef.current = next;
      lastSelectedCodonsTargetRef.current = target;
    },
    [entityId, residueSelectionsStore, targetRef]
  );

  useEffect(() => {
    if (!enabled) return;
    const sync = () => syncResidueLink();

    sync();
    const unsubscribeResidue = hoveredResidueStore.subscribe(sync);
    const unsubscribeCodon = hoveredCodonStore.subscribe(sync);
    const unsubscribeLinks = useStructureLinkRegistry.subscribe(sync);
    return () => {
      unsubscribeResidue();
      unsubscribeCodon();
      unsubscribeLinks();
    };
  }, [enabled, hoveredCodonStore, hoveredResidueStore, syncResidueLink]);

  useEffect(() => {
    if (!enabled) return;
    const sync = () => syncHoveredCodon();

    sync();
    return hoveredCodonStore.subscribe(sync);
  }, [enabled, hoveredCodonStore, syncHoveredCodon]);

  useEffect(() => {
    if (!enabled) return;
    const sync = () => syncSelectedCodons();

    sync();
    return residueSelectionsStore.subscribe(sync);
  }, [enabled, residueSelectionsStore, syncSelectedCodons]);

  return useCallback(
    (target: ProteinSequenceWebGLOverlayHandle | null) => {
      if (!enabled || !target) return;
      syncResidueLink(target);
      syncHoveredCodon(target);
      syncSelectedCodons(target);
    },
    [enabled, syncHoveredCodon, syncResidueLink, syncSelectedCodons]
  );
}

function sameRange(left: [number, number] | null, right: [number, number] | null): boolean {
  return left === right || (!!left && !!right && left[0] === right[0] && left[1] === right[1]);
}

function sameCodon(left: CodonIdentity | null, right: CodonIdentity | null): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.start === right.start &&
      left.end === right.end &&
      left.strand === right.strand)
  );
}

import { useMemo } from 'react';
import type { AnnotatedSequence, ColoredCutSite, ORF } from '@waypoint/sequence-utils';
import type { CoordinateSpace, RulerDecoration } from '../types';
import { isGappedMode } from '../coordinate-space';

export interface UseCoordinateSpaceRemapInput {
  sequence: AnnotatedSequence | null | undefined;

  coordinateSpace: CoordinateSpace | undefined;

  orfs?: readonly ORF[];

  cutSites?: readonly ColoredCutSite[];

  scannedCutSites?: readonly ColoredCutSite[];

  rulerDecorations?: readonly RulerDecoration[];
}

export interface UseCoordinateSpaceRemapResult {
  bioToColMap: Map<number, number> | null;

  effectiveSequence: AnnotatedSequence | null;

  effectiveOrfs: ORF[] | undefined;
  effectiveCutSites: ColoredCutSite[] | undefined;
  effectiveScannedCutSites: ColoredCutSite[] | undefined;
  effectiveRulerDecorations: RulerDecoration[] | undefined;
}

export function useCoordinateSpaceRemap(
  input: UseCoordinateSpaceRemapInput
): UseCoordinateSpaceRemapResult {
  const { sequence, coordinateSpace, orfs, cutSites, scannedCutSites, rulerDecorations } = input;

  const gappedSequenceForMap = isGappedMode(coordinateSpace)
    ? coordinateSpace?.gappedSequence
    : undefined;
  const bioToColMap = useMemo(() => {
    if (!gappedSequenceForMap) return null;
    const gappedSeq = gappedSequenceForMap;
    const map = new Map<number, number>();
    let bioPos = 0;
    for (let col = 0; col < gappedSeq.length; col++) {
      if (gappedSeq[col] !== '-') {
        bioPos++;
        map.set(bioPos, col);
      }
    }
    return map;
  }, [gappedSequenceForMap]);

  const effectiveSequence: AnnotatedSequence | null = useMemo(() => {
    if (!sequence) return null;
    if (isGappedMode(coordinateSpace) && coordinateSpace?.gappedSequence && bioToColMap) {
      const gappedSeq = coordinateSpace.gappedSequence;

      const transformedAnnotations = sequence.annotations?.flatMap((ann) => {
        const startCol = bioToColMap.get(ann.start);
        const endCol = bioToColMap.get(ann.end);
        if (startCol === undefined || endCol === undefined) return [];
        return [
          {
            ...ann,
            biologicalStart: ann.start,
            biologicalEnd: ann.end,

            start: startCol + 1,
            end: endCol + 1,
          },
        ];
      });
      return {
        ...sequence,
        sequence: gappedSeq,
        length: gappedSeq.length,
        annotations: transformedAnnotations,
      };
    }
    return sequence;
  }, [sequence, coordinateSpace, bioToColMap]);

  const effectiveOrfs = useMemo(() => {
    if (!orfs) return undefined;
    if (!bioToColMap) return [...orfs];

    return orfs.flatMap((orf) => {
      const startCol = bioToColMap.get(orf.start + 1);
      const endCol = bioToColMap.get(orf.end + 1);
      if (startCol === undefined || endCol === undefined) return [];
      return [{ ...orf, start: startCol, end: endCol }];
    });
  }, [orfs, bioToColMap]);

  const effectiveCutSites = useMemo(() => {
    if (!cutSites || cutSites.length === 0) return undefined;
    if (!bioToColMap) return [...cutSites];

    return cutSites.flatMap((cs) => {
      const topCol = bioToColMap.get(cs.cutPositionTop + 1);
      const bottomCol = bioToColMap.get(cs.cutPositionBottom + 1);
      const recStartCol = bioToColMap.get(cs.recognitionStart + 1);

      const recEndCol = bioToColMap.get(cs.recognitionEnd);
      if (
        topCol === undefined ||
        bottomCol === undefined ||
        recStartCol === undefined ||
        recEndCol === undefined
      ) {
        return [];
      }
      return [
        {
          ...cs,
          cutPositionTop: topCol,
          cutPositionBottom: bottomCol,
          recognitionStart: recStartCol,
          recognitionEnd: recEndCol + 1,
        },
      ];
    });
  }, [cutSites, bioToColMap]);

  const effectiveScannedCutSites = useMemo(() => {
    if (!scannedCutSites || scannedCutSites.length === 0) return undefined;
    if (!bioToColMap) return [...scannedCutSites];
    return scannedCutSites.flatMap((cs) => {
      const topCol = bioToColMap.get(cs.cutPositionTop + 1);
      const bottomCol = bioToColMap.get(cs.cutPositionBottom + 1);
      const recStartCol = bioToColMap.get(cs.recognitionStart + 1);
      const recEndCol = bioToColMap.get(cs.recognitionEnd);
      if (
        topCol === undefined ||
        bottomCol === undefined ||
        recStartCol === undefined ||
        recEndCol === undefined
      ) {
        return [];
      }
      return [
        {
          ...cs,
          cutPositionTop: topCol,
          cutPositionBottom: bottomCol,
          recognitionStart: recStartCol,
          recognitionEnd: recEndCol + 1,
        },
      ];
    });
  }, [scannedCutSites, bioToColMap]);

  const effectiveRulerDecorations = useMemo(() => {
    if (!rulerDecorations || rulerDecorations.length === 0) return undefined;
    if (!bioToColMap) return [...rulerDecorations];
    const remapped: RulerDecoration[] = [];
    for (const deco of rulerDecorations) {
      const startCol = bioToColMap.get(deco.start + 1);
      const endCol = bioToColMap.get(deco.end + 1);
      if (startCol === undefined || endCol === undefined) continue;
      remapped.push({ ...deco, start: startCol, end: endCol });
    }
    return remapped;
  }, [rulerDecorations, bioToColMap]);

  return {
    bioToColMap,
    effectiveSequence,
    effectiveOrfs,
    effectiveCutSites,
    effectiveScannedCutSites,
    effectiveRulerDecorations,
  };
}

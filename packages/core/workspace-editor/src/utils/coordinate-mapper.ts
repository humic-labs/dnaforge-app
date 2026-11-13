export interface CDSVisibleSegment {
  start: number;
  end: number;
  charIndexStart: number;
  isStartOfCds: boolean;
  isEndOfCds: boolean;
}

export function getCharIndexOnLine(
  genomicPos: number,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): number {
  const lineSpansOrigin = lineStartPos > lineEndPos;

  if (!lineSpansOrigin) {
    return genomicPos - lineStartPos;
  }

  if (genomicPos >= lineStartPos) {
    return genomicPos - lineStartPos;
  } else {
    const charIndexOffset = sequenceLength - lineStartPos;
    return charIndexOffset + genomicPos;
  }
}

export function getCDSVisibleSegments(
  cds: { start: number; end: number },
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): CDSVisibleSegment[] {
  const cdsStart = cds.start - 1;
  const cdsEnd = cds.end;

  const cdsSpansOrigin = cds.start > cds.end;
  const lineSpansOrigin = lineStartPos > lineEndPos;

  const segments: CDSVisibleSegment[] = [];

  const getVisibleRanges = (
    rangeStart: number,
    rangeEnd: number,
    isStartOfCds: boolean,
    isEndOfCds: boolean
  ): CDSVisibleSegment[] => {
    const result: CDSVisibleSegment[] = [];

    if (!lineSpansOrigin) {
      const visibleStart = Math.max(rangeStart, lineStartPos);
      const visibleEnd = Math.min(rangeEnd, lineEndPos);
      if (visibleEnd > visibleStart) {
        const calcIsStartOfCds =
          isStartOfCds && rangeStart >= visibleStart && rangeStart < visibleEnd;
        const calcIsEndOfCds = isEndOfCds && rangeEnd > visibleStart && rangeEnd <= visibleEnd;

        result.push({
          start: visibleStart,
          end: visibleEnd,
          charIndexStart: visibleStart - lineStartPos,
          isStartOfCds: calcIsStartOfCds,
          isEndOfCds: calcIsEndOfCds,
        });
      }
      return result;
    }

    const charIndexOffset = sequenceLength - lineStartPos;

    if (rangeEnd > lineStartPos && rangeStart < sequenceLength) {
      const visibleStart = Math.max(rangeStart, lineStartPos);
      const visibleEnd = Math.min(rangeEnd, sequenceLength);
      if (visibleEnd > visibleStart) {
        result.push({
          start: visibleStart,
          end: visibleEnd,
          charIndexStart: visibleStart - lineStartPos,
          isStartOfCds: isStartOfCds && rangeStart >= visibleStart && rangeStart < visibleEnd,
          isEndOfCds: isEndOfCds && rangeEnd > visibleStart && rangeEnd <= visibleEnd,
        });
      }
    }

    if (rangeEnd > 0 && rangeStart < lineEndPos) {
      const visibleStart = Math.max(rangeStart, 0);
      const visibleEnd = Math.min(rangeEnd, lineEndPos);
      if (visibleEnd > visibleStart) {
        result.push({
          start: visibleStart,
          end: visibleEnd,
          charIndexStart: charIndexOffset + visibleStart,
          isStartOfCds: isStartOfCds && rangeStart >= visibleStart && rangeStart < visibleEnd,
          isEndOfCds: isEndOfCds && rangeEnd > visibleStart && rangeEnd <= visibleEnd,
        });
      }
    }

    return result;
  };

  if (cdsSpansOrigin) {
    const cds1Ranges = getVisibleRanges(cdsStart, sequenceLength, true, false);
    segments.push(...cds1Ranges);

    const cds2Ranges = getVisibleRanges(0, cdsEnd, false, true);
    segments.push(...cds2Ranges);
  } else {
    const ranges = getVisibleRanges(cdsStart, cdsEnd, true, true);
    segments.push(...ranges);
  }

  return segments;
}

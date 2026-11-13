import type { SequenceDrawingContext } from './rendering/drawing-context';
import { IUPAC_DEGENERACY } from '@waypoint/sequence-utils';
import type {
  PrimerDisplay,
  PrimerModificationDisplay,
  WorkspaceEditorConfig,
  RenderedGGProductLabel,
} from './types';
import {
  GOLDEN_GATE_JUNCTION_VISUAL,
  resolveGoldenGateJunctionVisual,
} from '@waypoint/sequence-utils';
import {
  PRIMER_CANVAS_CONSTANTS,
  PRIMER_COLORS,
  TEXT_VISIBILITY_THRESHOLD_PX,
} from './canvas-constants';
import {
  drawCleavedPortion,
  drawRetainedPortion,
  drawGibsonOverhang,
  type OverhangDrawingContext,
  type GoldenGateOverhangParams,
} from './primer-overhang-drawing';
import { packPrimerLanes } from './primer-layout';
import { getCanvasTheme } from './canvas-theme';
import { lineSpansOrigin, getVisibleRangeSegments, rangeOverlapsLine } from './utils/range-utils';

function primerOverlapsLine(
  primer: PrimerDisplay,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number | undefined,
  isOriginLine: boolean
): boolean {
  const primerSpansOrigin = primer.start > primer.end;
  if (primerSpansOrigin && sequenceLength !== undefined) {
    return (
      rangeOverlapsLine(primer.start, sequenceLength, lineStartPos, lineEndPos, sequenceLength) ||
      rangeOverlapsLine(0, primer.end, lineStartPos, lineEndPos, sequenceLength)
    );
  }
  if (isOriginLine && sequenceLength !== undefined) {
    return rangeOverlapsLine(primer.start, primer.end, lineStartPos, lineEndPos, sequenceLength);
  }
  return primer.start < lineEndPos && primer.end > lineStartPos;
}

type PrimerVisibleSegment = {
  start: number;
  end: number;
  charIndexStart: number;
  isFirstPart?: boolean;
};

function visiblePrimerSegments(
  primer: PrimerDisplay,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number | undefined,
  isOriginLine: boolean
): PrimerVisibleSegment[] {
  const primerSpansOrigin = primer.start > primer.end;
  if (primerSpansOrigin && sequenceLength !== undefined) {
    const seg1 = getVisibleRangeSegments(
      primer.start,
      sequenceLength,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
    const seg2 = getVisibleRangeSegments(0, primer.end, lineStartPos, lineEndPos, sequenceLength);
    return [
      ...seg1.map((s) => ({ ...s, isFirstPart: true })),
      ...seg2.map((s) => ({ ...s, isFirstPart: false })),
    ];
  }
  if (isOriginLine && sequenceLength !== undefined) {
    return getVisibleRangeSegments(
      primer.start,
      primer.end,
      lineStartPos,
      lineEndPos,
      sequenceLength
    );
  }
  return [
    {
      start: Math.max(primer.start, lineStartPos),
      end: Math.min(primer.end, lineEndPos),
      charIndexStart: Math.max(primer.start, lineStartPos) - lineStartPos,
    },
  ];
}

function primerSegmentArrowFlags(
  primer: PrimerDisplay,
  segment: PrimerVisibleSegment,
  visibleStart: number,
  visibleEnd: number,
  primerSpansOrigin: boolean
): {
  isStart: boolean;
  isEnd: boolean;
  showForwardArrow: boolean;
  showReverseArrow: boolean;
} {
  const isStart = primerSpansOrigin
    ? segment.isFirstPart === true && visibleStart === primer.start
    : visibleStart === primer.start;
  const isEnd = primerSpansOrigin
    ? segment.isFirstPart === false && visibleEnd === primer.end
    : visibleEnd === primer.end;
  return {
    isStart,
    isEnd,
    showForwardArrow: isEnd && primer.direction === 'forward',
    showReverseArrow: isStart && primer.direction === 'reverse',
  };
}

function primerSegmentBaseRange(
  primer: PrimerDisplay,
  segment: PrimerVisibleSegment,
  sequenceLength: number | undefined
): { basesStartIdx: number; basesEndIdx: number } {
  const primerSpansOrigin = primer.start > primer.end;
  if (primerSpansOrigin && sequenceLength !== undefined) {
    if (segment.isFirstPart) {
      return {
        basesStartIdx: segment.start - primer.start,
        basesEndIdx: segment.end - primer.start,
      };
    }
    const firstPartLen = sequenceLength - primer.start;
    return {
      basesStartIdx: firstPartLen + segment.start,
      basesEndIdx: firstPartLen + segment.end,
    };
  }
  return {
    basesStartIdx: segment.start - primer.start,
    basesEndIdx: segment.end - primer.start,
  };
}

function primerOverhangVisibleRanges(args: {
  primer: PrimerDisplay;
  primerSpansOrigin: boolean;
  sequenceLength: number | undefined;
  overhangLen: number;
  fullPrimerLength: number;
  visibleStart: number;
  visibleEnd: number;
  basesStartIdx: number;
  basesEndIdx: number;
}): {
  isForward: boolean;
  ohAbsStart: number;
  ohAbsEnd: number;
  ohVisibleStart: number;
  ohVisibleEnd: number;
  pbsVisibleStart: number;
  pbsVisibleEnd: number;
} {
  const {
    primer,
    primerSpansOrigin,
    sequenceLength,
    overhangLen,
    fullPrimerLength,
    visibleStart,
    visibleEnd,
    basesStartIdx,
    basesEndIdx,
  } = args;
  const isForward = primer.direction === 'forward';
  let ohVisibleStart = 0;
  let ohVisibleEnd = 0;
  let pbsVisibleStart = 0;
  let pbsVisibleEnd = 0;

  if (primerSpansOrigin && sequenceLength !== undefined) {
    const fullPbsLen = fullPrimerLength - overhangLen;
    let ohBasesStart: number;
    let ohBasesEnd: number;
    let pbsBasesStart: number;
    let pbsBasesEnd: number;
    if (isForward) {
      ohBasesStart = 0;
      ohBasesEnd = overhangLen;
      pbsBasesStart = overhangLen;
      pbsBasesEnd = fullPrimerLength;
    } else {
      pbsBasesStart = 0;
      pbsBasesEnd = fullPbsLen;
      ohBasesStart = fullPbsLen;
      ohBasesEnd = fullPrimerLength;
    }
    const ohIntersectStart = Math.max(ohBasesStart, basesStartIdx);
    const ohIntersectEnd = Math.min(ohBasesEnd, basesEndIdx);
    if (ohIntersectEnd > ohIntersectStart) {
      ohVisibleStart = ohIntersectStart - basesStartIdx;
      ohVisibleEnd = ohIntersectEnd - basesStartIdx;
    }
    const pbsIntersectStart = Math.max(pbsBasesStart, basesStartIdx);
    const pbsIntersectEnd = Math.min(pbsBasesEnd, basesEndIdx);
    if (pbsIntersectEnd > pbsIntersectStart) {
      pbsVisibleStart = pbsIntersectStart - basesStartIdx;
      pbsVisibleEnd = pbsIntersectEnd - basesStartIdx;
    }
    return {
      isForward,
      ohAbsStart: 0,
      ohAbsEnd: 0,
      ohVisibleStart,
      ohVisibleEnd,
      pbsVisibleStart,
      pbsVisibleEnd,
    };
  }

  const fullPrimerLen = primer.end - primer.start;
  const fullPbsLen = fullPrimerLen - overhangLen;
  let ohAbsStart: number;
  let ohAbsEnd: number;
  let pbsAbsStart: number;
  let pbsAbsEnd: number;
  if (isForward) {
    ohAbsStart = primer.start;
    ohAbsEnd = primer.start + overhangLen;
    pbsAbsStart = primer.start + overhangLen;
    pbsAbsEnd = primer.end;
  } else {
    pbsAbsStart = primer.start;
    pbsAbsEnd = primer.start + fullPbsLen;
    ohAbsStart = primer.start + fullPbsLen;
    ohAbsEnd = primer.end;
  }
  const ohClippedStart = Math.max(ohAbsStart, visibleStart);
  const ohClippedEnd = Math.min(ohAbsEnd, visibleEnd);
  const pbsClippedStart = Math.max(pbsAbsStart, visibleStart);
  const pbsClippedEnd = Math.min(pbsAbsEnd, visibleEnd);
  if (ohClippedEnd > ohClippedStart) {
    ohVisibleStart = ohClippedStart - visibleStart;
    ohVisibleEnd = ohClippedEnd - visibleStart;
  }
  if (pbsClippedEnd > pbsClippedStart) {
    pbsVisibleStart = pbsClippedStart - visibleStart;
    pbsVisibleEnd = pbsClippedEnd - visibleStart;
  }
  return {
    isForward,
    ohAbsStart,
    ohAbsEnd,
    ohVisibleStart,
    ohVisibleEnd,
    pbsVisibleStart,
    pbsVisibleEnd,
  };
}

type PrimerOverhangCutVisibleRanges = {
  cleavedVisStart: number;
  cleavedVisEnd: number;
  retainedVisStart: number;
  retainedVisEnd: number;
  scar4bpIdxStart: number;
};

function clipBasesIdxVisibleRange(
  rangeStart: number,
  rangeEnd: number,
  basesStartIdx: number,
  basesEndIdx: number
): { visStart: number; visEnd: number } {
  const start = Math.max(rangeStart, basesStartIdx);
  const end = Math.min(rangeEnd, basesEndIdx);
  if (end > start) {
    return { visStart: start - basesStartIdx, visEnd: end - basesStartIdx };
  }
  return { visStart: 0, visEnd: 0 };
}

function originSpanningOverhangCutRanges(args: {
  isForward: boolean;
  cutPos: number;
  overhangLen: number;
  fullPrimerLength: number;
  basesStartIdx: number;
  basesEndIdx: number;
}): PrimerOverhangCutVisibleRanges {
  const { isForward, cutPos, overhangLen, fullPrimerLength, basesStartIdx, basesEndIdx } = args;
  const segmentOhBasesStart = isForward ? 0 : fullPrimerLength - overhangLen;
  const segmentOhBasesEnd = isForward ? overhangLen : fullPrimerLength;
  if (isForward) {
    const cleaved = clipBasesIdxVisibleRange(
      segmentOhBasesStart,
      segmentOhBasesStart + cutPos,
      basesStartIdx,
      basesEndIdx
    );
    const retained = clipBasesIdxVisibleRange(
      segmentOhBasesStart + cutPos,
      segmentOhBasesEnd,
      basesStartIdx,
      basesEndIdx
    );
    const retainedBasesStart = Math.max(segmentOhBasesStart + cutPos, basesStartIdx);
    return {
      cleavedVisStart: cleaved.visStart,
      cleavedVisEnd: cleaved.visEnd,
      retainedVisStart: retained.visStart,
      retainedVisEnd: retained.visEnd,
      scar4bpIdxStart: retainedBasesStart - (segmentOhBasesStart + cutPos),
    };
  }
  const cutBasesPos = fullPrimerLength - cutPos;
  const retained = clipBasesIdxVisibleRange(
    segmentOhBasesStart,
    cutBasesPos,
    basesStartIdx,
    basesEndIdx
  );
  const cleaved = clipBasesIdxVisibleRange(
    cutBasesPos,
    segmentOhBasesEnd,
    basesStartIdx,
    basesEndIdx
  );
  const retainedBasesStart = Math.max(segmentOhBasesStart, basesStartIdx);
  return {
    cleavedVisStart: cleaved.visStart,
    cleavedVisEnd: cleaved.visEnd,
    retainedVisStart: retained.visStart,
    retainedVisEnd: retained.visEnd,
    scar4bpIdxStart: cutBasesPos - 1 - retainedBasesStart,
  };
}

function linearOverhangCutRanges(args: {
  isForward: boolean;
  cutPos: number;
  ohAbsStart: number;
  ohAbsEnd: number;
  visibleStart: number;
  visibleEnd: number;
  basesStartIdx: number;
  fullPrimerLength: number;
}): PrimerOverhangCutVisibleRanges {
  const {
    isForward,
    cutPos,
    ohAbsStart,
    ohAbsEnd,
    visibleStart,
    visibleEnd,
    basesStartIdx,
    fullPrimerLength,
  } = args;
  const cutAbsPos = isForward ? ohAbsStart + cutPos : ohAbsEnd - cutPos;
  const cleavedStart = isForward ? ohAbsStart : cutAbsPos;
  const cleavedEnd = isForward ? cutAbsPos : ohAbsEnd;
  const retainedStart = isForward ? cutAbsPos : ohAbsStart;
  const retainedEnd = isForward ? ohAbsEnd : cutAbsPos;
  const cleavedVisStart = Math.max(cleavedStart, visibleStart) - visibleStart;
  const cleavedVisEnd = Math.min(cleavedEnd, visibleEnd) - visibleStart;
  const retainedVisStart = Math.max(retainedStart, visibleStart) - visibleStart;
  const retainedVisEnd = Math.min(retainedEnd, visibleEnd) - visibleStart;
  const firstRetainedBasesIdx = basesStartIdx + retainedVisStart;
  const scar4bpIdxStart = isForward
    ? firstRetainedBasesIdx - cutPos
    : fullPrimerLength - 1 - firstRetainedBasesIdx - cutPos;
  return {
    cleavedVisStart,
    cleavedVisEnd,
    retainedVisStart,
    retainedVisEnd,
    scar4bpIdxStart,
  };
}

export function primerOverhangCutVisibleRanges(args: {
  primerSpansOrigin: boolean;
  sequenceLength: number | undefined;
  isForward: boolean;
  cutPos: number;
  overhangLen: number;
  fullPrimerLength: number;
  basesStartIdx: number;
  basesEndIdx: number;
  ohAbsStart: number;
  ohAbsEnd: number;
  visibleStart: number;
  visibleEnd: number;
}): PrimerOverhangCutVisibleRanges {
  if (args.primerSpansOrigin && args.sequenceLength !== undefined) {
    return originSpanningOverhangCutRanges(args);
  }
  return linearOverhangCutRanges(args);
}

function computeReversePrimerBandHeight(
  primers: PrimerDisplay[],
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number | undefined,
  isOriginLine: boolean,
  laneHeight: number
): number {
  const reverseLanePrimers = primers.filter(
    (primer) =>
      primer.direction === 'reverse' &&
      primerOverlapsLine(primer, lineStartPos, lineEndPos, sequenceLength, isOriginLine)
  );
  if (reverseLanePrimers.length === 0) return 0;
  return (
    (Math.max(
      ...packPrimerLanes(
        reverseLanePrimers,
        lineStartPos,
        lineEndPos,
        sequenceLength ?? lineEndPos
      ).laneMap.values()
    ) +
      1) *
    laneHeight
  );
}

function primerNucleotideMismatchSet(
  primer: PrimerDisplay,
  basesStartIdx: number,
  primerBasesLength: number
): Set<number> {
  const mismatchSet = new Set<number>();
  if (!primer.mismatches) return mismatchSet;
  for (const mm of primer.mismatches) {
    const visiblePos = mm.position - basesStartIdx;
    if (visiblePos >= 0 && visiblePos < primerBasesLength) {
      mismatchSet.add(visiblePos);
    }
  }
  return mismatchSet;
}

function primerLetterOligoIndex(args: {
  isForward: boolean;
  primerSpansOrigin: boolean;
  sequenceLength: number | undefined;
  primer: PrimerDisplay;
  segment: { isFirstPart?: boolean };
  absPos: number;
  basesStartIdx: number;
  letterIndex: number;
}): number {
  if (args.isForward) return args.basesStartIdx + args.letterIndex;
  if (args.primerSpansOrigin && args.sequenceLength !== undefined) {
    return args.segment.isFirstPart
      ? args.sequenceLength + args.primer.end - 1 - args.absPos
      : args.primer.end - 1 - args.absPos;
  }
  return args.primer.end - 1 - args.absPos;
}

function primerLetterPaintFlags(args: {
  primer: PrimerDisplay;
  basesStartIdx: number;
  letterIndex: number;
  oligoIndex: number;
  overhangLen: number;
  hasOverhang: boolean;
  ohTextBasesStart: number;
  ohTextBasesEnd: number;
  displayBase: string;
}): {
  isOverhangBase: boolean;
  isCleavedBase: boolean;
  isRecognitionBase: boolean;
  is4bpScar: boolean;
  isDegenerateBase: boolean;
  isInLiteralExtraSpacer: boolean;
} {
  const currentBasesIdx = args.basesStartIdx + args.letterIndex;
  const isOverhangBase =
    args.hasOverhang &&
    currentBasesIdx >= args.ohTextBasesStart &&
    currentBasesIdx < args.ohTextBasesEnd;
  const cutPosInOh = args.primer.cutPositionInOverhang;
  const isCleavedBase =
    isOverhangBase && cutPosInOh !== undefined && cutPosInOh > 0 && args.oligoIndex < cutPosInOh;
  const recogStart = args.primer.recognitionStart;
  const recogEnd = args.primer.recognitionEnd;
  const isRecognitionBase =
    recogStart !== undefined &&
    recogEnd !== undefined &&
    args.oligoIndex >= recogStart &&
    args.oligoIndex < recogEnd;
  const cutPos = args.primer.cutPositionInOverhang;
  const hasGoldenGateCut = cutPos !== undefined && cutPos > 0;
  const scar4bpIdx = hasGoldenGateCut ? args.oligoIndex - cutPos : -1;
  const spacerLen = args.primer.spacerLength ?? 0;
  return {
    isOverhangBase,
    isCleavedBase,
    isRecognitionBase,
    is4bpScar:
      hasGoldenGateCut && isOverhangBase && !isCleavedBase && scar4bpIdx >= 0 && scar4bpIdx < 4,
    isDegenerateBase: (IUPAC_DEGENERACY[args.displayBase.toUpperCase()] ?? 1) > 1,
    isInLiteralExtraSpacer:
      spacerLen > 0 &&
      args.oligoIndex >= args.overhangLen - spacerLen &&
      args.oligoIndex < args.overhangLen,
  };
}

function primerNucleotideFillAndFont(args: {
  isMismatch: boolean;
  isDegenerateBase: boolean;
  isCleavedBase: boolean;
  is4bpScar: boolean;
  isOverhangBase: boolean;
  isInLiteralExtraSpacer: boolean;
  isRecognitionBase: boolean;
  overhangColor: string;
  pbsColor: string;
  fontSize: number;
  fontFamily: string;
}): { fillStyle: string; font: string } {
  let fillStyle = args.pbsColor;
  if (args.isMismatch) {
    fillStyle = '#DC2626';
  } else if (args.isDegenerateBase) {
    fillStyle = getCanvasTheme().isDark
      ? PRIMER_COLORS.DEGENERATE_BASE_DARK
      : PRIMER_COLORS.DEGENERATE_BASE_LIGHT;
  } else if (args.isCleavedBase) {
    fillStyle = GOLDEN_GATE_JUNCTION_VISUAL.primer.cleavedColorHex;
  } else if (args.is4bpScar) {
    fillStyle = GOLDEN_GATE_JUNCTION_VISUAL.primer.scarBaseColorHex;
  } else if (args.isOverhangBase) {
    fillStyle = args.isInLiteralExtraSpacer
      ? GOLDEN_GATE_JUNCTION_VISUAL.primer.cleavedColorHex
      : args.overhangColor;
  }
  const font =
    args.isMismatch || args.isRecognitionBase || args.is4bpScar
      ? `${GOLDEN_GATE_JUNCTION_VISUAL.primer.scarBaseFontWeight} ${args.fontSize}px ${args.fontFamily}`
      : `${args.fontSize}px ${args.fontFamily}`;
  return { fillStyle, font };
}

function drawPrimerNucleotideLetters(args: {
  ctx: SequenceDrawingContext;
  primer: PrimerDisplay;
  primerBases: string;
  primerSpansOrigin: boolean;
  sequenceLength: number | undefined;
  basesStartIdx: number;
  barX: number;
  boxY: number;
  trackHeight: number;
  charWidth: number;
  config: WorkspaceEditorConfig;
  fontFamily: string;
  visibleStart: number;
  overhangLen: number;
  hasOverhang: boolean;
  pbsColor: string;
  overhangColor: string;
  segment: { isFirstPart?: boolean };
}): void {
  const {
    ctx,
    primer,
    primerBases,
    primerSpansOrigin,
    sequenceLength,
    basesStartIdx,
    barX,
    boxY,
    trackHeight,
    charWidth,
    config,
    fontFamily,
    visibleStart,
    overhangLen,
    hasOverhang,
    pbsColor,
    overhangColor,
    segment,
  } = args;
  ctx.font = `${config.fontSize - 1}px ${fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const mismatchSet = primerNucleotideMismatchSet(primer, basesStartIdx, primerBases.length);
  const isForward = primer.direction === 'forward';
  const fullPrimerLen =
    primerSpansOrigin && sequenceLength !== undefined
      ? sequenceLength - primer.start + primer.end
      : primer.end - primer.start;
  const fullPbsLen = fullPrimerLen - overhangLen;
  const ohTextBasesStart = isForward ? 0 : fullPbsLen;
  const ohTextBasesEnd = isForward ? overhangLen : fullPrimerLen;

  for (let i = 0; i < primerBases.length; i++) {
    const baseX = barX + i * charWidth + charWidth / 2;
    const isMismatch = mismatchSet.has(i);
    const absPos = visibleStart + i;
    const oligoIndex = primerLetterOligoIndex({
      isForward,
      primerSpansOrigin,
      sequenceLength,
      primer,
      segment,
      absPos,
      basesStartIdx,
      letterIndex: i,
    });
    const displayBase = isForward ? (primerBases[i] ?? '') : (primer.bases[oligoIndex] ?? '');
    const flags = primerLetterPaintFlags({
      primer,
      basesStartIdx,
      letterIndex: i,
      oligoIndex,
      overhangLen,
      hasOverhang,
      ohTextBasesStart,
      ohTextBasesEnd,
      displayBase,
    });
    const { fillStyle, font } = primerNucleotideFillAndFont({
      isMismatch,
      isDegenerateBase: flags.isDegenerateBase,
      isCleavedBase: flags.isCleavedBase,
      is4bpScar: flags.is4bpScar,
      isOverhangBase: flags.isOverhangBase,
      isInLiteralExtraSpacer: flags.isInLiteralExtraSpacer,
      isRecognitionBase: flags.isRecognitionBase,
      overhangColor,
      pbsColor,
      fontSize: config.fontSize,
      fontFamily: config.fontFamily,
    });
    ctx.fillStyle = fillStyle;
    ctx.font = font;
    ctx.fillText(displayBase, baseX, boxY + trackHeight / 2);
  }
}

function modificationAnchorDisplayOffset(
  marker: PrimerModificationDisplay,
  direction: PrimerDisplay['direction'],
  primerLength: number
): number {
  let oligoOffset: number;
  if (marker.anchor.kind === 'base') {
    oligoOffset = marker.anchor.index + 0.5;
  } else if (marker.anchor.kind === 'between-bases') {
    oligoOffset = marker.anchor.offset;
  } else {
    oligoOffset = marker.anchor.end === 'five-prime' ? 0 : primerLength;
  }
  return direction === 'forward' ? oligoOffset : primerLength - oligoOffset;
}

function drawPrimerModificationMarkers(
  ctx: SequenceDrawingContext,
  primer: PrimerDisplay,
  primerLength: number,
  basesStartIdx: number,
  basesEndIdx: number,
  barX: number,
  boxY: number,
  trackHeight: number,
  charWidth: number
): void {
  if (!primer.modificationMarkers?.length || charWidth <= 0 || trackHeight <= 0) return;

  const markers = primer.modificationMarkers
    .map((marker) => ({
      marker,
      displayOffset: modificationAnchorDisplayOffset(marker, primer.direction, primerLength),
    }))
    .filter(({ displayOffset }) => {
      const ownsPrimerEnd = displayOffset === primerLength && basesEndIdx === primerLength;
      return displayOffset >= basesStartIdx && (displayOffset < basesEndIdx || ownsPrimerEnd);
    })
    .sort((left, right) => left.displayOffset - right.displayOffset);
  if (markers.length === 0) return;

  const theme = getCanvasTheme();
  ctx.save();
  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = 1;

  for (const { marker, displayOffset } of markers) {
    const isBase = marker.anchor.kind === 'base';
    const markWidth = isBase ? charWidth * 0.65 : Math.min(3, charWidth * 0.3);
    const inset = Math.min(1, trackHeight * 0.1);
    const markHeight = Math.min(isBase ? 2 : 4, trackHeight - inset);
    const centerX = barX + (displayOffset - basesStartIdx) * charWidth;
    ctx.fillRect(
      centerX - markWidth / 2,
      boxY + trackHeight - markHeight - inset,
      markWidth,
      markHeight
    );
  }
  ctx.restore();
}

function drawSolidPrimerBar(args: {
  ctx: SequenceDrawingContext;
  barX: number;
  barWidth: number;
  boxY: number;
  trackHeight: number;
  triangleWidth: number;
  arrowHeight: number;
  arrowPosition: 'above' | 'below';
  showForwardArrow: boolean;
  showReverseArrow: boolean;
  isHoveredPrimer: boolean;
  pbsColor: string;
  primerStrokeWidth: number;
}): void {
  const {
    ctx,
    barX,
    barWidth,
    boxY,
    trackHeight,
    triangleWidth,
    arrowHeight,
    arrowPosition,
    showForwardArrow,
    showReverseArrow,
    isHoveredPrimer,
    pbsColor,
    primerStrokeWidth,
  } = args;
  ctx.beginPath();
  buildPrimerShapePath(
    ctx,
    barX,
    barWidth,
    boxY,
    trackHeight,
    triangleWidth,
    arrowHeight,
    arrowPosition,
    showForwardArrow,
    showReverseArrow
  );
  if (isHoveredPrimer) {
    ctx.save();
    ctx.fillStyle = pbsColor;
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = pbsColor;
  ctx.globalAlpha = PRIMER_CANVAS_CONSTANTS.PBS_FILL_OPACITY;
  ctx.fill();
  ctx.globalAlpha = 1.0;
  ctx.strokeStyle = pbsColor;
  ctx.lineWidth = primerStrokeWidth;
  ctx.stroke();
}

function drawGoldenGateCutIndicator(args: {
  ctx: SequenceDrawingContext;
  primer: PrimerDisplay;
  visibleStart: number;
  visibleEnd: number;
  barX: number;
  charWidth: number;
  sequenceLength: number | undefined;
  primerSpansOrigin: boolean;
  ohAbsStart: number;
  isForward: boolean;
  y: number;
  trackHeight: number;
  reversePrimerBandHeight: number;
  config: WorkspaceEditorConfig;
  hoveredGGLabel?: RenderedGGProductLabel | null;
  labelPositions?: Map<number, Array<{ x: number; width: number }>>;
  lineIndex?: number;
  renderedGGLabels?: RenderedGGProductLabel[];
}): void {
  const {
    ctx,
    primer,
    visibleStart,
    visibleEnd,
    barX,
    charWidth,
    sequenceLength,
    isForward,
    y,
    trackHeight,
    reversePrimerBandHeight,
    config,
    hoveredGGLabel,
    labelPositions,
    lineIndex,
    renderedGGLabels,
  } = args;
  const junctionVisual = resolveGoldenGateJunctionVisual(primer, sequenceLength ?? 0);
  if (!junctionVisual || !isForward) return;
  const cutAbsPos = junctionVisual.scarStart;

  let cutX = 0;
  let cutInSegment = false;
  if (cutAbsPos >= visibleStart && cutAbsPos < visibleEnd) {
    cutX = barX + (cutAbsPos - visibleStart) * charWidth;
    cutInSegment = true;
  }
  if (!cutInSegment) return;

  const rowHeight = config.rowHeight;
  const topStrandTop = y + trackHeight;
  const topStrandBottom = y + trackHeight + rowHeight;
  const bottomStrandBottom = y + trackHeight + 2 * rowHeight;
  const primerLabelGap = 4;
  const reversePrimerLaneHeight =
    reversePrimerBandHeight > 0 ? reversePrimerBandHeight + primerLabelGap : 0;
  const overhangBases = junctionVisual.scarLengthBp;
  const topCutX = cutX;
  const bottomCutX = cutX + overhangBases * charWidth;
  const scarStart = junctionVisual.scarStart;
  const scarEnd = junctionVisual.scarEnd;
  const isHovered =
    hoveredGGLabel !== undefined &&
    hoveredGGLabel !== null &&
    hoveredGGLabel.primer.id === primer.id &&
    hoveredGGLabel.scarStart === scarStart;
  const cutLineColor = getCanvasTheme().fg;

  ctx.beginPath();
  ctx.moveTo(topCutX, topStrandTop);
  ctx.lineTo(topCutX, topStrandBottom);
  ctx.lineTo(bottomCutX, topStrandBottom);
  ctx.lineTo(bottomCutX, bottomStrandBottom);
  ctx.strokeStyle = cutLineColor;
  ctx.lineWidth = isHovered
    ? GOLDEN_GATE_JUNCTION_VISUAL.cutLine.hoverWidthPx
    : GOLDEN_GATE_JUNCTION_VISUAL.cutLine.widthPx;
  ctx.stroke();

  if (!junctionVisual.identityLabel) return;

  const labelText = junctionVisual.identityLabel;
  const labelFontSize = GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.fontSizePx;
  ctx.font = isHovered
    ? `bold ${labelFontSize}px ${config.fontFamily}`
    : `${labelFontSize}px ${config.fontFamily}`;
  const labelPadding = GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.horizontalPaddingPx;
  const labelWidth =
    labelText.length *
      labelFontSize *
      GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.monospaceCharacterWidthEm +
    labelPadding * 2;
  const labelHeight =
    labelFontSize + GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.verticalPaddingPx * 2;
  const scarCenterX = topCutX + (bottomCutX - topCutX) / 2;
  const idealLabelX = scarCenterX - labelWidth / 2;
  let labelX = idealLabelX;

  if (labelPositions && lineIndex !== undefined) {
    const lineLabels = labelPositions.get(lineIndex) || [];
    let attempts = 0;
    const maxAttempts = 20;
    while (attempts < maxAttempts) {
      let hasOverlap = false;
      for (const existing of lineLabels) {
        if (labelX < existing.x + existing.width + 2 && labelX + labelWidth > existing.x - 2) {
          labelX = existing.x + existing.width + 4;
          hasOverlap = true;
          break;
        }
      }
      if (!hasOverlap) break;
      attempts++;
    }
    lineLabels.push({ x: labelX, width: labelWidth });
    labelPositions.set(lineIndex, lineLabels);
  }

  const labelY =
    bottomStrandBottom + reversePrimerLaneHeight + GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.gapPx;
  if (renderedGGLabels && lineIndex !== undefined) {
    renderedGGLabels.push({
      primer,
      labelBounds: { x: labelX, y: labelY, width: labelWidth, height: labelHeight },
      scarStart,
      scarEnd,
      lineIndex,
    });
  }

  const labelTopCenterX = labelX + labelWidth / 2;
  ctx.strokeStyle = cutLineColor;
  ctx.lineWidth = isHovered
    ? GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.hoverConnectorWidthPx
    : GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.connectorWidthPx;
  ctx.setLineDash([...GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.connectorDashPx]);
  ctx.beginPath();
  ctx.moveTo(scarCenterX, bottomStrandBottom);
  ctx.lineTo(labelTopCenterX, labelY);
  ctx.stroke();
  ctx.setLineDash([]);

  const theme = getCanvasTheme();
  ctx.fillStyle = isHovered
    ? theme.isDark
      ? GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.darkHoverBackgroundCss
      : GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.lightHoverBackgroundCss
    : theme.isDark
      ? GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.darkBackgroundCss
      : GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.lightBackgroundCss;
  ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
  ctx.strokeStyle = getCanvasTheme().fg;
  ctx.lineWidth = isHovered
    ? GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.hoverBorderWidthPx
    : GOLDEN_GATE_JUNCTION_VISUAL.identityLabel.borderWidthPx;
  ctx.strokeRect(labelX, labelY, labelWidth, labelHeight);
  ctx.fillStyle = getCanvasTheme().fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, labelX + labelWidth / 2, labelY + labelHeight / 2);
}

function buildPrimerShapePath(
  ctx: SequenceDrawingContext,
  x: number,
  width: number,
  boxY: number,
  trackHeight: number,
  triangleWidth: number,
  arrowHeight: number,
  arrowPosition: 'above' | 'below',
  showForward: boolean,
  showReverse: boolean
): void {
  if (showForward && width > triangleWidth) {
    if (arrowPosition === 'above') {
      ctx.moveTo(x, boxY);
      ctx.lineTo(x + width - triangleWidth, boxY);
      ctx.lineTo(x + width - triangleWidth, boxY - arrowHeight);
      ctx.lineTo(x + width, boxY);
      ctx.lineTo(x + width, boxY + trackHeight);
      ctx.lineTo(x, boxY + trackHeight);
      ctx.closePath();
    } else {
      ctx.moveTo(x, boxY);
      ctx.lineTo(x + width, boxY);
      ctx.lineTo(x + width, boxY + trackHeight);
      ctx.lineTo(x + width - triangleWidth, boxY + trackHeight + arrowHeight);
      ctx.lineTo(x + width - triangleWidth, boxY + trackHeight);
      ctx.lineTo(x, boxY + trackHeight);
      ctx.closePath();
    }
  } else if (showReverse && width > triangleWidth) {
    if (arrowPosition === 'above') {
      ctx.moveTo(x, boxY);
      ctx.lineTo(x + triangleWidth, boxY - arrowHeight);
      ctx.lineTo(x + triangleWidth, boxY);
      ctx.lineTo(x + width, boxY);
      ctx.lineTo(x + width, boxY + trackHeight);
      ctx.lineTo(x, boxY + trackHeight);
      ctx.closePath();
    } else {
      ctx.moveTo(x, boxY);
      ctx.lineTo(x + width, boxY);
      ctx.lineTo(x + width, boxY + trackHeight);
      ctx.lineTo(x + triangleWidth, boxY + trackHeight);
      ctx.lineTo(x + triangleWidth, boxY + trackHeight + arrowHeight);
      ctx.lineTo(x, boxY + trackHeight);
      ctx.closePath();
    }
  } else {
    ctx.rect(x, boxY, width, trackHeight);
  }
}

function primersVisibleOnLine(args: {
  primers: PrimerDisplay[];
  lineStartPos: number;
  lineEndPos: number;
  sequenceLength: number | undefined;
  directionFilter: 'forward' | 'reverse' | undefined;
  rowHeight: number;
}): {
  isOriginLine: boolean;
  linePrimers: PrimerDisplay[];
  laneMap: Map<string, number>;
  laneHeight: number;
  reversePrimerBandHeight: number;
} | null {
  const isOriginLine = lineSpansOrigin(args.lineStartPos, args.lineEndPos);
  const linePrimers = args.primers.filter((primer) => {
    if (args.directionFilter && primer.direction !== args.directionFilter) return false;
    return primerOverlapsLine(
      primer,
      args.lineStartPos,
      args.lineEndPos,
      args.sequenceLength,
      isOriginLine
    );
  });
  if (linePrimers.length === 0) return null;
  const { laneMap } = packPrimerLanes(
    linePrimers,
    args.lineStartPos,
    args.lineEndPos,
    args.sequenceLength ?? args.lineEndPos
  );
  const laneHeight =
    args.rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  const reversePrimerBandHeight = computeReversePrimerBandHeight(
    args.primers,
    args.lineStartPos,
    args.lineEndPos,
    args.sequenceLength,
    isOriginLine,
    laneHeight
  );
  return { isOriginLine, linePrimers, laneMap, laneHeight, reversePrimerBandHeight };
}

export function drawPrimers(
  ctx: SequenceDrawingContext,
  primers: PrimerDisplay[],
  lineStartPos: number,
  lineEndPos: number,
  x: number,
  y: number,
  config: WorkspaceEditorConfig,
  directionFilter?: 'forward' | 'reverse',
  arrowPosition: 'above' | 'below' = 'above',
  sequenceLength?: number,
  labelPositions?: Map<number, Array<{ x: number; width: number }>>,
  lineIndex?: number,
  renderedGGLabels?: RenderedGGProductLabel[],
  hoveredGGLabel?: RenderedGGProductLabel | null,
  hoveredPrimerId?: string | null,
  selectedPrimerId?: string | null
): Map<string, number> {
  const { charWidth, rowHeight, fontFamily } = config;
  const trackHeight = rowHeight * PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO;
  const defaultPbsColor = GOLDEN_GATE_JUNCTION_VISUAL.primer.defaultPbsColorHex;
  const defaultOverhangColor = GOLDEN_GATE_JUNCTION_VISUAL.primer.defaultOverhangColorHex;

  const visible = primersVisibleOnLine({
    primers,
    lineStartPos,
    lineEndPos,
    sequenceLength,
    directionFilter,
    rowHeight,
  });
  if (!visible) return new Map();
  const { isOriginLine, linePrimers, laneMap, laneHeight, reversePrimerBandHeight } = visible;

  for (const primer of linePrimers) {
    const savedAlpha = ctx.globalAlpha;
    const savedLineDash = ctx.getLineDash();
    const savedLineWidth = ctx.lineWidth;
    const isHoveredPrimer = hoveredPrimerId === primer.id;
    const isSelectedPrimer = selectedPrimerId === primer.id;
    if (primer.isDraft || primer.isCandidate) {
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 3]);
    }

    const primerSpansOrigin = primer.start > primer.end;
    const segments = visiblePrimerSegments(
      primer,
      lineStartPos,
      lineEndPos,
      sequenceLength,
      isOriginLine
    );

    for (const segment of segments) {
      const visibleStart = segment.start;
      const visibleEnd = segment.end;
      if (visibleEnd <= visibleStart) continue;

      const { basesStartIdx, basesEndIdx } = primerSegmentBaseRange(
        primer,
        segment,
        sequenceLength
      );
      const primerBases = primer.bases.substring(basesStartIdx, basesEndIdx);

      const barX = x + segment.charIndexStart * charWidth;
      const barWidth = (visibleEnd - visibleStart) * charWidth;

      const { showForwardArrow, showReverseArrow } = primerSegmentArrowFlags(
        primer,
        segment,
        visibleStart,
        visibleEnd,
        primerSpansOrigin
      );

      const arrowHeight = rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_HEIGHT_RATIO;
      const triangleWidth = rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_WIDTH_RATIO;
      const primerStrokeWidth = rowHeight * PRIMER_CANVAS_CONSTANTS.STROKE_WIDTH_RATIO;
      const primerLane = laneMap.get(primer.id) ?? 0;
      const boxY = y + primerLane * laneHeight - 1;

      if (isSelectedPrimer) {
        ctx.lineWidth = primerStrokeWidth * 2;
      }

      const rawOverhangLen = primer.overhangLength ?? 0;
      const pbsColor = primer.pbsColor ?? defaultPbsColor;
      const overhangColor = primer.overhangColor ?? defaultOverhangColor;
      const fullPrimerLength =
        primerSpansOrigin && sequenceLength !== undefined
          ? sequenceLength - primer.start + primer.end
          : primer.end - primer.start;
      const overhangLen = Math.max(0, Math.min(rawOverhangLen, fullPrimerLength));
      const hasOverhang = overhangLen > 0;

      if (hasOverhang) {
        const {
          isForward,
          ohAbsStart,
          ohAbsEnd,
          ohVisibleStart,
          ohVisibleEnd,
          pbsVisibleStart,
          pbsVisibleEnd,
        } = primerOverhangVisibleRanges({
          primer,
          primerSpansOrigin,
          sequenceLength,
          overhangLen,
          fullPrimerLength,
          visibleStart,
          visibleEnd,
          basesStartIdx,
          basesEndIdx,
        });

        if (pbsVisibleEnd > pbsVisibleStart && !primer.isScarMarkerOnly) {
          const pbsX = barX + pbsVisibleStart * charWidth;
          const pbsWidth = (pbsVisibleEnd - pbsVisibleStart) * charWidth;

          ctx.beginPath();
          buildPrimerShapePath(
            ctx,
            pbsX,
            pbsWidth,
            boxY,
            trackHeight,
            triangleWidth,
            arrowHeight,
            arrowPosition,
            showForwardArrow && isForward,
            showReverseArrow && !isForward
          );
          ctx.fillStyle = pbsColor;
          ctx.globalAlpha = PRIMER_CANVAS_CONSTANTS.PBS_FILL_OPACITY;
          ctx.fill();
          ctx.globalAlpha = 1.0;

          ctx.beginPath();
          ctx.strokeStyle = pbsColor;
          ctx.lineWidth = primerStrokeWidth;
          if (showForwardArrow && isForward && pbsWidth > triangleWidth) {
            if (arrowPosition === 'above') {
              ctx.moveTo(pbsX, boxY);
              ctx.lineTo(pbsX + pbsWidth - triangleWidth, boxY);
              ctx.lineTo(pbsX + pbsWidth - triangleWidth, boxY - arrowHeight);
              ctx.lineTo(pbsX + pbsWidth, boxY);
              ctx.lineTo(pbsX + pbsWidth, boxY + trackHeight);
              ctx.lineTo(pbsX, boxY + trackHeight);
            } else {
              ctx.moveTo(pbsX, boxY);
              ctx.lineTo(pbsX + pbsWidth, boxY);
              ctx.lineTo(pbsX + pbsWidth, boxY + trackHeight);
              ctx.lineTo(pbsX + pbsWidth - triangleWidth, boxY + trackHeight + arrowHeight);
              ctx.lineTo(pbsX + pbsWidth - triangleWidth, boxY + trackHeight);
              ctx.lineTo(pbsX, boxY + trackHeight);
            }
          } else if (showReverseArrow && !isForward && pbsWidth > triangleWidth) {
            if (arrowPosition === 'above') {
              ctx.moveTo(pbsX, boxY + trackHeight);
              ctx.lineTo(pbsX, boxY);
              ctx.lineTo(pbsX + triangleWidth, boxY - arrowHeight);
              ctx.lineTo(pbsX + triangleWidth, boxY);
              ctx.lineTo(pbsX + pbsWidth, boxY);
              ctx.moveTo(pbsX + pbsWidth, boxY + trackHeight);
              ctx.lineTo(pbsX, boxY + trackHeight);
            } else {
              ctx.moveTo(pbsX, boxY);
              ctx.lineTo(pbsX + pbsWidth, boxY);
              ctx.moveTo(pbsX + pbsWidth, boxY + trackHeight);
              ctx.lineTo(pbsX + triangleWidth, boxY + trackHeight);
              ctx.lineTo(pbsX + triangleWidth, boxY + trackHeight + arrowHeight);
              ctx.lineTo(pbsX, boxY + trackHeight);
              ctx.lineTo(pbsX, boxY);
            }
          } else {
            ctx.moveTo(pbsX, boxY);
            ctx.lineTo(pbsX + pbsWidth, boxY);
            ctx.moveTo(pbsX, boxY + trackHeight);
            ctx.lineTo(pbsX + pbsWidth, boxY + trackHeight);
          }
          ctx.stroke();
        }

        if (ohVisibleEnd > ohVisibleStart && !primer.isScarMarkerOnly) {
          const cutPos = primer.cutPositionInOverhang;

          if (cutPos !== undefined && cutPos > 0) {
            const {
              cleavedVisStart,
              cleavedVisEnd,
              retainedVisStart,
              retainedVisEnd,
              scar4bpIdxStart,
            } = primerOverhangCutVisibleRanges({
              primerSpansOrigin,
              sequenceLength,
              isForward,
              cutPos,
              overhangLen,
              fullPrimerLength,
              basesStartIdx,
              basesEndIdx,
              ohAbsStart,
              ohAbsEnd,
              visibleStart,
              visibleEnd,
            });

            const overhangContext: OverhangDrawingContext = {
              ctx,
              barX,
              boxY,
              trackHeight,
              charWidth,
              pbsColor,
              overhangColor,
              isForward,
            };

            drawCleavedPortion(overhangContext, cleavedVisStart, cleavedVisEnd);

            const retainedParams: GoldenGateOverhangParams = {
              cleavedVisStart,
              cleavedVisEnd,
              retainedVisStart,
              retainedVisEnd,
              scar4bpIdxStart,
              cognate4bpLength: primer.cognate4bpLength ?? 0,
              synthetic4bpSpacerLength: primer.synthetic4bpSpacerLength,
              spacerLength: primer.spacerLength,
            };
            drawRetainedPortion(overhangContext, retainedParams);
          } else {
            const gibsonContext: OverhangDrawingContext = {
              ctx,
              barX,
              boxY,
              trackHeight,
              charWidth,
              pbsColor,
              overhangColor,
              isForward,
            };

            let ohOffsetWithinTotal = 0;
            if (primerSpansOrigin && sequenceLength !== undefined) {
              if (isForward) {
                ohOffsetWithinTotal = basesStartIdx;
              } else {
                const fullPbsLen = fullPrimerLength - overhangLen;
                ohOffsetWithinTotal = Math.max(0, basesStartIdx - fullPbsLen);
              }
            } else {
              ohOffsetWithinTotal = Math.max(0, visibleStart - ohAbsStart);
            }

            drawGibsonOverhang(gibsonContext, {
              ohVisibleStart,
              ohVisibleEnd,
              spacerLength: primer.spacerLength,
              ohOffsetWithinTotal,
              totalOverhangLen: overhangLen,
            });
          }
        }

        drawGoldenGateCutIndicator({
          ctx,
          primer,
          visibleStart,
          visibleEnd,
          barX,
          charWidth,
          sequenceLength,
          primerSpansOrigin,
          ohAbsStart,
          isForward,
          y,
          trackHeight,
          reversePrimerBandHeight,
          config,
          hoveredGGLabel,
          labelPositions,
          lineIndex,
          renderedGGLabels,
        });
      } else {
        drawSolidPrimerBar({
          ctx,
          barX,
          barWidth,
          boxY,
          trackHeight,
          triangleWidth,
          arrowHeight,
          arrowPosition,
          showForwardArrow,
          showReverseArrow,
          isHoveredPrimer,
          pbsColor,
          primerStrokeWidth,
        });
      }

      if (
        barWidth >= charWidth &&
        charWidth >= TEXT_VISIBILITY_THRESHOLD_PX &&
        !primer.isScarMarkerOnly
      ) {
        drawPrimerNucleotideLetters({
          ctx,
          primer,
          primerBases,
          primerSpansOrigin,
          sequenceLength,
          basesStartIdx,
          barX,
          boxY,
          trackHeight,
          charWidth,
          config,
          fontFamily,
          visibleStart,
          overhangLen,
          hasOverhang,
          pbsColor,
          overhangColor,
          segment,
        });

        const fullPrimerLen =
          primerSpansOrigin && sequenceLength !== undefined
            ? sequenceLength - primer.start + primer.end
            : primer.end - primer.start;
        drawPrimerModificationMarkers(
          ctx,
          primer,
          fullPrimerLen,
          basesStartIdx,
          basesEndIdx,
          barX,
          boxY,
          trackHeight,
          charWidth
        );
      }
    }

    if (primer.isDraft || primer.isCandidate) {
      ctx.globalAlpha = savedAlpha;
      ctx.setLineDash(savedLineDash);
    }
    ctx.lineWidth = savedLineWidth;
  }

  return laneMap;
}

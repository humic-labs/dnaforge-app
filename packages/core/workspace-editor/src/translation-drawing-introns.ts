import { paintIntronTicks, type IntronConnectorStroke } from './transcript-drawing';
import type { SequenceDrawingContext } from './rendering/drawing-context';
import type { ClassifiedCDS } from './types';
import type { AnnotationRenderStateInput } from './annotation-render-state';
import { paintCdsCompoundChip } from './cds-chip-drawing';
import { CHEVRON_WIDTH_RATIO } from './rendering';
import { getCachedSplicedSequence } from './translation';
import { TRANSLATION_LABEL_FONT_SIZE } from './layout-constants';

export function paintSplicedCdsIntronConnectors(args: {
  ctx: SequenceDrawingContext;
  cds: ClassifiedCDS;
  fullSequence: string;
  lineStartPos: number;
  lineEndPos: number;
  sequenceLength: number;
  x: number;
  charWidth: number;
  aaY: number;
  aaTrackHeight: number;
  lineY?: number;
  cohesiveGlyph?: boolean;
  chevronDepth?: number;
  annotationRenderStateInput?: AnnotationRenderStateInput;
  cdsColor: string;
  fontFamily: string;
  onIntronConnector?: (stroke: IntronConnectorStroke) => void;
  translationOptions?: {
    viewportLeftX?: number;
    viewportRightX?: number;
  };
}): void {
  const {
    ctx,
    cds,
    fullSequence,
    lineStartPos,
    lineEndPos,
    sequenceLength,
    x,
    charWidth,
    aaY,
    aaTrackHeight,
    cdsColor,
    fontFamily,
    translationOptions,
  } = args;
  const splicedSeq = getCachedSplicedSequence(cds, fullSequence);
  const intronLineThickness = 1;
  const intronChevronDepth = args.chevronDepth ?? Math.round(aaTrackHeight * CHEVRON_WIDTH_RATIO);
  const intronDirection = (cds.direction ?? 1) as 1 | -1;

  for (const intron of splicedSeq.introns) {
    const intronStart0 = intron.genomicStart;
    const intronEnd0 = intron.genomicEnd;
    const intronSpansOrigin = intronEnd0 < intronStart0;
    const lineSpansOrigin2 = lineStartPos > lineEndPos;

    const intronRanges: Array<[number, number]> = intronSpansOrigin
      ? [
          [intronStart0, sequenceLength - 1],
          [0, intronEnd0],
        ]
      : [[intronStart0, intronEnd0]];
    const lineRanges: Array<[number, number]> = lineSpansOrigin2
      ? [
          [lineStartPos, sequenceLength - 1],
          [0, lineEndPos - 1],
        ]
      : [[lineStartPos, lineEndPos - 1]];

    const visibleRanges: Array<{ visStart: number; visEnd: number }> = [];
    for (const [iS, iE] of intronRanges) {
      for (const [lS, lE] of lineRanges) {
        const oStart = Math.max(iS, lS);
        const oEnd = Math.min(iE, lE);
        if (oStart <= oEnd) {
          visibleRanges.push({ visStart: oStart, visEnd: oEnd });
        }
      }
    }
    if (visibleRanges.length === 0) continue;

    let totalIntronX1 = Infinity;
    let totalIntronX2 = -Infinity;
    for (const vr of visibleRanges) {
      const sci =
        lineSpansOrigin2 && vr.visStart < lineStartPos
          ? sequenceLength - lineStartPos + vr.visStart
          : vr.visStart - lineStartPos;
      const eci =
        lineSpansOrigin2 && vr.visEnd < lineStartPos
          ? sequenceLength - lineStartPos + vr.visEnd
          : vr.visEnd - lineStartPos;
      totalIntronX1 = Math.min(totalIntronX1, x + sci * charWidth);
      totalIntronX2 = Math.max(totalIntronX2, x + (eci + 1) * charWidth);
    }
    const lineY = args.lineY ?? aaY + aaTrackHeight / 2;

    for (const vr of visibleRanges) {
      const sci =
        lineSpansOrigin2 && vr.visStart < lineStartPos
          ? sequenceLength - lineStartPos + vr.visStart
          : vr.visStart - lineStartPos;
      const eci =
        lineSpansOrigin2 && vr.visEnd < lineStartPos
          ? sequenceLength - lineStartPos + vr.visEnd
          : vr.visEnd - lineStartPos;

      let lx1 = x + sci * charWidth;
      let lx2 = x + (eci + 1) * charWidth;

      if (vr.visStart === intronStart0) lx1 += intronDirection === 1 ? intronChevronDepth : 0;
      if (vr.visEnd === intronEnd0) lx2 -= intronDirection === -1 ? intronChevronDepth : 0;

      ctx.save();
      ctx.strokeStyle = cdsColor;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = intronLineThickness;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(lx1, lineY);
      ctx.lineTo(lx2, lineY);
      ctx.stroke();
      args.onIntronConnector?.({
        annotationName: cds.name,
        annotationType: cds.type,
        annotationStart: cds.start,
        annotationEnd: cds.end,
        direction: intronDirection,
        intronStart: intronStart0,
        intronEnd: intronEnd0 + 1,
        x1: lx1,
        x2: lx2,
        y: lineY,
      });
      ctx.restore();
      paintIntronTicks(
        ctx,
        vr.visStart,
        vr.visEnd + 1,
        intronRanges.find(([start, end]) => vr.visStart >= start && vr.visEnd <= end)?.[0] ??
          intronStart0,
        (intronRanges.find(([start, end]) => vr.visStart >= start && vr.visEnd <= end)?.[1] ??
          intronEnd0) + 1,
        charWidth,
        (bp) => x + (sci + bp - vr.visStart) * charWidth,
        lineY,
        intronDirection,
        cdsColor,
        1,
        args.cohesiveGlyph
          ? [
              ...(cds._cdsPillBounds ?? []),
              ...(cds._exonPillBounds ?? []),
              ...(cds._intronPillBounds ?? []),
            ]
              .filter(
                (p) => p.y !== undefined && p.y <= lineY + 3 && p.y + (p.h ?? 14) >= lineY - 3
              )
              .map((p) => ({ left: p.x - 2, right: p.x + p.w + 2 }))
          : []
      );
    }

    if (args.cohesiveGlyph) continue;
    const totalIntronWidth = totalIntronX2 - totalIntronX1;
    if (totalIntronWidth <= 80) continue;
    const displayIntronNum =
      intronDirection === -1 ? splicedSeq.introns.length - intron.number + 1 : intron.number;
    const label = `intron ${displayIntronNum} (${intron.length} bp)`;
    ctx.save();
    ctx.font = `500 ${TRANSLATION_LABEL_FONT_SIZE}px ${fontFamily}`;
    const nameWidth = ctx.measureText(cds.name).width + 12;
    const descriptionWidth = ctx.measureText(label).width + 12;
    const gap = 4;
    const desiredWidth = nameWidth + descriptionWidth + gap;
    const pillWidth = Math.min(desiredWidth, totalIntronWidth);
    const ratio = (pillWidth - gap) / (desiredWidth - gap);
    const vpL = translationOptions?.viewportLeftX,
      vpR = translationOptions?.viewportRightX;
    const visibleLeft = Math.max(totalIntronX1, vpL ?? totalIntronX1);
    const visibleRight = Math.min(totalIntronX2, vpR ?? totalIntronX2);
    const pillX = Math.max(
      totalIntronX1,
      Math.min(totalIntronX2 - pillWidth, (visibleLeft + visibleRight - pillWidth) / 2)
    );
    const pillY = lineY - 7;
    const parts = [
      { text: cds.name, x: pillX, width: nameWidth * ratio },
      { text: label, x: pillX + nameWidth * ratio + gap, width: descriptionWidth * ratio },
    ];
    paintCdsCompoundChip(
      ctx,
      parts,
      pillY,
      cds,
      cdsColor,
      fontFamily,
      args.annotationRenderStateInput
    );
    cds._cdsPillBounds ??= [];
    cds._cdsPillBounds.push({ x: parts[0].x, w: parts[0].width, y: pillY, h: 14 });
    cds._intronPillBounds ??= [];
    cds._intronPillBounds.push({
      x: parts[1].x,
      w: parts[1].width,
      y: pillY,
      h: 14,
      rangeStart: intronStart0,
      rangeEnd: intronEnd0,
    });
    ctx.restore();
  }
}

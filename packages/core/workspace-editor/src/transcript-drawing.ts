import { intronTickAlpha, intronTickPitch, TRANSCRIPT_INTRON_STYLE } from '@waypoint/platform';
import type { Annotation } from '@waypoint/sequence-utils';
import type { TranscriptAnnotation } from './transcript-render-data';
import type { SequenceDrawingContext } from './rendering/drawing-context';
import { getVisibleRangeSegments } from './utils/range-utils';

export interface IntronConnectorStroke {
  annotationName: string;
  annotationType: string;
  annotationStart: number;
  annotationEnd: number;
  direction: number;
  intronStart: number;
  intronEnd: number;
  x1: number;
  x2: number;
  y: number;
}

export interface AminoAcidIntronOwner {
  codingSegments: NonNullable<Annotation['segments']>;
  direction: number;
  introns: ReadonlyArray<{ start: number; end: number }>;
}

export function paintTranscriptGlyph(args: {
  ctx: SequenceDrawingContext;
  annotation: Annotation;
  lineStart: number;
  lineEnd: number;
  sequenceLength: number;
  x: number;
  y: number;
  charWidth: number;
  height: number;
  color: string;
  alpha?: number;
  outlineOnly?: boolean;
  showIntronConnectors?: boolean;
  aminoAcidIntronOwners?: readonly AminoAcidIntronOwner[];
  onIntronConnector?: (stroke: IntronConnectorStroke) => void;
  lineWidth?: number;
  dash?: number[];
}): void {
  const { ctx, annotation: ann, x, y, charWidth, height, color } = args;
  const exons = (ann.segments?.length ? ann.segments : [{ start: ann.start, end: ann.end }])
    .slice()
    .sort((a, b) => {
      const distance = (start: number) =>
        (start - ann.start + args.sequenceLength) % args.sequenceLength;
      return ann.start > ann.end ? distance(a.start) - distance(b.start) : a.start - b.start;
    });
  const direction = ann.direction ?? 1;
  const coding = (ann as TranscriptAnnotation).codingSegments;
  const owners =
    coding &&
    args.aminoAcidIntronOwners?.filter(
      (owner) =>
        owner.direction === direction &&
        owner.codingSegments.length === coding.length &&
        coding.every((segment) =>
          owner.codingSegments.some(
            (other) => other.start === segment.start && other.end === segment.end
          )
        )
    );
  const midY = y + height / 2;
  const visible = (start: number, end: number) =>
    (start > end
      ? [
          [start, args.sequenceLength],
          [0, end],
        ]
      : [[start, end]]
    ).flatMap(([lo, hi]) =>
      getVisibleRangeSegments(lo, hi, args.lineStart, args.lineEnd, args.sequenceLength)
    );
  if (!visible(ann.start - 1, ann.end).length) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = (args.alpha ?? 1) * 0.7;
  ctx.lineWidth = Math.max(1, height * TRANSCRIPT_INTRON_STYLE.heightRatio);
  ctx.setLineDash(args.dash ?? []);
  const gaps = (args.showIntronConnectors === false ? [] : exons.slice(0, -1)).flatMap(
    (exon, i) => {
      const next = exons[i + 1];
      const crossesOrigin = ann.start > ann.end && next.start < exon.start;
      const gapLength = crossesOrigin
        ? args.sequenceLength - exon.end + next.start - 1
        : next.start - exon.end - 1;
      const owned = owners?.some((owner) =>
        owner.introns.some((gap) => gap.start === exon.end && gap.end === next.start - 1)
      );
      return gapLength > 1 && !owned ? [[exon.end, next.start - 1] as const] : [];
    }
  );
  for (const [start, end] of gaps)
    for (const segment of visible(start, end)) {
      ctx.beginPath();
      ctx.moveTo(x + segment.charIndexStart * charWidth, midY);
      ctx.lineTo(x + (segment.charIndexStart + segment.end - segment.start) * charWidth, midY);
      ctx.stroke();
      args.onIntronConnector?.({
        annotationName: ann.name,
        annotationType: ann.type,
        annotationStart: ann.start,
        annotationEnd: ann.end,
        direction,
        intronStart: start,
        intronEnd: end,
        x1: x + segment.charIndexStart * charWidth,
        x2: x + (segment.charIndexStart + segment.end - segment.start) * charWidth,
        y: midY,
      });
    }
  for (const [start, end] of gaps) {
    for (const segment of visible(start, end)) {
      const lo = start > end && segment.start < start ? 0 : start;
      const hi = start > end && segment.start >= start ? args.sequenceLength : end;
      paintIntronTicks(
        ctx,
        segment.start,
        segment.end,
        lo,
        hi,
        charWidth,
        (bp) => x + (segment.charIndexStart + bp - segment.start) * charWidth,
        midY,
        direction,
        color,
        args.alpha ?? 1
      );
    }
  }
  ctx.globalAlpha = args.alpha ?? 1;
  ctx.lineWidth = args.lineWidth ?? 1.5;
  ctx.setLineDash(args.dash ?? []);
  for (const exon of exons)
    for (const whole of visible(exon.start - 1, exon.end)) {
      const cuts = [
        ...new Set([
          whole.start,
          whole.end,
          ...(coding ?? [])
            .flatMap((c) => [c.start - 1, c.end])
            .filter((bp) => bp > whole.start && bp < whole.end),
        ]),
      ].sort((a, b) => a - b);
      for (let part = 0; part < cuts.length - 1; part++) {
        const segment = {
          start: cuts[part],
          end: cuts[part + 1],
          charIndexStart: whole.charIndexStart + cuts[part] - whole.start,
        };
        const left = x + segment.charIndexStart * charWidth;
        const width = (segment.end - segment.start) * charWidth;
        const coding = (ann as TranscriptAnnotation).codingSegments;
        const isCoding =
          ann.type === 'CDS' ||
          coding?.some((c) => c.start - 1 <= segment.start && c.end >= segment.end);
        const blockHeight = isCoding
          ? height
          : Math.max(4, height * TRANSCRIPT_INTRON_STYLE.utrHeightRatio);
        const top = midY - blockHeight / 2;
        const arrow = Math.min(blockHeight * 0.6, width * 0.3, 8);
        const terminal =
          direction === -1 ? segment.start === exon.start - 1 : segment.end === exon.end;
        const tip = terminal && width > 2 * arrow ? arrow : 0;
        ctx.beginPath();
        if (direction === -1) {
          ctx.moveTo(left + tip, top);
          ctx.lineTo(left + width, top);
          ctx.lineTo(left + width, top + blockHeight);
          ctx.lineTo(left + tip, top + blockHeight);
          if (tip) ctx.lineTo(left, midY);
        } else {
          ctx.moveTo(left, top);
          ctx.lineTo(left + width - tip, top);
          if (tip) ctx.lineTo(left + width, midY);
          ctx.lineTo(left + width - tip, top + blockHeight);
          ctx.lineTo(left, top + blockHeight);
        }
        ctx.closePath();
        if (args.outlineOnly) ctx.stroke();
        else ctx.fill();
      }
    }
  ctx.restore();
}

export function paintIntronTicks(
  ctx: SequenceDrawingContext,
  visibleStart: number,
  visibleEnd: number,
  intronStart: number,
  intronEnd: number,
  charWidth: number,
  xForBp: (bp: number) => number,
  y: number,
  direction: number,
  color: string,
  alpha = 1,
  hiddenSpans: readonly { left: number; right: number }[] = []
): void {
  const opacity = intronTickAlpha((intronEnd - intronStart) * charWidth) * alpha;
  const pitch = intronTickPitch(charWidth);
  if (opacity <= 0 || !Number.isFinite(pitch)) return;
  const lo = Math.max(intronStart + 1, visibleStart);
  const hi = Math.min(intronEnd - 1, visibleEnd);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  const tip = direction * TRANSCRIPT_INTRON_STYLE.tickHalfWidth;
  for (let bp = Math.ceil(lo / pitch) * pitch; bp <= hi; bp += pitch) {
    const center = xForBp(bp);
    if (
      hiddenSpans.some(
        (span) => center + Math.abs(tip) >= span.left && center - Math.abs(tip) <= span.right
      )
    )
      continue;
    ctx.moveTo(center - tip, y - TRANSCRIPT_INTRON_STYLE.tickHalfHeight);
    ctx.lineTo(center + tip, y);
    ctx.lineTo(center - tip, y + TRANSCRIPT_INTRON_STYLE.tickHalfHeight);
  }
  ctx.stroke();
  ctx.restore();
}

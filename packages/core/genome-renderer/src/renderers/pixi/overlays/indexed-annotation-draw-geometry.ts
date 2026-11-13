import { TRANSCRIPT_INTRON_STYLE, intronTickPitch, intronTickAlpha } from '@waypoint/platform';
import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { isLaneRangeVisibleInViewport } from '../shared/lane-path';
import { clampedLanePillPlacement } from '../shared/lane-path';
import { measurePillLabelTextWidth, PILL_LABEL_PADDING } from '../shared/label-pill';
import { screenDistanceFromFeatureStart } from './annotation-feature-geometry';
import { transcriptColorForMode } from '../../../feature-colors';

const LABEL_PADDING = PILL_LABEL_PADDING;

export function cdsChevronStartBp(path: PathMapper, startBp: number): number {
  return path.isArcMode ? startBp - 0.5 : startBp;
}

export function cdsChevronEndBp(path: PathMapper, endBp: number): number {
  return path.isArcMode ? endBp - 0.5 : endBp;
}

export function computeSplicedExonLabels(
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  offset: number,
  nameBlockW: number,
  namePillStartBp: number,
  genomeLength: number
): {
  appended: Array<{
    label: string;
    outerWidth: number;
    textBlockWidth: number;
    separatorBefore: number;
    separatorWidth: number;
    separatorAfter: number;
    rangeStart: number;
    rangeEnd: number;
  }>;
  floating: Array<{
    label: string;
    widthPx: number;
    startBp: number;
    rangeStart: number;
    rangeEnd: number;
  }>;
} {
  const segments = feature.segments ?? [];
  const isReverse = feature.direction === 'reverse';
  const totalExons = segments.length;
  const sepWidth = 1;
  const sepGap = 3;
  const appended: Array<{
    label: string;
    outerWidth: number;
    textBlockWidth: number;
    separatorBefore: number;
    separatorWidth: number;
    separatorAfter: number;
    rangeStart: number;
    rangeEnd: number;
  }> = [];
  const floating: Array<{
    label: string;
    widthPx: number;
    startBp: number;
    rangeStart: number;
    rangeEnd: number;
  }> = [];

  const candidates: Array<{
    label: string;
    textBlockWidth: number;
    requestedWidthPx: number;
    startBp: number;
    endExclusiveBp: number;
    distanceFromFeatureStartPx: number;
    rangeStart: number;
    rangeEnd: number;
  }> = [];

  for (let si = 0; si < totalExons; si++) {
    const segment = segments[si];
    const startBp = segment.start - 1;
    const exonNum = isReverse ? totalExons - si : si + 1;
    const exonBp =
      segment.end >= segment.start
        ? segment.end - segment.start + 1
        : genomeLength - segment.start + 1 + segment.end;
    const label = `exon ${exonNum} (${exonBp} bp)`;
    const textBlockWidth = measurePillLabelTextWidth(label) + LABEL_PADDING;
    const requestedWidthPx = textBlockWidth + LABEL_PADDING;
    const exonEndExclusive = segment.end;
    if (
      !isLaneRangeVisibleInViewport(
        path,
        state.width,
        state.height,
        startBp,
        exonEndExclusive,
        offset,
        genomeLength
      )
    ) {
      continue;
    }
    const distanceFromFeatureStartPx = screenDistanceFromFeatureStart(
      feature.start,
      startBp,
      genomeLength,
      path.pixelsPerBp
    );

    candidates.push({
      label,
      textBlockWidth,
      requestedWidthPx,
      startBp,
      endExclusiveBp: exonEndExclusive,
      distanceFromFeatureStartPx,
      rangeStart: startBp,
      rangeEnd: segment.end - 1,
    });
  }

  candidates.sort((a, b) => a.distanceFromFeatureStartPx - b.distanceFromFeatureStartPx);

  const namePillDistancePx = screenDistanceFromFeatureStart(
    feature.start,
    namePillStartBp,
    genomeLength,
    path.pixelsPerBp
  );
  for (const candidate of candidates) {
    if (candidate.distanceFromFeatureStartPx <= namePillDistancePx + nameBlockW + 10) {
      const outerWidth = sepGap + sepWidth + sepGap + candidate.textBlockWidth;
      appended.push({
        label: candidate.label,
        outerWidth,
        textBlockWidth: candidate.textBlockWidth,
        separatorBefore: sepGap,
        separatorWidth: sepWidth,
        separatorAfter: sepGap,
        rangeStart: candidate.rangeStart,
        rangeEnd: candidate.rangeEnd,
      });
    } else {
      const floatingPlacement = clampedLanePillPlacement(
        path,
        state.width,
        state.height,
        candidate.startBp,
        candidate.endExclusiveBp,
        candidate.requestedWidthPx,
        offset,
        genomeLength,
        candidate.startBp
      );
      if (floatingPlacement.widthPx <= 0) continue;
      floating.push({
        label: candidate.label,
        widthPx: floatingPlacement.widthPx,
        startBp: floatingPlacement.startBp,
        rangeStart: candidate.rangeStart,
        rangeEnd: candidate.rangeEnd,
      });
    }
  }

  return { appended, floating };
}

export function drawTranscriptIntronChevrons(
  g: Graphics,
  feature: Feature,
  path: PathMapper,
  state: RenderState,
  alpha: number,
  featureOffset: number,
  clipRange?: { lo: number; hi: number }
): void {
  const exons = feature.exons ?? [];
  const dir = feature.direction;
  const drawArrow = dir === 'forward' || dir === 'reverse';
  if (exons.length <= 1 || !drawArrow || path.isArcMode) return;

  const intronChevronColor =
    state.sequencePresentation?.annotationColors?.get(feature.id) ??
    transcriptColorForMode('intronChevron', state.themeMode);
  const ppb = path.pixelsPerBp;
  const chevY = path.featureLabelPosAt(feature.start, featureOffset).y;
  const visStart = path.viewStartBp;
  const visEnd = path.viewEndBp;
  const visMargin = Math.max(1, visEnd - visStart);
  const visLo = clipRange ? clipRange.lo : visStart - visMargin;
  const visHi = clipRange ? clipRange.hi : visEnd + visMargin;

  const CHEV_PX = TRANSCRIPT_INTRON_STYLE.tickHalfWidth;
  const chevHalf = TRANSCRIPT_INTRON_STYLE.tickHalfHeight;
  const forward = dir === 'forward';

  const pitchBp = intronTickPitch(ppb);
  if (!Number.isFinite(pitchBp) || pitchBp <= 0) return;
  for (let i = 0; i < exons.length - 1; i++) {
    const intronS = exons[i].end;
    const intronE = exons[i + 1].start - 1;
    if (intronE < visLo || intronS > visHi) continue;
    const widthPx = (intronE - intronS) * ppb;
    const chevronAlpha = alpha * intronTickAlpha(widthPx);
    if (chevronAlpha <= 0) continue;
    g.setStrokeStyle({ width: 1, color: intronChevronColor, alpha: chevronAlpha });

    const drawLo = Math.max(intronS + 1, visLo);
    const drawHi = Math.min(intronE - 1, visHi);
    if (drawHi <= drawLo) continue;

    const firstK = Math.ceil(drawLo / pitchBp);
    const lastK = Math.floor(drawHi / pitchBp);
    let drewChevron = false;
    for (let k = firstK; k <= lastK; k++) {
      const centerBp = k * pitchBp;
      if (centerBp <= intronS || centerBp >= intronE) continue;
      const cx = path.bpCenterX(centerBp);
      const tipDx = forward ? CHEV_PX : -CHEV_PX;
      g.moveTo(cx - tipDx, chevY - chevHalf);
      g.lineTo(cx + tipDx, chevY);
      g.lineTo(cx - tipDx, chevY + chevHalf);
      drewChevron = true;
    }
    if (drewChevron) g.stroke();
  }
}

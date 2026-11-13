import type { SequenceDrawingContext } from './rendering/drawing-context';
import { GOLDEN_GATE_JUNCTION_VISUAL } from '@waypoint/sequence-utils';

export interface OverhangDrawingContext {
  ctx: SequenceDrawingContext;
  barX: number;
  boxY: number;
  trackHeight: number;
  charWidth: number;
  pbsColor: string;
  overhangColor: string;
  isForward: boolean;
}

export interface GoldenGateOverhangParams {
  cleavedVisStart: number;
  cleavedVisEnd: number;
  retainedVisStart: number;
  retainedVisEnd: number;
  scar4bpIdxStart: number;
  cognate4bpLength: number;
  synthetic4bpSpacerLength?: number;
  spacerLength?: number;
}

export interface GibsonOverhangParams {
  ohVisibleStart: number;
  ohVisibleEnd: number;
  spacerLength?: number;
  ohOffsetWithinTotal?: number;
  totalOverhangLen?: number;
}

function drawHorizontalBorderedRect(
  ctx: SequenceDrawingContext,
  x: number,
  y: number,
  width: number,
  height: number,
  fillColor: string,
  fillOpacity: number,
  strokeColor: string,
  dashed: boolean = true
): void {
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.fillStyle = fillColor;
  ctx.globalAlpha = fillOpacity;
  ctx.fill();
  ctx.globalAlpha = 1.0;

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.moveTo(x, y + height);
  ctx.lineTo(x + width, y + height);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = GOLDEN_GATE_JUNCTION_VISUAL.primer.segmentStrokeWidthPx;
  if (dashed) {
    ctx.setLineDash([...GOLDEN_GATE_JUNCTION_VISUAL.primer.segmentDashPx]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawThreeSidedRect(
  ctx: SequenceDrawingContext,
  x: number,
  y: number,
  width: number,
  height: number,
  fillColor: string,
  fillOpacity: number,
  strokeColor: string,
  openSide: 'left' | 'right',
  dashed: boolean = true
): void {
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.fillStyle = fillColor;
  ctx.globalAlpha = fillOpacity;
  ctx.fill();
  ctx.globalAlpha = 1.0;

  ctx.beginPath();
  if (openSide === 'right') {
    ctx.moveTo(x, y + height);
    ctx.lineTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.moveTo(x, y + height);
    ctx.lineTo(x + width, y + height);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.lineTo(x + width, y + height);
    ctx.lineTo(x, y + height);
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = GOLDEN_GATE_JUNCTION_VISUAL.primer.segmentStrokeWidthPx;
  if (dashed) {
    ctx.setLineDash([...GOLDEN_GATE_JUNCTION_VISUAL.primer.segmentDashPx]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawCleavedPortion(
  context: OverhangDrawingContext,
  cleavedVisStart: number,
  cleavedVisEnd: number
): void {
  if (cleavedVisEnd <= cleavedVisStart) return;

  const { ctx, barX, boxY, trackHeight, charWidth, isForward } = context;
  const cleavedX = barX + cleavedVisStart * charWidth;
  const cleavedWidth = (cleavedVisEnd - cleavedVisStart) * charWidth;
  const grayColor = GOLDEN_GATE_JUNCTION_VISUAL.primer.cleavedColorHex;

  const openSide = isForward ? 'right' : 'left';
  drawThreeSidedRect(
    ctx,
    cleavedX,
    boxY,
    cleavedWidth,
    trackHeight,
    grayColor,
    GOLDEN_GATE_JUNCTION_VISUAL.primer.cleavedFillAlpha,
    grayColor,
    openSide,
    true
  );
}

export function calculateRetainedPortions(
  retainedVisStart: number,
  retainedVisEnd: number,
  scar4bpIdxStart: number,
  cognate4bpLength: number,
  isForward: boolean
): {
  literalVisStart: number;
  literalVisEnd: number;
  syntheticDrawStart: number;
  syntheticDrawEnd: number;
  cognateDrawStart: number;
  cognateDrawEnd: number;
} {
  let scar4bpVisStart: number, scar4bpVisEnd: number;
  let literalVisStart: number, literalVisEnd: number;

  if (isForward) {
    scar4bpVisStart = retainedVisStart;
    scar4bpVisEnd = Math.min(
      retainedVisEnd,
      retainedVisStart + (GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - scar4bpIdxStart)
    );
    literalVisStart = scar4bpVisEnd;
    literalVisEnd = retainedVisEnd;
  } else {
    const scar4bpStartOffset = Math.max(
      0,
      scar4bpIdxStart - (GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - 1)
    );
    const scar4bpEndOffset = scar4bpIdxStart + 1;
    scar4bpVisStart = Math.max(retainedVisStart, retainedVisStart + scar4bpStartOffset);
    scar4bpVisEnd = Math.min(retainedVisEnd, retainedVisStart + scar4bpEndOffset);
    literalVisStart = retainedVisStart;
    literalVisEnd = scar4bpVisStart;
  }

  let syntheticDrawStart: number, syntheticDrawEnd: number;
  let cognateDrawStart: number, cognateDrawEnd: number;

  if (isForward) {
    const cognateStartsAt4bpIdx = GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - cognate4bpLength;
    const cognateStartVisPos =
      scar4bpVisStart + Math.max(0, cognateStartsAt4bpIdx - scar4bpIdxStart);
    syntheticDrawStart = scar4bpVisStart;
    syntheticDrawEnd = Math.min(cognateStartVisPos, scar4bpVisEnd);
    cognateDrawStart = Math.max(cognateStartVisPos, scar4bpVisStart);
    cognateDrawEnd = scar4bpVisEnd;
  } else {
    const scar4bpIdxAtScarVisStart = Math.min(
      GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - 1,
      scar4bpIdxStart
    );
    const syntheticStartVisPos =
      scar4bpVisStart +
      Math.max(
        0,
        scar4bpIdxAtScarVisStart - (GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - cognate4bpLength) + 1
      );
    cognateDrawStart = scar4bpVisStart;
    cognateDrawEnd = Math.min(syntheticStartVisPos, scar4bpVisEnd);
    syntheticDrawStart = Math.max(syntheticStartVisPos, scar4bpVisStart);
    syntheticDrawEnd = scar4bpVisEnd;
  }

  return {
    literalVisStart,
    literalVisEnd,
    syntheticDrawStart,
    syntheticDrawEnd,
    cognateDrawStart,
    cognateDrawEnd,
  };
}

export function drawRetainedPortion(
  context: OverhangDrawingContext,
  params: GoldenGateOverhangParams
): void {
  const {
    retainedVisStart,
    retainedVisEnd,
    scar4bpIdxStart,
    cognate4bpLength,
    spacerLength = 0,
  } = params;

  if (retainedVisEnd <= retainedVisStart) return;

  const { ctx, barX, boxY, trackHeight, charWidth, pbsColor, overhangColor, isForward } = context;
  const grayColor = GOLDEN_GATE_JUNCTION_VISUAL.primer.cleavedColorHex;

  const portions = calculateRetainedPortions(
    retainedVisStart,
    retainedVisEnd,
    scar4bpIdxStart,
    cognate4bpLength,
    isForward
  );

  if (portions.literalVisEnd > portions.literalVisStart) {
    const literalLen = portions.literalVisEnd - portions.literalVisStart;
    const actualSpacerLen = Math.min(spacerLength, literalLen);
    const nonSpacerLen = literalLen - actualSpacerLen;

    if (isForward) {
      if (nonSpacerLen > 0) {
        const nonSpacerX = barX + portions.literalVisStart * charWidth;
        const nonSpacerWidth = nonSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          nonSpacerX,
          boxY,
          nonSpacerWidth,
          trackHeight,
          overhangColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          overhangColor,
          true
        );
      }
      if (actualSpacerLen > 0) {
        const spacerX = barX + (portions.literalVisStart + nonSpacerLen) * charWidth;
        const spacerWidth = actualSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerWidth,
          trackHeight,
          grayColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          grayColor,
          true
        );
      }
    } else {
      if (actualSpacerLen > 0) {
        const spacerX = barX + portions.literalVisStart * charWidth;
        const spacerWidth = actualSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerWidth,
          trackHeight,
          grayColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          grayColor,
          true
        );
      }
      if (nonSpacerLen > 0) {
        const nonSpacerX = barX + (portions.literalVisStart + actualSpacerLen) * charWidth;
        const nonSpacerWidth = nonSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          nonSpacerX,
          boxY,
          nonSpacerWidth,
          trackHeight,
          overhangColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          overhangColor,
          true
        );
      }
    }
  }

  if (portions.syntheticDrawEnd > portions.syntheticDrawStart) {
    const syntheticLen = portions.syntheticDrawEnd - portions.syntheticDrawStart;
    const synthetic4bpSpacerLen = params.synthetic4bpSpacerLength ?? 0;
    const actualSpacerLen = Math.min(synthetic4bpSpacerLen, syntheticLen);
    const nonSpacerLen = syntheticLen - actualSpacerLen;

    if (isForward) {
      if (nonSpacerLen > 0) {
        const nonSpacerX = barX + portions.syntheticDrawStart * charWidth;
        const nonSpacerWidth = nonSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          nonSpacerX,
          boxY,
          nonSpacerWidth,
          trackHeight,
          overhangColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          overhangColor,
          true
        );
      }
      if (actualSpacerLen > 0) {
        const spacerX = barX + (portions.syntheticDrawStart + nonSpacerLen) * charWidth;
        const spacerWidth = actualSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerWidth,
          trackHeight,
          grayColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          grayColor,
          true
        );
      }
    } else {
      if (actualSpacerLen > 0) {
        const spacerX = barX + portions.syntheticDrawStart * charWidth;
        const spacerWidth = actualSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerWidth,
          trackHeight,
          grayColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          grayColor,
          true
        );
      }
      if (nonSpacerLen > 0) {
        const nonSpacerX = barX + (portions.syntheticDrawStart + actualSpacerLen) * charWidth;
        const nonSpacerWidth = nonSpacerLen * charWidth;
        drawHorizontalBorderedRect(
          ctx,
          nonSpacerX,
          boxY,
          nonSpacerWidth,
          trackHeight,
          overhangColor,
          GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
          overhangColor,
          true
        );
      }
    }
  }

  if (portions.cognateDrawEnd > portions.cognateDrawStart) {
    const cognateX = barX + portions.cognateDrawStart * charWidth;
    const cognateWidth = (portions.cognateDrawEnd - portions.cognateDrawStart) * charWidth;
    drawHorizontalBorderedRect(
      ctx,
      cognateX,
      boxY,
      cognateWidth,
      trackHeight,
      pbsColor,
      GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha,
      pbsColor,
      false
    );
  }
}

export function drawGoldenGateOverhang(
  context: OverhangDrawingContext,
  params: GoldenGateOverhangParams
): void {
  drawCleavedPortion(context, params.cleavedVisStart, params.cleavedVisEnd);

  drawRetainedPortion(context, params);
}

export function drawGibsonOverhang(
  context: OverhangDrawingContext,
  params: GibsonOverhangParams
): void {
  const {
    ohVisibleStart,
    ohVisibleEnd,
    spacerLength = 0,
    ohOffsetWithinTotal = 0,
    totalOverhangLen,
  } = params;

  if (ohVisibleEnd <= ohVisibleStart) return;

  const { ctx, barX, boxY, trackHeight, charWidth, overhangColor, isForward } = context;
  const grayColor = '#6B7280';
  const visibleLength = ohVisibleEnd - ohVisibleStart;

  const effectiveTotalLen = totalOverhangLen ?? visibleLength;

  if (spacerLength <= 0) {
    const ohX = barX + ohVisibleStart * charWidth;
    const ohWidth = visibleLength * charWidth;
    const openSide = isForward ? 'right' : 'left';
    drawThreeSidedRect(
      ctx,
      ohX,
      boxY,
      ohWidth,
      trackHeight,
      overhangColor,
      0.25,
      overhangColor,
      openSide,
      true
    );
    return;
  }

  let spacerStartInOh: number, spacerEndInOh: number;
  if (isForward) {
    spacerStartInOh = effectiveTotalLen - spacerLength;
    spacerEndInOh = effectiveTotalLen;
  } else {
    spacerStartInOh = 0;
    spacerEndInOh = spacerLength;
  }

  const visStartInOh = ohOffsetWithinTotal;
  const visEndInOh = ohOffsetWithinTotal + visibleLength;

  const spacerVisStart = Math.max(spacerStartInOh, visStartInOh);
  const spacerVisEnd = Math.min(spacerEndInOh, visEndInOh);
  const spacerVisLen = Math.max(0, spacerVisEnd - spacerVisStart);

  let homologyStartInOh: number, homologyEndInOh: number;
  if (isForward) {
    homologyStartInOh = 0;
    homologyEndInOh = spacerStartInOh;
  } else {
    homologyStartInOh = spacerEndInOh;
    homologyEndInOh = effectiveTotalLen;
  }
  const homologyVisStart = Math.max(homologyStartInOh, visStartInOh);
  const homologyVisEnd = Math.min(homologyEndInOh, visEndInOh);
  const homologyVisLen = Math.max(0, homologyVisEnd - homologyVisStart);

  const homologyDrawStart = homologyVisLen > 0 ? homologyVisStart - visStartInOh : 0;
  const spacerDrawStart = spacerVisLen > 0 ? spacerVisStart - visStartInOh : 0;

  if (isForward) {
    if (homologyVisLen > 0 && spacerVisLen > 0) {
      const homologyX = barX + (ohVisibleStart + homologyDrawStart) * charWidth;
      drawThreeSidedRect(
        ctx,
        homologyX,
        boxY,
        homologyVisLen * charWidth,
        trackHeight,
        overhangColor,
        0.25,
        overhangColor,
        'right',
        true
      );
      const spacerX = barX + (ohVisibleStart + spacerDrawStart) * charWidth;
      drawHorizontalBorderedRect(
        ctx,
        spacerX,
        boxY,
        spacerVisLen * charWidth,
        trackHeight,
        grayColor,
        0.15,
        grayColor,
        true
      );
    } else if (homologyVisLen > 0) {
      const homologyX = barX + (ohVisibleStart + homologyDrawStart) * charWidth;
      const is5PrimeEnd = visStartInOh === 0;
      const spacerFollows = visEndInOh < effectiveTotalLen && spacerStartInOh < effectiveTotalLen;
      const openSide = spacerFollows ? 'right' : is5PrimeEnd ? 'right' : 'both';
      if (openSide === 'both') {
        drawHorizontalBorderedRect(
          ctx,
          homologyX,
          boxY,
          homologyVisLen * charWidth,
          trackHeight,
          overhangColor,
          0.25,
          overhangColor,
          true
        );
      } else {
        drawThreeSidedRect(
          ctx,
          homologyX,
          boxY,
          homologyVisLen * charWidth,
          trackHeight,
          overhangColor,
          0.25,
          overhangColor,
          openSide,
          true
        );
      }
    } else if (spacerVisLen > 0) {
      const spacerX = barX + (ohVisibleStart + spacerDrawStart) * charWidth;
      const homologyPrecedes = visStartInOh > 0 && homologyEndInOh > 0;
      const atPbsEnd = visEndInOh >= effectiveTotalLen;
      if (homologyPrecedes && atPbsEnd) {
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerVisLen * charWidth,
          trackHeight,
          grayColor,
          0.15,
          grayColor,
          true
        );
      } else if (homologyPrecedes) {
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerVisLen * charWidth,
          trackHeight,
          grayColor,
          0.15,
          grayColor,
          true
        );
      } else {
        drawThreeSidedRect(
          ctx,
          spacerX,
          boxY,
          spacerVisLen * charWidth,
          trackHeight,
          grayColor,
          0.15,
          grayColor,
          'right',
          true
        );
      }
    }
  } else {
    if (spacerVisLen > 0 && homologyVisLen > 0) {
      const spacerX = barX + (ohVisibleStart + spacerDrawStart) * charWidth;
      drawHorizontalBorderedRect(
        ctx,
        spacerX,
        boxY,
        spacerVisLen * charWidth,
        trackHeight,
        grayColor,
        0.15,
        grayColor,
        true
      );
      const homologyX = barX + (ohVisibleStart + homologyDrawStart) * charWidth;
      drawThreeSidedRect(
        ctx,
        homologyX,
        boxY,
        homologyVisLen * charWidth,
        trackHeight,
        overhangColor,
        0.25,
        overhangColor,
        'left',
        true
      );
    } else if (spacerVisLen > 0) {
      const spacerX = barX + (ohVisibleStart + spacerDrawStart) * charWidth;
      const homologyFollows =
        visEndInOh < effectiveTotalLen && homologyStartInOh < effectiveTotalLen;
      if (homologyFollows) {
        drawHorizontalBorderedRect(
          ctx,
          spacerX,
          boxY,
          spacerVisLen * charWidth,
          trackHeight,
          grayColor,
          0.15,
          grayColor,
          true
        );
      } else {
        drawThreeSidedRect(
          ctx,
          spacerX,
          boxY,
          spacerVisLen * charWidth,
          trackHeight,
          grayColor,
          0.15,
          grayColor,
          'left',
          true
        );
      }
    } else if (homologyVisLen > 0) {
      const homologyX = barX + (ohVisibleStart + homologyDrawStart) * charWidth;
      const spacerPrecedes = visStartInOh > 0 && spacerEndInOh > 0;
      const is5PrimeEnd = visEndInOh >= effectiveTotalLen;
      if (spacerPrecedes && is5PrimeEnd) {
        drawThreeSidedRect(
          ctx,
          homologyX,
          boxY,
          homologyVisLen * charWidth,
          trackHeight,
          overhangColor,
          0.25,
          overhangColor,
          'left',
          true
        );
      } else if (spacerPrecedes) {
        drawHorizontalBorderedRect(
          ctx,
          homologyX,
          boxY,
          homologyVisLen * charWidth,
          trackHeight,
          overhangColor,
          0.25,
          overhangColor,
          true
        );
      } else {
        drawThreeSidedRect(
          ctx,
          homologyX,
          boxY,
          homologyVisLen * charWidth,
          trackHeight,
          overhangColor,
          0.25,
          overhangColor,
          'left',
          true
        );
      }
    }
  }
}

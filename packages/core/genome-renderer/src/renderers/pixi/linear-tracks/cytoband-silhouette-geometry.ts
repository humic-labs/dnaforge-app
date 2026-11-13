import type {
  CentromereTopologyV1,
  CytogeneticCentromereClassV1,
  CytogeneticShortArmSideV1,
  NormalizedCentromereInterval,
} from '@waypoint/genome-data';

const TELEOMERE_RADIUS_ARM_DIVISOR = 3;
const CENTROMERE_CURVE_REACH_PX = 10;
const TERMINAL_CAP_RADIUS_PX = 4;
const MAX_WAIST_INSET_PX = 2.25;
const WAIST_INSET_HEIGHT_RATIO = 0.24;
const CYTOGENETIC_CENTROMERE_RATIOS: Readonly<Record<CytogeneticCentromereClassV1, number>> = {
  metacentric: 0.5,
  submetacentric: 0.32,
  acrocentric: 0.1,
  telocentric: 0,
};

export interface ChromosomeSilhouetteGeometry {
  readonly topology: CentromereTopologyV1;
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
  readonly centerYPx: number;
  readonly centromereStartPx: number;
  readonly centromereEndPx: number;
  readonly centromereMidpointPx: number;
  readonly pArmWidthPx: number;
  readonly centromereWidthPx: number;
  readonly qArmWidthPx: number;
  readonly pTelomereRadiusPx: number;
  readonly qTelomereRadiusPx: number;
  readonly pCentromereCurveReachPx: number;
  readonly qCentromereCurveReachPx: number;
  readonly pTaperStartPx: number;
  readonly qTaperEndPx: number;
  readonly waistTopPx: number;
  readonly waistBottomPx: number;
  readonly terminalCap: TerminalCentromereCapGeometry | null;
}

export interface TerminalCentromereCapGeometry {
  readonly radiusPx: number;
  readonly centerXPx: number;
  readonly centerYPx: number;
  readonly tipXPx: number;
  readonly upperTangentXPx: number;
  readonly upperTangentYPx: number;
  readonly lowerTangentXPx: number;
  readonly lowerTangentYPx: number;
  readonly bodyAnchorXPx: number;
  readonly arcControlReachPx: number;
}

interface ChromosomeSilhouetteInput {
  readonly leftPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly chromosomeLengthBp: number;
  readonly centromere: NormalizedCentromereInterval;
  readonly topology?: CentromereTopologyV1;
}

export interface CapsuleSilhouetteGeometry {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly topPx: number;
  readonly bottomPx: number;
  readonly centerYPx: number;
  readonly radiusPx: number;
}

export function computeChromosomeSilhouetteGeometry(
  input: ChromosomeSilhouetteInput
): ChromosomeSilhouetteGeometry | null {
  const { leftPx, widthPx, heightPx, chromosomeLengthBp, centromere } = input;
  const topology = input.topology ?? 'internal';
  if (
    !Number.isFinite(leftPx) ||
    !Number.isFinite(widthPx) ||
    !Number.isFinite(heightPx) ||
    !Number.isFinite(chromosomeLengthBp) ||
    !Number.isFinite(centromere.startBp) ||
    !Number.isFinite(centromere.endBp) ||
    widthPx <= 0 ||
    heightPx <= 0 ||
    chromosomeLengthBp <= 0 ||
    centromere.startBp < 0 ||
    centromere.endBp <= centromere.startBp ||
    centromere.endBp > chromosomeLengthBp ||
    (topology === 'internal' &&
      (centromere.startBp === 0 || centromere.endBp === chromosomeLengthBp))
  ) {
    return null;
  }

  const scale = widthPx / chromosomeLengthBp;
  const rightPx = leftPx + widthPx;
  const centromereStartPx = leftPx + centromere.startBp * scale;
  const centromereEndPx = leftPx + centromere.endBp * scale;
  const pArmWidthPx = centromereStartPx - leftPx;
  const qArmWidthPx = rightPx - centromereEndPx;
  const centromereMidpointPx =
    topology === 'terminal-start'
      ? leftPx
      : topology === 'terminal-end'
        ? rightPx
        : (centromereStartPx + centromereEndPx) / 2;
  const pHalfWidthPx = centromereMidpointPx - leftPx;
  const qHalfWidthPx = rightPx - centromereMidpointPx;
  const targetTelomereRadiusPx = heightPx / 2;
  const pTelomereRadiusPx = Math.max(
    0,
    Math.min(targetTelomereRadiusPx, pHalfWidthPx / TELEOMERE_RADIUS_ARM_DIVISOR)
  );
  const qTelomereRadiusPx = Math.max(
    0,
    Math.min(targetTelomereRadiusPx, qHalfWidthPx / TELEOMERE_RADIUS_ARM_DIVISOR)
  );
  const targetCentromereCurveReachPx = CENTROMERE_CURVE_REACH_PX;
  const pCentromereCurveReachPx = Math.max(
    0,
    Math.min(targetCentromereCurveReachPx, pHalfWidthPx - pTelomereRadiusPx)
  );
  const qCentromereCurveReachPx = Math.max(
    0,
    Math.min(targetCentromereCurveReachPx, qHalfWidthPx - qTelomereRadiusPx)
  );
  const waistInsetPx = Math.min(MAX_WAIST_INSET_PX, heightPx * WAIST_INSET_HEIGHT_RATIO);
  const pTaperStartPx = centromereMidpointPx - pCentromereCurveReachPx;
  const qTaperEndPx = centromereMidpointPx + qCentromereCurveReachPx;
  const terminalCap = computeTerminalCentromereCapGeometry({
    topology,
    leftPx,
    rightPx,
    heightPx,
    pTaperStartPx,
    qTaperEndPx,
    pCentromereCurveReachPx,
    qCentromereCurveReachPx,
  });

  return {
    topology,
    leftPx,
    rightPx,
    topPx: 0,
    bottomPx: heightPx,
    centerYPx: heightPx / 2,
    centromereStartPx,
    centromereEndPx,
    centromereMidpointPx,
    pArmWidthPx,
    centromereWidthPx: centromereEndPx - centromereStartPx,
    qArmWidthPx,
    pTelomereRadiusPx,
    qTelomereRadiusPx,
    pCentromereCurveReachPx,
    qCentromereCurveReachPx,
    pTaperStartPx,
    qTaperEndPx,
    waistTopPx: waistInsetPx,
    waistBottomPx: heightPx - waistInsetPx,
    terminalCap,
  };
}

export function computeBetweenMemberSilhouetteGeometry(input: {
  readonly leftPx: number;
  readonly leftMemberWidthPx: number;
  readonly rightMemberWidthPx: number;
  readonly heightPx: number;
}): ChromosomeSilhouetteGeometry | null {
  const { leftPx, leftMemberWidthPx, rightMemberWidthPx, heightPx } = input;
  const widthPx = leftMemberWidthPx + rightMemberWidthPx;
  if (
    !Number.isFinite(leftPx) ||
    !Number.isFinite(leftMemberWidthPx) ||
    !Number.isFinite(rightMemberWidthPx) ||
    !Number.isFinite(heightPx) ||
    leftMemberWidthPx <= 0 ||
    rightMemberWidthPx <= 0 ||
    heightPx <= 0
  ) {
    return null;
  }
  const boundaryPx = leftPx + leftMemberWidthPx;
  return computeGeometry({
    leftPx,
    widthPx,
    heightPx,
    centromereStartPx: boundaryPx,
    centromereEndPx: boundaryPx,
    centromereMidpointPx: boundaryPx,
    pArmWidthPx: leftMemberWidthPx,
    qArmWidthPx: rightMemberWidthPx,
  });
}

export function computeCentromereBoundarySilhouetteGeometry(input: {
  readonly leftPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly chromosomeLengthBp: number;
  readonly positionBp: number;
  readonly topology: CentromereTopologyV1;
}): ChromosomeSilhouetteGeometry | null {
  const { leftPx, widthPx, heightPx, chromosomeLengthBp, positionBp, topology } = input;
  if (
    !Number.isFinite(leftPx) ||
    !Number.isFinite(widthPx) ||
    !Number.isFinite(heightPx) ||
    !Number.isSafeInteger(chromosomeLengthBp) ||
    !Number.isSafeInteger(positionBp) ||
    widthPx <= 0 ||
    heightPx <= 0 ||
    chromosomeLengthBp <= 0 ||
    positionBp < 0 ||
    positionBp > chromosomeLengthBp ||
    (topology === 'internal' && (positionBp === 0 || positionBp === chromosomeLengthBp)) ||
    (topology === 'terminal-start' && positionBp !== 0) ||
    (topology === 'terminal-end' && positionBp !== chromosomeLengthBp)
  ) {
    return null;
  }
  const boundaryPx = leftPx + (positionBp / chromosomeLengthBp) * widthPx;
  return computeGeometry({
    leftPx,
    widthPx,
    heightPx,
    centromereStartPx: boundaryPx,
    centromereEndPx: boundaryPx,
    centromereMidpointPx: boundaryPx,
    pArmWidthPx: boundaryPx - leftPx,
    qArmWidthPx: leftPx + widthPx - boundaryPx,
    topology,
  });
}

export function computeSchematicChromosomeSilhouetteGeometry(input: {
  readonly leftPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly centromereClass: CytogeneticCentromereClassV1;
  readonly shortArmAt: CytogeneticShortArmSideV1;
}): ChromosomeSilhouetteGeometry | null {
  const { leftPx, widthPx, heightPx, centromereClass, shortArmAt } = input;
  if (
    !Number.isFinite(leftPx) ||
    !Number.isFinite(widthPx) ||
    !Number.isFinite(heightPx) ||
    widthPx <= 0 ||
    heightPx <= 0
  ) {
    return null;
  }
  const startRatio = CYTOGENETIC_CENTROMERE_RATIOS[centromereClass];
  const ratio = shortArmAt === 'start' ? startRatio : 1 - startRatio;
  const centromereMidpointPx = leftPx + widthPx * ratio;
  const topology: CentromereTopologyV1 =
    centromereClass === 'telocentric'
      ? shortArmAt === 'start'
        ? 'terminal-start'
        : 'terminal-end'
      : 'internal';
  return computeGeometry({
    leftPx,
    widthPx,
    heightPx,
    centromereStartPx: centromereMidpointPx,
    centromereEndPx: centromereMidpointPx,
    centromereMidpointPx,
    pArmWidthPx: centromereMidpointPx - leftPx,
    qArmWidthPx: leftPx + widthPx - centromereMidpointPx,
    topology,
  });
}

export function computeCapsuleSilhouetteGeometry(input: {
  readonly leftPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}): CapsuleSilhouetteGeometry | null {
  const { leftPx, widthPx, heightPx } = input;
  if (
    !Number.isFinite(leftPx) ||
    !Number.isFinite(widthPx) ||
    !Number.isFinite(heightPx) ||
    widthPx <= 0 ||
    heightPx <= 0
  ) {
    return null;
  }
  return {
    leftPx,
    rightPx: leftPx + widthPx,
    topPx: 0,
    bottomPx: heightPx,
    centerYPx: heightPx / 2,
    radiusPx: Math.min(heightPx / 2, widthPx / 2),
  };
}

function computeGeometry(input: {
  readonly leftPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly centromereStartPx: number;
  readonly centromereEndPx: number;
  readonly centromereMidpointPx: number;
  readonly pArmWidthPx: number;
  readonly qArmWidthPx: number;
  readonly topology?: CentromereTopologyV1;
}): ChromosomeSilhouetteGeometry {
  const {
    leftPx,
    widthPx,
    heightPx,
    centromereStartPx,
    centromereEndPx,
    centromereMidpointPx,
    pArmWidthPx,
    qArmWidthPx,
  } = input;
  const topology = input.topology ?? 'internal';
  const rightPx = leftPx + widthPx;
  const pHalfWidthPx = centromereMidpointPx - leftPx;
  const qHalfWidthPx = rightPx - centromereMidpointPx;
  const targetTelomereRadiusPx = heightPx / 2;
  const pTelomereRadiusPx = Math.max(
    0,
    Math.min(targetTelomereRadiusPx, pHalfWidthPx / TELEOMERE_RADIUS_ARM_DIVISOR)
  );
  const qTelomereRadiusPx = Math.max(
    0,
    Math.min(targetTelomereRadiusPx, qHalfWidthPx / TELEOMERE_RADIUS_ARM_DIVISOR)
  );
  const targetCentromereCurveReachPx = CENTROMERE_CURVE_REACH_PX;
  const pCentromereCurveReachPx = Math.max(
    0,
    Math.min(targetCentromereCurveReachPx, pHalfWidthPx - pTelomereRadiusPx)
  );
  const qCentromereCurveReachPx = Math.max(
    0,
    Math.min(targetCentromereCurveReachPx, qHalfWidthPx - qTelomereRadiusPx)
  );
  const waistInsetPx = Math.min(MAX_WAIST_INSET_PX, heightPx * WAIST_INSET_HEIGHT_RATIO);
  const pTaperStartPx = centromereMidpointPx - pCentromereCurveReachPx;
  const qTaperEndPx = centromereMidpointPx + qCentromereCurveReachPx;
  const terminalCap = computeTerminalCentromereCapGeometry({
    topology,
    leftPx,
    rightPx,
    heightPx,
    pTaperStartPx,
    qTaperEndPx,
    pCentromereCurveReachPx,
    qCentromereCurveReachPx,
  });
  return {
    topology,
    leftPx,
    rightPx,
    topPx: 0,
    bottomPx: heightPx,
    centerYPx: heightPx / 2,
    centromereStartPx,
    centromereEndPx,
    centromereMidpointPx,
    pArmWidthPx,
    centromereWidthPx: centromereEndPx - centromereStartPx,
    qArmWidthPx,
    pTelomereRadiusPx,
    qTelomereRadiusPx,
    pCentromereCurveReachPx,
    qCentromereCurveReachPx,
    pTaperStartPx,
    qTaperEndPx,
    waistTopPx: waistInsetPx,
    waistBottomPx: heightPx - waistInsetPx,
    terminalCap,
  };
}

function computeTerminalCentromereCapGeometry(input: {
  readonly topology: CentromereTopologyV1;
  readonly leftPx: number;
  readonly rightPx: number;
  readonly heightPx: number;
  readonly pTaperStartPx: number;
  readonly qTaperEndPx: number;
  readonly pCentromereCurveReachPx: number;
  readonly qCentromereCurveReachPx: number;
}): TerminalCentromereCapGeometry | null {
  const {
    topology,
    leftPx,
    rightPx,
    heightPx,
    pTaperStartPx,
    qTaperEndPx,
    pCentromereCurveReachPx,
    qCentromereCurveReachPx,
  } = input;
  if (topology === 'internal') return null;

  const curveReachPx =
    topology === 'terminal-start' ? qCentromereCurveReachPx : pCentromereCurveReachPx;
  const memberWidthPx = rightPx - leftPx;
  const radiusPx = Math.min(TERMINAL_CAP_RADIUS_PX, heightPx / 2, curveReachPx, memberWidthPx / 2);
  if (radiusPx <= 0) return null;

  const centerYPx = heightPx / 2;
  const centerXPx = topology === 'terminal-start' ? leftPx + radiusPx : rightPx - radiusPx;
  const tipXPx = topology === 'terminal-start' ? leftPx : rightPx;
  const bodyAnchorXPx = topology === 'terminal-start' ? qTaperEndPx : pTaperStartPx;
  const bodyVectorX = bodyAnchorXPx - centerXPx;
  const bodyVectorY = -centerYPx;
  const bodyDistanceSquared = bodyVectorX ** 2 + bodyVectorY ** 2;
  if (bodyDistanceSquared <= radiusPx ** 2) return null;

  const baseScale = radiusPx ** 2 / bodyDistanceSquared;
  const tangentScale =
    (radiusPx * Math.sqrt(bodyDistanceSquared - radiusPx ** 2)) / bodyDistanceSquared;
  const baseX = centerXPx + baseScale * bodyVectorX;
  const baseY = centerYPx + baseScale * bodyVectorY;
  const perpendicularX = -bodyVectorY;
  const perpendicularY = bodyVectorX;
  const firstCandidate = {
    x: baseX + tangentScale * perpendicularX,
    y: baseY + tangentScale * perpendicularY,
  };
  const secondCandidate = {
    x: baseX - tangentScale * perpendicularX,
    y: baseY - tangentScale * perpendicularY,
  };
  const upperTangent = firstCandidate.y < secondCandidate.y ? firstCandidate : secondCandidate;
  const lowerTangentYPx = centerYPx * 2 - upperTangent.y;
  const tipRadialX = tipXPx - centerXPx;
  const upperRadialX = upperTangent.x - centerXPx;
  const normalizedDot = Math.max(-1, Math.min(1, (tipRadialX * upperRadialX) / radiusPx ** 2));
  const arcAngle = Math.acos(normalizedDot);

  return {
    radiusPx,
    centerXPx,
    centerYPx,
    tipXPx,
    upperTangentXPx: upperTangent.x,
    upperTangentYPx: upperTangent.y,
    lowerTangentXPx: upperTangent.x,
    lowerTangentYPx,
    bodyAnchorXPx,
    arcControlReachPx: (4 / 3) * Math.tan(arcAngle / 4) * radiusPx,
  };
}

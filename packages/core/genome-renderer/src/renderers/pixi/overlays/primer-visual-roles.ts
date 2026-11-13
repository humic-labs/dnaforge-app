import type { Primer } from '../../../types';
import { GOLDEN_GATE_JUNCTION_VISUAL } from '@waypoint/sequence-utils';

export type PrimerVisualRoleKind =
  | 'pbs'
  | 'tail'
  | 'spacer'
  | 'enzyme-site'
  | 'cleaved'
  | 'scar-cognate'
  | 'scar-synthetic'
  | 'scar-synthetic-spacer'
  | 'scar-marker';

export type PrimerVisualStrokeStyle = 'solid' | 'dotted' | 'none';
export type PrimerVisualBorderMode =
  | 'outline'
  | 'horizontal'
  | 'open-left'
  | 'open-right'
  | 'primer-forward'
  | 'primer-reverse'
  | 'none';

export interface PrimerVisualFillSegment {
  role: PrimerVisualRoleKind;
  startBase: number;
  endBase: number;
  fillColor: number;
  strokeColor: number;
  strokeStyle: PrimerVisualStrokeStyle;
  alpha: number;
  borderMode: PrimerVisualBorderMode;
}

export interface PrimerVisualTextSegment {
  role: PrimerVisualRoleKind;
  startBase: number;
  endBase: number;
  textColor: number;
  boldText: boolean;
}

export interface PrimerVisualPlan {
  fillSegments: PrimerVisualFillSegment[];
  textSegments: PrimerVisualTextSegment[];
}

type PrimerVisualSpec = {
  fillColor: number;
  strokeColor: number;
  strokeStyle: PrimerVisualStrokeStyle;
  textColor: number;
  alpha: number;
};

export type PrimerVisualRoleCounts = Partial<Record<PrimerVisualRoleKind, number>>;

export const DEFAULT_PBS_COLOR = GOLDEN_GATE_JUNCTION_VISUAL.primer.defaultPbsColorPixi;
export const DEFAULT_OVERHANG_COLOR = GOLDEN_GATE_JUNCTION_VISUAL.primer.defaultOverhangColorPixi;
export const CLEAVED_COLOR = GOLDEN_GATE_JUNCTION_VISUAL.primer.cleavedColorPixi;
export const SYNTHETIC_SCAR_COLOR = GOLDEN_GATE_JUNCTION_VISUAL.primer.scarBaseColorPixi;
export const MISMATCH_COLOR = 0xdc2626;
export const PBS_FILL_ALPHA = GOLDEN_GATE_JUNCTION_VISUAL.primer.pbsFillAlpha;
export const OVERHANG_FILL_ALPHA = GOLDEN_GATE_JUNCTION_VISUAL.primer.retainedFillAlpha;
export const SPACER_FILL_ALPHA = GOLDEN_GATE_JUNCTION_VISUAL.primer.spacerFillAlpha;

const SCAR_LENGTH_BP = GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp;

function primerOverhangLength(primer: Primer, length: number): number {
  return Math.max(0, Math.min(primer.overhangLength ?? 0, length));
}

function oligoIndexForVisualBase(primer: Primer, baseIndex: number, length: number): number {
  return primer.direction === 'forward' ? baseIndex : length - 1 - baseIndex;
}

function roleSpec(role: PrimerVisualRoleKind, primer: Primer): PrimerVisualSpec {
  const pbsColor = primer.pbsColor ?? DEFAULT_PBS_COLOR;
  const overhangColor = primer.overhangColor ?? DEFAULT_OVERHANG_COLOR;
  switch (role) {
    case 'pbs':
    case 'scar-cognate':
      return {
        fillColor: pbsColor,
        strokeColor: pbsColor,
        strokeStyle: 'solid',
        textColor: pbsColor,
        alpha: role === 'pbs' ? PBS_FILL_ALPHA : OVERHANG_FILL_ALPHA,
      };
    case 'spacer':
    case 'scar-synthetic-spacer':
    case 'cleaved':
      return {
        fillColor: CLEAVED_COLOR,
        strokeColor: CLEAVED_COLOR,
        strokeStyle: 'dotted',
        textColor: CLEAVED_COLOR,
        alpha: role === 'scar-synthetic-spacer' ? OVERHANG_FILL_ALPHA : SPACER_FILL_ALPHA,
      };
    case 'scar-synthetic':
      return {
        fillColor: overhangColor,
        strokeColor: overhangColor,
        strokeStyle: 'dotted',
        textColor: SYNTHETIC_SCAR_COLOR,
        alpha: OVERHANG_FILL_ALPHA,
      };
    case 'enzyme-site':
      return {
        fillColor: CLEAVED_COLOR,
        strokeColor: CLEAVED_COLOR,
        strokeStyle: 'dotted',
        textColor: CLEAVED_COLOR,
        alpha: OVERHANG_FILL_ALPHA,
      };
    case 'scar-marker':
      return {
        fillColor: SYNTHETIC_SCAR_COLOR,
        strokeColor: SYNTHETIC_SCAR_COLOR,
        strokeStyle: 'none',
        textColor: SYNTHETIC_SCAR_COLOR,
        alpha: 0,
      };
    case 'tail':
    default:
      return {
        fillColor: overhangColor,
        strokeColor: overhangColor,
        strokeStyle: 'dotted',
        textColor: overhangColor,
        alpha: OVERHANG_FILL_ALPHA,
      };
  }
}

function sameFillSegment(
  a: PrimerVisualFillSegment,
  b: Omit<PrimerVisualFillSegment, 'startBase' | 'endBase'>
) {
  return (
    a.role === b.role &&
    a.fillColor === b.fillColor &&
    a.strokeColor === b.strokeColor &&
    a.strokeStyle === b.strokeStyle &&
    a.alpha === b.alpha &&
    a.borderMode === b.borderMode
  );
}

function sameTextSegment(
  a: PrimerVisualTextSegment,
  b: Omit<PrimerVisualTextSegment, 'startBase' | 'endBase'>
) {
  return a.role === b.role && a.textColor === b.textColor && a.boldText === b.boldText;
}

function pushFillSegment(
  segments: PrimerVisualFillSegment[],
  primer: Primer,
  role: PrimerVisualRoleKind,
  startBase: number,
  endBase: number,
  borderMode: PrimerVisualBorderMode,
  alpha?: number
): void {
  if (endBase <= startBase) return;
  const { fillColor, strokeColor, strokeStyle, alpha: defaultAlpha } = roleSpec(role, primer);
  const spec = {
    role,
    fillColor,
    strokeColor,
    strokeStyle,
    alpha: alpha ?? defaultAlpha,
    borderMode,
  };
  const previous = segments[segments.length - 1];
  if (previous && previous.endBase === startBase && sameFillSegment(previous, spec)) {
    previous.endBase = endBase;
    return;
  }
  segments.push({ ...spec, startBase, endBase });
}

function pushTextSegment(
  segments: PrimerVisualTextSegment[],
  primer: Primer,
  role: PrimerVisualRoleKind,
  startBase: number,
  endBase: number,
  boldText = false
): void {
  if (endBase <= startBase) return;
  const { textColor } = roleSpec(role, primer);
  const spec = { role, textColor, boldText };
  const previous = segments[segments.length - 1];
  if (previous && previous.endBase === startBase && sameTextSegment(previous, spec)) {
    previous.endBase = endBase;
    return;
  }
  segments.push({ ...spec, startBase, endBase });
}

function clampedPrimerCut(primer: Primer, overhangLength: number): number | null {
  const cut = primer.cutPositionInOverhang;
  if (cut === undefined || cut <= 0) return null;
  return Math.max(0, Math.min(cut, overhangLength));
}

function textRoleForBase(
  primer: Primer,
  baseIndex: number,
  length: number,
  overhangLength: number
): { role: PrimerVisualRoleKind; boldText: boolean } {
  if (primer.isScarMarkerOnly) return { role: 'scar-marker', boldText: true };

  const oligoIndex = oligoIndexForVisualBase(primer, baseIndex, length);
  const isOverhang = overhangLength > 0 && oligoIndex >= 0 && oligoIndex < overhangLength;
  if (!isOverhang) return { role: 'pbs', boldText: false };

  const spacerLength = Math.max(0, Math.min(primer.spacerLength ?? 0, overhangLength));
  const isSpacer = oligoIndex >= overhangLength - spacerLength;
  const cut = clampedPrimerCut(primer, overhangLength);
  const isRecognition =
    primer.recognitionStart !== undefined &&
    primer.recognitionEnd !== undefined &&
    oligoIndex >= primer.recognitionStart &&
    oligoIndex < primer.recognitionEnd;

  if (cut !== null) {
    if (oligoIndex < cut) {
      return { role: 'cleaved', boldText: isRecognition };
    }

    const scar4bpIndex = oligoIndex - cut;
    if (scar4bpIndex >= 0 && scar4bpIndex < SCAR_LENGTH_BP) {
      return { role: 'scar-marker', boldText: true };
    }
  }

  return { role: isSpacer ? 'spacer' : 'tail', boldText: false };
}

function retainedPortions(
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
  let scar4bpVisStart: number;
  let scar4bpVisEnd: number;
  let literalVisStart: number;
  let literalVisEnd: number;

  if (isForward) {
    scar4bpVisStart = retainedVisStart;
    scar4bpVisEnd = Math.min(retainedVisEnd, retainedVisStart + (SCAR_LENGTH_BP - scar4bpIdxStart));
    literalVisStart = scar4bpVisEnd;
    literalVisEnd = retainedVisEnd;
  } else {
    const scar4bpStartOffset = Math.max(0, scar4bpIdxStart - (SCAR_LENGTH_BP - 1));
    const scar4bpEndOffset = scar4bpIdxStart + 1;
    scar4bpVisStart = Math.max(retainedVisStart, retainedVisStart + scar4bpStartOffset);
    scar4bpVisEnd = Math.min(retainedVisEnd, retainedVisStart + scar4bpEndOffset);
    literalVisStart = retainedVisStart;
    literalVisEnd = scar4bpVisStart;
  }

  let syntheticDrawStart: number;
  let syntheticDrawEnd: number;
  let cognateDrawStart: number;
  let cognateDrawEnd: number;

  if (isForward) {
    const cognateStartsAt4bpIdx = SCAR_LENGTH_BP - cognate4bpLength;
    const cognateStartVisPos =
      scar4bpVisStart + Math.max(0, cognateStartsAt4bpIdx - scar4bpIdxStart);
    syntheticDrawStart = scar4bpVisStart;
    syntheticDrawEnd = Math.min(cognateStartVisPos, scar4bpVisEnd);
    cognateDrawStart = Math.max(cognateStartVisPos, scar4bpVisStart);
    cognateDrawEnd = scar4bpVisEnd;
  } else {
    const scar4bpIdxAtScarVisStart = Math.min(SCAR_LENGTH_BP - 1, scar4bpIdxStart);
    const syntheticStartVisPos =
      scar4bpVisStart +
      Math.max(0, scar4bpIdxAtScarVisStart - (SCAR_LENGTH_BP - cognate4bpLength) + 1);
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

function pushRetainedGoldenGateFillSegments(
  fillSegments: PrimerVisualFillSegment[],
  primer: Primer,
  retainedVisStart: number,
  retainedVisEnd: number,
  scar4bpIdxStart: number
): void {
  if (retainedVisEnd <= retainedVisStart) return;
  const isForward = primer.direction === 'forward';
  const portions = retainedPortions(
    retainedVisStart,
    retainedVisEnd,
    scar4bpIdxStart,
    Math.max(0, Math.min(primer.cognate4bpLength ?? 0, SCAR_LENGTH_BP)),
    isForward
  );

  if (portions.literalVisEnd > portions.literalVisStart) {
    const literalLen = portions.literalVisEnd - portions.literalVisStart;
    const actualSpacerLen = Math.min(primer.spacerLength ?? 0, literalLen);
    const nonSpacerLen = literalLen - actualSpacerLen;

    if (isForward) {
      pushFillSegment(
        fillSegments,
        primer,
        'tail',
        portions.literalVisStart,
        portions.literalVisStart + nonSpacerLen,
        'horizontal'
      );
      pushFillSegment(
        fillSegments,
        primer,
        'spacer',
        portions.literalVisStart + nonSpacerLen,
        portions.literalVisEnd,
        'horizontal',
        OVERHANG_FILL_ALPHA
      );
    } else {
      pushFillSegment(
        fillSegments,
        primer,
        'spacer',
        portions.literalVisStart,
        portions.literalVisStart + actualSpacerLen,
        'horizontal',
        OVERHANG_FILL_ALPHA
      );
      pushFillSegment(
        fillSegments,
        primer,
        'tail',
        portions.literalVisStart + actualSpacerLen,
        portions.literalVisEnd,
        'horizontal'
      );
    }
  }

  if (portions.syntheticDrawEnd > portions.syntheticDrawStart) {
    const syntheticLen = portions.syntheticDrawEnd - portions.syntheticDrawStart;
    const actualSpacerLen = Math.min(primer.synthetic4bpSpacerLength ?? 0, syntheticLen);
    const nonSpacerLen = syntheticLen - actualSpacerLen;

    if (isForward) {
      pushFillSegment(
        fillSegments,
        primer,
        'scar-synthetic',
        portions.syntheticDrawStart,
        portions.syntheticDrawStart + nonSpacerLen,
        'horizontal'
      );
      pushFillSegment(
        fillSegments,
        primer,
        'scar-synthetic-spacer',
        portions.syntheticDrawStart + nonSpacerLen,
        portions.syntheticDrawEnd,
        'horizontal'
      );
    } else {
      pushFillSegment(
        fillSegments,
        primer,
        'scar-synthetic-spacer',
        portions.syntheticDrawStart,
        portions.syntheticDrawStart + actualSpacerLen,
        'horizontal'
      );
      pushFillSegment(
        fillSegments,
        primer,
        'scar-synthetic',
        portions.syntheticDrawStart + actualSpacerLen,
        portions.syntheticDrawEnd,
        'horizontal'
      );
    }
  }

  pushFillSegment(
    fillSegments,
    primer,
    'scar-cognate',
    portions.cognateDrawStart,
    portions.cognateDrawEnd,
    'horizontal'
  );
}

function addGibsonFillSegments(
  fillSegments: PrimerVisualFillSegment[],
  primer: Primer,
  clampedLength: number,
  overhangLength: number
): void {
  const pbsLength = clampedLength - overhangLength;
  const spacerLength = Math.max(0, Math.min(primer.spacerLength ?? 0, overhangLength));
  const homologyLength = overhangLength - spacerLength;

  if (primer.direction === 'forward') {
    pushFillSegment(fillSegments, primer, 'tail', 0, homologyLength, 'open-right');
    pushFillSegment(
      fillSegments,
      primer,
      'spacer',
      homologyLength,
      overhangLength,
      homologyLength > 0 ? 'horizontal' : 'open-right'
    );
    pushFillSegment(fillSegments, primer, 'pbs', overhangLength, clampedLength, 'primer-forward');
    return;
  }

  const spacerStart = pbsLength;
  const homologyStart = spacerStart + spacerLength;
  pushFillSegment(fillSegments, primer, 'pbs', 0, pbsLength, 'primer-reverse');
  pushFillSegment(
    fillSegments,
    primer,
    'spacer',
    spacerStart,
    homologyStart,
    homologyLength > 0 ? 'horizontal' : 'open-left'
  );
  pushFillSegment(fillSegments, primer, 'tail', homologyStart, clampedLength, 'open-left');
}

function addGoldenGateFillSegments(
  fillSegments: PrimerVisualFillSegment[],
  primer: Primer,
  clampedLength: number,
  overhangLength: number,
  cut: number
): void {
  const pbsLength = clampedLength - overhangLength;
  if (primer.direction === 'forward') {
    pushFillSegment(fillSegments, primer, 'cleaved', 0, cut, 'open-right');
    pushRetainedGoldenGateFillSegments(fillSegments, primer, cut, overhangLength, 0);
    pushFillSegment(fillSegments, primer, 'pbs', overhangLength, clampedLength, 'primer-forward');
    return;
  }

  const retainedStart = pbsLength;
  const retainedEnd = clampedLength - cut;
  pushFillSegment(fillSegments, primer, 'pbs', 0, pbsLength, 'primer-reverse');
  pushRetainedGoldenGateFillSegments(
    fillSegments,
    primer,
    retainedStart,
    retainedEnd,
    overhangLength - cut - 1
  );
  pushFillSegment(fillSegments, primer, 'cleaved', retainedEnd, clampedLength, 'open-left');
}

export function computePrimerVisualPlan(primer: Primer, length: number): PrimerVisualPlan {
  const clampedLength = Math.max(0, Math.floor(length));
  if (clampedLength <= 0) return { fillSegments: [], textSegments: [] };

  if (primer.isScarMarkerOnly) {
    const plan: PrimerVisualPlan = { fillSegments: [], textSegments: [] };
    pushFillSegment(plan.fillSegments, primer, 'scar-marker', 0, clampedLength, 'none');
    pushTextSegment(plan.textSegments, primer, 'scar-marker', 0, clampedLength, true);
    return plan;
  }

  const overhangLength = primerOverhangLength(primer, clampedLength);
  if (overhangLength <= 0) {
    const plan: PrimerVisualPlan = { fillSegments: [], textSegments: [] };
    pushFillSegment(plan.fillSegments, primer, 'pbs', 0, clampedLength, 'outline');
    pushTextSegment(plan.textSegments, primer, 'pbs', 0, clampedLength);
    return plan;
  }

  const plan: PrimerVisualPlan = { fillSegments: [], textSegments: [] };
  const cut = clampedPrimerCut(primer, overhangLength);
  if (cut !== null) {
    addGoldenGateFillSegments(plan.fillSegments, primer, clampedLength, overhangLength, cut);
  } else {
    addGibsonFillSegments(plan.fillSegments, primer, clampedLength, overhangLength);
  }

  for (let baseIndex = 0; baseIndex < clampedLength; baseIndex++) {
    const { role, boldText } = textRoleForBase(primer, baseIndex, clampedLength, overhangLength);
    pushTextSegment(plan.textSegments, primer, role, baseIndex, baseIndex + 1, boldText);
  }
  plan.fillSegments.sort(
    (a, b) => a.startBase - b.startBase || a.endBase - b.endBase || a.role.localeCompare(b.role)
  );
  return plan;
}

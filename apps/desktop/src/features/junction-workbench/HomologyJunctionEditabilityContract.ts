import type { HomologyEncoding, SequenceDesign } from '../design/public/types';
import { isRestrictionDigestRegion } from '../design/public/restriction-digest';

export type HomologyArmSide = 'left' | 'right';

export interface HomologyArmEditability {
  side: HomologyArmSide;
  editable: boolean;
  lockedValue?: number;
  minValue?: number;
  constraintCode?: string;
  message?: string;
}

export interface HomologyJunctionEditability {
  junctionIndex: number;
  leftSource: 'pcr' | 'restriction-digest';
  rightSource: 'pcr' | 'restriction-digest';
  leftArm: HomologyArmEditability;
  rightArm: HomologyArmEditability;
}

export function homologyJunctionEditability(
  design: SequenceDesign,
  junctionIndex: number,
  currentEncoding?: HomologyEncoding | null
): HomologyJunctionEditability {
  const leftRegion = design.regions[junctionIndex];
  const rightRegion = design.regions[(junctionIndex + 1) % design.regions.length];
  const leftIsRd = isRestrictionDigestRegion(leftRegion);
  const rightIsRd = isRestrictionDigestRegion(rightRegion);

  if (leftIsRd && !rightIsRd) {
    return {
      junctionIndex,
      leftSource: 'restriction-digest',
      rightSource: 'pcr',
      leftArm: editableArm('left', 0),
      rightArm: lockedArm(
        'right',
        0,
        'restriction-digest-one-sided-homology',
        'Restriction-digest/PCR homology is encoded from the physical left digest end; the right PCR-side arm is fixed at 0 bp.'
      ),
    };
  }

  if (!leftIsRd && rightIsRd) {
    return {
      junctionIndex,
      leftSource: 'pcr',
      rightSource: 'restriction-digest',
      leftArm: lockedArm(
        'left',
        0,
        'restriction-digest-one-sided-homology',
        'PCR/restriction-digest homology is encoded from the physical right digest end; the left PCR-side arm is fixed at 0 bp.'
      ),
      rightArm: editableArm('right', 0),
    };
  }

  if (leftIsRd && rightIsRd) {
    return {
      junctionIndex,
      leftSource: 'restriction-digest',
      rightSource: 'restriction-digest',
      leftArm: lockedArm(
        'left',
        currentEncoding?.onLeft ?? 0,
        'restriction-digest-physical-homology',
        'Restriction-digest/restriction-digest homology is owned by physical digest ends, not PCR primer design.'
      ),
      rightArm: lockedArm(
        'right',
        currentEncoding?.onRight ?? 0,
        'restriction-digest-physical-homology',
        'Restriction-digest/restriction-digest homology is owned by physical digest ends, not PCR primer design.'
      ),
    };
  }

  return {
    junctionIndex,
    leftSource: 'pcr',
    rightSource: 'pcr',
    leftArm: editableArm('left'),
    rightArm: editableArm('right'),
  };
}

export function validateHomologyEncodingForJunction(input: {
  design: SequenceDesign;
  junctionIndex: number;
  encoding: HomologyEncoding;
  currentEncoding?: HomologyEncoding | null;
}): string | null {
  const contract = homologyJunctionEditability(
    input.design,
    input.junctionIndex,
    input.currentEncoding
  );
  for (const arm of [contract.leftArm, contract.rightArm]) {
    const value = arm.side === 'left' ? input.encoding.onLeft : input.encoding.onRight;
    if (arm.lockedValue !== undefined && value !== arm.lockedValue) {
      return `${arm.message ?? 'Homology arm is locked'} Junction ${input.junctionIndex + 1} requested ${arm.side}=${value} bp.`;
    }
    if (arm.minValue !== undefined && value < arm.minValue) {
      return `${arm.message ?? 'Homology arm has a lower bound'} Junction ${input.junctionIndex + 1} requested ${arm.side}=${value} bp; minimum is ${arm.minValue} bp.`;
    }
  }
  return null;
}

export function recommendedHomologyEncodingForJunction(
  design: SequenceDesign,
  junctionIndex: number,
  totalLength: number,
  currentEncoding?: HomologyEncoding | null
): HomologyEncoding {
  const length = Math.max(0, Math.round(totalLength));
  const contract = homologyJunctionEditability(design, junctionIndex, currentEncoding);
  if (contract.leftArm.editable && contract.rightArm.lockedValue !== undefined) {
    return { onLeft: length, onRight: contract.rightArm.lockedValue };
  }
  if (contract.rightArm.editable && contract.leftArm.lockedValue !== undefined) {
    return { onLeft: contract.leftArm.lockedValue, onRight: length };
  }
  if (!contract.leftArm.editable && !contract.rightArm.editable && currentEncoding) {
    return currentEncoding;
  }
  const onLeft = Math.floor(length / 2);
  return { onLeft, onRight: length - onLeft };
}

function editableArm(side: HomologyArmSide, minValue?: number): HomologyArmEditability {
  return { side, editable: true, minValue };
}

function lockedArm(
  side: HomologyArmSide,
  lockedValue: number,
  constraintCode: string,
  message: string
): HomologyArmEditability {
  return { side, editable: false, lockedValue, constraintCode, message };
}

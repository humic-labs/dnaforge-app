import { complement } from '@waypoint/sequence-utils';
import type { PrimerDirection } from './types';

export interface BindingPositions {
  start: number;
  end: number;
}

interface GeometryParams {
  direction: PrimerDirection;
  length: number;
  threePrimeExt: number;
  bindingOffset?: number;
  initialBindingStart: number;
  initialBindingEnd: number;
  circular?: boolean;
  sequenceLength?: number;
}

export function computeBindingPositions(params: GeometryParams): BindingPositions {
  const {
    direction,
    length,
    threePrimeExt,
    bindingOffset = 0,
    initialBindingStart,
    initialBindingEnd,
    circular,
    sequenceLength,
  } = params;
  const canWrap = !!circular && !!sequenceLength;
  const mod = (n: number) =>
    canWrap ? ((n % sequenceLength!) + sequenceLength!) % sequenceLength! : n;

  if (direction === 'reverse') {
    const start = mod(initialBindingStart - threePrimeExt + bindingOffset);
    const rawEnd = start + length;
    const end = canWrap ? rawEnd % sequenceLength! : rawEnd;
    return { start, end };
  }
  const end = mod(initialBindingEnd + threePrimeExt + bindingOffset);
  const rawStart = end - length;
  const start = canWrap && rawStart < 0 ? (rawStart + sequenceLength!) % sequenceLength! : rawStart;
  return { start, end };
}

export function templateExtensionBase(params: {
  direction: PrimerDirection;
  threePrimeExt: number;
  bindingOffset?: number;
  initialBindingStart: number;
  initialBindingEnd: number;
  reference: string;
  circular?: boolean;
  sequenceLength?: number;
}): string | null {
  const {
    direction,
    threePrimeExt,
    bindingOffset = 0,
    initialBindingStart,
    initialBindingEnd,
    reference,
    circular,
    sequenceLength,
  } = params;
  const L = sequenceLength ?? reference.length;
  let idx =
    direction === 'reverse'
      ? initialBindingStart - threePrimeExt + bindingOffset - 1
      : initialBindingEnd + threePrimeExt + bindingOffset;

  if (circular && sequenceLength) {
    idx = ((idx % L) + L) % L;
  } else if (idx < 0 || idx >= reference.length) {
    return null;
  }
  const base = reference[idx];
  if (!base) return null;
  return direction === 'reverse' ? complement(base) : base;
}

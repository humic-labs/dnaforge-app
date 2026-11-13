import type { DesignRegion } from '../design/public/types';

export interface RegisteredSourceAxis {
  sourcePositionAtBioColZero: number;
  sourceLength: number;
  sourceCircular: boolean;
  includedRange: { start: number; end: number };
}

interface SourceContext {
  sequence: string;
  sourceLength?: number;
  start: number;
  end: number;
  circular: boolean;
}

export function registeredSourceAxis(
  side: 'left' | 'right',
  context: SourceContext,
  spacerLength: number
): RegisteredSourceAxis {
  const shift = Math.max(0, spacerLength);
  return {
    sourcePositionAtBioColZero: side === 'left' ? context.end : context.start - shift,
    sourceLength: context.sourceLength ?? context.sequence.length,
    sourceCircular: context.circular,
    includedRange: { start: context.start, end: context.end },
  };
}

export function sourceContextForRegion(region: DesignRegion): SourceContext & {
  hasFullSource: boolean;
} {
  const sequence = region.sourceSequence ?? region.sequence;
  const hasFullSource = Boolean(region.sourceSequence);
  return {
    sequence,
    start: hasFullSource ? region.sourceStart : 0,
    end: hasFullSource ? region.sourceEnd : region.sequence.length,
    circular: Boolean(hasFullSource && region.sourceIsCircular),
    hasFullSource,
  };
}

export function sourcePositionForBioCol(axis: RegisteredSourceAxis, bioCol: number): number {
  return axis.sourcePositionAtBioColZero + bioCol;
}

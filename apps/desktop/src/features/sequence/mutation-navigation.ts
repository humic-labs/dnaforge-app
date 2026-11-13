import type { VariantSummary } from './variant-client';

interface MutationAssembly {
  readonly chromosomes: ReadonlyArray<{
    readonly chrom: string;
    readonly length: number;
  }>;
}

interface GlobalRange {
  readonly start: number;
  readonly end: number;
}

export const MUTATION_DETAIL_VIEWPORT_BP = 120;

export function mutationGlobalRange(input: {
  readonly assembly?: MutationAssembly;
  readonly activeChrom: string;
  readonly singleChromLength?: number;
  readonly variant: Pick<VariantSummary, 'chrom' | 'start' | 'end'>;
}): GlobalRange {
  const placement = mutationChromosomeGlobalRange(input);
  const { start, end } = input.variant;
  const chromosomeLength = placement.end - placement.start;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > chromosomeLength
  ) {
    throw new Error(
      `${input.variant.chrom}:${start + 1} is outside the open reference chromosome.`
    );
  }
  return {
    start: placement.start + start,
    end: placement.start + end,
  };
}

export function mutationChromosomeGlobalRange(input: {
  readonly assembly?: MutationAssembly;
  readonly activeChrom: string;
  readonly singleChromLength?: number;
  readonly variant: Pick<VariantSummary, 'chrom'>;
}): GlobalRange {
  if (!input.assembly) {
    if (input.variant.chrom !== input.activeChrom) {
      throw new Error(`Chromosome "${input.variant.chrom}" is not present in the open reference.`);
    }
    if (!Number.isSafeInteger(input.singleChromLength) || (input.singleChromLength ?? 0) <= 0) {
      throw new Error('The open reference chromosome length is unavailable.');
    }
    return { start: 0, end: input.singleChromLength as number };
  }

  let globalStart = 0;
  for (const chromosome of input.assembly.chromosomes) {
    if (chromosome.chrom === input.variant.chrom) {
      return { start: globalStart, end: globalStart + chromosome.length };
    }
    globalStart += chromosome.length;
  }
  throw new Error(`Chromosome "${input.variant.chrom}" is not present in the open reference.`);
}

export function mutationViewport(input: {
  readonly globalRange: GlobalRange;
  readonly chromosomeGlobalRange: GlobalRange;
  readonly targetSpanBp?: number;
}): GlobalRange {
  const chromosomeSpan = input.chromosomeGlobalRange.end - input.chromosomeGlobalRange.start;
  const variantSpan = input.globalRange.end - input.globalRange.start;
  const requestedSpan = Math.max(
    variantSpan,
    Math.trunc(input.targetSpanBp ?? MUTATION_DETAIL_VIEWPORT_BP)
  );
  const span = Math.min(chromosomeSpan, requestedSpan);
  const center = (input.globalRange.start + input.globalRange.end) / 2;
  const unclampedStart = Math.floor(center - span / 2);
  const maxStart = input.chromosomeGlobalRange.end - span;
  const start = Math.max(input.chromosomeGlobalRange.start, Math.min(maxStart, unclampedStart));
  return { start, end: start + span };
}

import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import type { IndexedChromosomeSpan } from './indexed-cut-site-window';
import { formatIndexedScanWindow } from './indexed-cut-site-window';

export const INDEXED_PRIMER_FIND_MAX_BP = 20_000;

export interface IndexedPrimerFindWindow {
  readonly chrom: string;
  readonly start0: number;
  readonly end0: number;
}

export type IndexedPrimerFindScopeMode = 'visible' | 'selection' | 'interval';

export type IndexedPrimerFindWindowResolution =
  | Readonly<{ window: IndexedPrimerFindWindow; disabledReason: null }>
  | Readonly<{ window: null; disabledReason: UserMessage }>;

const TOO_WIDE = userMessage('primer.scopeTooWide');

export function parseIndexedInterval(
  text: string,
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>
): IndexedPrimerFindWindowResolution {
  const match = /^\s*([^:\s]+)\s*:\s*([\d,\s]+)\s*[-–—]\s*([\d,\s]+)\s*$/u.exec(text);
  if (!match) {
    return { window: null, disabledReason: userMessage('primer.scopeIntervalRequired') };
  }
  const chromosome = chromosomes.find((candidate) => candidate.chrom === match[1]);
  if (!chromosome) {
    return {
      window: null,
      disabledReason: userMessageWithValues('primer.scopeChromosomeUnknown', {
        chromosome: userMessageValue(match[1]),
      }),
    };
  }
  const start = Number(match[2].replace(/[,\s]/gu, ''));
  const end = Number(match[3].replace(/[,\s]/gu, ''));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    return {
      window: null,
      disabledReason: userMessage('primer.scopeOrderInvalid'),
    };
  }
  if (end > chromosome.length) {
    return {
      window: null,
      disabledReason: userMessageWithValues('primer.scopeChromosomeLength', {
        chromosome: userMessageValue(chromosome.chrom),
        length: userMessageValue(chromosome.length.toLocaleString()),
      }),
    };
  }
  return {
    window: { chrom: chromosome.chrom, start0: start - 1, end0: end },
    disabledReason: null,
  };
}

export function indexedGlobalRangeToChromosome(
  range: Readonly<{ start: number; end: number }>,
  chromosomes: ReadonlyArray<IndexedChromosomeSpan>
): IndexedPrimerFindWindow | null {
  let offset = 0;
  for (const chromosome of chromosomes) {
    const chromEnd = offset + chromosome.length;
    if (range.start >= offset && range.start < chromEnd) {
      if (range.end > chromEnd) return null;
      return {
        chrom: chromosome.chrom,
        start0: Math.max(0, Math.floor(range.start - offset)),
        end0: Math.min(chromosome.length, Math.ceil(range.end - offset)),
      };
    }
    offset = chromEnd;
  }
  return null;
}

export function resolveIndexedPrimerFindWindow(input: {
  readonly mode: IndexedPrimerFindScopeMode;
  readonly viewport: Readonly<{ start: number; end: number }> | null;
  readonly selection: IndexedPrimerFindWindow | null;
  readonly intervalText: string;
  readonly chromosomes: ReadonlyArray<IndexedChromosomeSpan>;
  readonly maxBp?: number;
}): IndexedPrimerFindWindowResolution {
  const maxBp = input.maxBp ?? INDEXED_PRIMER_FIND_MAX_BP;
  let resolved: IndexedPrimerFindWindowResolution;
  if (input.mode === 'interval') {
    resolved = parseIndexedInterval(input.intervalText, input.chromosomes);
  } else if (input.mode === 'selection') {
    resolved = input.selection
      ? { window: input.selection, disabledReason: null }
      : { window: null, disabledReason: userMessage('primer.scopeSelectionRequired') };
  } else {
    const window = input.viewport
      ? indexedGlobalRangeToChromosome(input.viewport, input.chromosomes)
      : null;
    resolved = window
      ? { window, disabledReason: null }
      : { window: null, disabledReason: TOO_WIDE };
  }
  if (!resolved.window) return resolved;
  const length = resolved.window.end0 - resolved.window.start0;
  if (length <= 0) return { window: null, disabledReason: TOO_WIDE };
  if (length > maxBp) {
    return {
      window: null,
      disabledReason: userMessageWithValues('primer.scopeLength', {
        interval: userMessageValue(formatIndexedScanWindow(resolved.window)),
        length: userMessageValue(length.toLocaleString()),
        maximum: userMessageValue(maxBp.toLocaleString()),
      }),
    };
  }
  return resolved;
}

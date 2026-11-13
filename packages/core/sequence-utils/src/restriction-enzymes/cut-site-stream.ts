import { isPalindrome, recognitionToRegex, reverseComplement } from './cut-site-calculator';
import type { ThinCutSiteHit } from './cut-site-worker-protocol';
import type { RestrictionEnzyme } from './types';

const DEFAULT_BATCH_SIZE = 1000;

export interface ScanCallbacks {
  onProgress: (
    enzymeName: string,
    hits: ThinCutSiteHit[],
    enzymeIndex: number,
    totalEnzymes: number
  ) => void;
  onEnzymeDone?: (enzymeName: string, enzymeIndex: number, totalEnzymes: number) => void;
  yieldToEventLoop: () => Promise<void>;
  isCancelled: () => boolean;
}

export interface ScanOptions {
  maxHitsPerEnzyme?: number;
  batchSize?: number;
  circular?: boolean;
}

async function scanOneStrand(
  sequence: string,
  regex: RegExp,
  enzyme: RestrictionEnzyme,
  strand: 'forward' | 'reverse',
  recLen: number,
  cutTop: number,
  cutBottom: number,
  hits: ThinCutSiteHit[],
  enzymeIndex: number,
  totalEnzymes: number,
  callbacks: ScanCallbacks,
  options: ScanOptions,
  sequenceLength: number,
  wrap: boolean
): Promise<boolean> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxHits = options.maxHitsPerEnzyme;
  let sinceLastYield = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(sequence)) !== null) {
    const rawStart = match.index;
    const rawEnd = rawStart + recLen;
    const norm = (value: number): number =>
      wrap ? ((value % sequenceLength) + sequenceLength) % sequenceLength : value;
    const recognitionStart = norm(rawStart);
    const recognitionEnd = norm(rawEnd);

    let cutPositionTopUnwrapped: number;
    let cutPositionBottomUnwrapped: number;
    if (strand === 'forward') {
      cutPositionTopUnwrapped = rawStart + cutTop;
      cutPositionBottomUnwrapped = rawStart + cutBottom;
    } else {
      cutPositionTopUnwrapped = rawEnd - cutBottom;
      cutPositionBottomUnwrapped = rawEnd - cutTop;
    }
    const cutPositionTop = norm(cutPositionTopUnwrapped);
    const cutPositionBottom = norm(cutPositionBottomUnwrapped);

    hits.push({
      enzymeName: enzyme.name,
      cutPositionTop,
      cutPositionBottom,
      ...(wrap ? { cutPositionTopUnwrapped, cutPositionBottomUnwrapped } : {}),
      recognitionStart,
      recognitionEnd,
      strand,
    });

    if (match[0].length === 0) {
      regex.lastIndex++;
    }

    sinceLastYield++;
    if (maxHits !== undefined && hits.length >= maxHits) break;

    if (sinceLastYield >= batchSize) {
      callbacks.onProgress(enzyme.name, hits.slice(), enzymeIndex, totalEnzymes);
      await callbacks.yieldToEventLoop();
      if (callbacks.isCancelled()) return false;
      sinceLastYield = 0;
    }
  }
  return true;
}

export async function scanEnzymeStreaming(
  sequence: string,
  enzyme: RestrictionEnzyme,
  enzymeIndex: number,
  totalEnzymes: number,
  callbacks: ScanCallbacks,
  options: ScanOptions = {}
): Promise<ThinCutSiteHit[]> {
  if (
    enzyme.cut_position_top === null ||
    enzyme.cut_position_bottom === null ||
    !enzyme.recognition_sequence
  ) {
    return [];
  }

  const recSeq = enzyme.recognition_sequence;
  const recLen = enzyme.recognition_sequence_length;
  const cutTop = enzyme.cut_position_top;
  const cutBottom = enzyme.cut_position_bottom;
  const hits: ThinCutSiteHit[] = [];
  const sequenceLength = sequence.length;
  const wrap = options.circular === true && sequenceLength >= recLen;
  const scanned = wrap ? sequence + sequence.slice(0, recLen - 1) : sequence;

  const fwdContinued = await scanOneStrand(
    scanned,
    recognitionToRegex(recSeq),
    enzyme,
    'forward',
    recLen,
    cutTop,
    cutBottom,
    hits,
    enzymeIndex,
    totalEnzymes,
    callbacks,
    options,
    sequenceLength,
    wrap
  );
  if (!fwdContinued) return hits;
  if (options.maxHitsPerEnzyme !== undefined && hits.length >= options.maxHitsPerEnzyme) {
    callbacks.onProgress(enzyme.name, hits.slice(), enzymeIndex, totalEnzymes);
    callbacks.onEnzymeDone?.(enzyme.name, enzymeIndex, totalEnzymes);
    return hits;
  }

  if (!isPalindrome(recSeq)) {
    const rcSeq = reverseComplement(recSeq);
    await scanOneStrand(
      scanned,
      recognitionToRegex(rcSeq),
      enzyme,
      'reverse',
      recLen,
      cutTop,
      cutBottom,
      hits,
      enzymeIndex,
      totalEnzymes,
      callbacks,
      options,
      sequenceLength,
      wrap
    );
  }

  if (!callbacks.isCancelled()) {
    callbacks.onProgress(enzyme.name, hits.slice(), enzymeIndex, totalEnzymes);
    callbacks.onEnzymeDone?.(enzyme.name, enzymeIndex, totalEnzymes);
  }
  return hits;
}

export async function scanAllStreaming(
  sequence: string,
  enzymes: RestrictionEnzyme[],
  callbacks: ScanCallbacks,
  options: ScanOptions = {}
): Promise<void> {
  const order = enzymes
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) => (b.e.recognition_sequence_length ?? 0) - (a.e.recognition_sequence_length ?? 0)
    );

  for (let k = 0; k < order.length; k++) {
    if (callbacks.isCancelled()) return;
    const { e, i } = order[k];
    await scanEnzymeStreaming(sequence, e, i, enzymes.length, callbacks, options);
    await callbacks.yieldToEventLoop();
  }
}

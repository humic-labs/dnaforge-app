import { isStopCodon } from './translation';
import { isStartCodonForGeneticCode } from './start-codons';
import { reverseComplement } from './iupac';

export type CdsExtensionDirection = 'five-prime' | 'three-prime';

export interface CdsExtensionInput {
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
  codonStart?: 1 | 2 | 3;
  geneticCode?: number;
}

export interface CdsExtension {
  start: number;
  end: number;
  direction: CdsExtensionDirection;
  openEnded: boolean;
  addedBases: number;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function codonStartOffset(codonStart: 1 | 2 | 3 | undefined): 0 | 1 | 2 {
  return codonStart === 2 ? 1 : codonStart === 3 ? 2 : 0;
}

function codonAt(
  sequence: string,
  position: number,
  strand: 'forward' | 'reverse',
  circular: boolean
): string | null {
  const length = sequence.length;
  const lowest = strand === 'forward' ? position : position - 2;
  let codon = '';
  for (let i = 0; i < 3; i++) {
    const raw = lowest + i;
    const index = circular ? positiveModulo(raw, length) : raw;
    if (index < 0 || index >= length) return null;
    codon += sequence[index];
  }
  codon = codon.toUpperCase();
  return strand === 'forward' ? codon : reverseComplement(codon).toUpperCase();
}

function cdsBaseCount(cds: CdsExtensionInput, sequenceLength: number, circular: boolean): number {
  if (cds.end >= cds.start) return cds.end - cds.start + 1;
  if (!circular || sequenceLength === 0) return 0;
  return sequenceLength - cds.start + cds.end + 1;
}

function codonsAvailableBeyond(
  cds: CdsExtensionInput,
  sequenceLength: number,
  circular: boolean
): number {
  if (!circular) return Math.floor(sequenceLength / 3) + 1;
  const room = sequenceLength - cdsBaseCount(cds, sequenceLength, circular);
  return Math.max(0, Math.floor(room / 3));
}

function unwrappedSpan(
  cds: CdsExtensionInput,
  sequenceLength: number,
  circular: boolean
): { low: number; high: number; baseCount: number } {
  const baseCount = cdsBaseCount(cds, sequenceLength, circular);
  return { low: cds.start, high: cds.start + baseCount - 1, baseCount };
}

function readingStart(cds: CdsExtensionInput, sequenceLength: number, circular: boolean): number {
  const { low, high } = unwrappedSpan(cds, sequenceLength, circular);
  return cds.strand === 'forward' ? low : high;
}

function readingEnd(cds: CdsExtensionInput, sequenceLength: number, circular: boolean): number {
  const { low, high } = unwrappedSpan(cds, sequenceLength, circular);
  return cds.strand === 'forward' ? high : low;
}

export function cdsEndsInStopCodon(
  cds: CdsExtensionInput,
  sequence: string,
  options: { circular?: boolean } = {}
): boolean {
  const circular = options.circular ?? false;
  if (cdsBaseCount(cds, sequence.length, circular) < 3) return false;
  const step = cds.strand === 'forward' ? 1 : -1;
  const frameAnchor =
    readingStart(cds, sequence.length, circular) + step * codonStartOffset(cds.codonStart);
  const last = readingEnd(cds, sequence.length, circular);
  const span = step === 1 ? last - frameAnchor : frameAnchor - last;
  if (span < 2) return false;
  if ((span + 1) % 3 !== 0) return false;
  const finalCodonStart = frameAnchor + step * (span - 2);
  const codon = codonAt(sequence, finalCodonStart, cds.strand, circular);
  return codon !== null && isStopCodon(codon);
}

export function cdsStartsOnStartCodon(
  cds: CdsExtensionInput,
  sequence: string,
  options: { circular?: boolean } = {}
): boolean {
  const circular = options.circular ?? false;
  if (cdsBaseCount(cds, sequence.length, circular) < 3) return false;
  const step = cds.strand === 'forward' ? 1 : -1;
  const frameAnchor =
    readingStart(cds, sequence.length, circular) + step * codonStartOffset(cds.codonStart);
  const codon = codonAt(sequence, frameAnchor, cds.strand, circular);
  return codon !== null && isStartCodonForGeneticCode(codon, cds.geneticCode);
}

export function extendCdsThreePrime(
  cds: CdsExtensionInput,
  sequence: string,
  options: { circular?: boolean } = {}
): CdsExtension | null {
  const circular = options.circular ?? false;
  const length = sequence.length;
  if (length === 0) return null;

  if (cdsBaseCount(cds, length, circular) < 1) return null;
  const step = cds.strand === 'forward' ? 1 : -1;
  const frameAnchor = readingStart(cds, length, circular) + step * codonStartOffset(cds.codonStart);
  const last = readingEnd(cds, length, circular);

  const spanToLast = step === 1 ? last - frameAnchor : frameAnchor - last;
  const wholeCodons = Math.floor((spanToLast + 1) / 3);
  let cursor = frameAnchor + step * wholeCodons * 3;

  const extensionStart = cursor;
  const addedTo = (readingPosition: number) =>
    step === 1 ? readingPosition - last : last - readingPosition;
  const maxCodons = codonsAvailableBeyond(cds, length, circular);

  for (let i = 0; i < maxCodons; i++) {
    const codon = codonAt(sequence, cursor, cds.strand, circular);
    if (codon === null) {
      const stopShort = cursor - step;
      if (
        (step === 1 && stopShort < extensionStart) ||
        (step === -1 && stopShort > extensionStart)
      ) {
        return null;
      }
      return orient(extensionStart, stopShort, 'three-prime', true, cds.strand, addedTo(stopShort));
    }
    if (isStopCodon(codon)) {
      return orient(
        extensionStart,
        cursor + step * 2,
        'three-prime',
        false,
        cds.strand,
        addedTo(cursor + step * 2)
      );
    }
    cursor += step * 3;
  }
  return orient(
    extensionStart,
    cursor - step,
    'three-prime',
    true,
    cds.strand,
    addedTo(cursor - step)
  );
}

export function extendCdsFivePrime(
  cds: CdsExtensionInput,
  sequence: string,
  options: { circular?: boolean } = {}
): CdsExtension | null {
  const circular = options.circular ?? false;
  const length = sequence.length;
  if (length === 0) return null;

  if (cdsBaseCount(cds, length, circular) < 1) return null;
  const step = cds.strand === 'forward' ? 1 : -1;
  const frameAnchor = readingStart(cds, length, circular) + step * codonStartOffset(cds.codonStart);

  let cursor = frameAnchor - step * 3;
  const extensionEnd = frameAnchor - step;
  const first = readingStart(cds, length, circular);
  const addedTo = (readingPosition: number) =>
    step === 1 ? first - readingPosition : readingPosition - first;
  const maxCodons = codonsAvailableBeyond(cds, length, circular);

  for (let i = 0; i < maxCodons; i++) {
    const codon = codonAt(sequence, cursor, cds.strand, circular);
    if (codon === null) {
      const stopShort = cursor + step * 3;
      if ((step === 1 && stopShort > extensionEnd) || (step === -1 && stopShort < extensionEnd)) {
        return null;
      }
      return orient(stopShort, extensionEnd, 'five-prime', true, cds.strand, addedTo(stopShort));
    }
    if (isStartCodonForGeneticCode(codon, cds.geneticCode)) {
      return orient(cursor, extensionEnd, 'five-prime', false, cds.strand, addedTo(cursor));
    }
    if (isStopCodon(codon)) {
      const afterStop = cursor + step * 3;
      if ((step === 1 && afterStop > extensionEnd) || (step === -1 && afterStop < extensionEnd)) {
        return null;
      }
      return orient(afterStop, extensionEnd, 'five-prime', true, cds.strand, addedTo(afterStop));
    }
    cursor -= step * 3;
  }
  return orient(
    cursor + step * 3,
    extensionEnd,
    'five-prime',
    true,
    cds.strand,
    addedTo(cursor + step * 3)
  );
}

function orient(
  a: number,
  b: number,
  direction: CdsExtensionDirection,
  openEnded: boolean,
  strand: 'forward' | 'reverse',
  addedBases: number
): CdsExtension {
  void strand;
  return {
    start: Math.min(a, b),
    end: Math.max(a, b),
    direction,
    openEnded,
    addedBases: Math.max(0, addedBases),
  };
}

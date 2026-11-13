import {
  complementBase,
  resolveGeneticCode,
  STANDARD_GENETIC_CODE,
  STANDARD_GENETIC_CODE_ID,
  toNucleicAcid,
  type ORF,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';

const STANDARD_STOP_CODONS: ReadonlySet<string> = STANDARD_GENETIC_CODE.stopCodons;
const YIELD_EVERY_CODONS = 100_000;

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function reverseComplementCodon(seq: string, rcIndex: number): string {
  const n = seq.length;
  return (
    complementBase(seq[n - 1 - rcIndex]) +
    complementBase(seq[n - 2 - rcIndex]) +
    complementBase(seq[n - 3 - rcIndex])
  );
}

async function maybeYield(codonsSinceYield: number, isActive: () => boolean): Promise<boolean> {
  if (codonsSinceYield < YIELD_EVERY_CODONS) return true;
  if (!isActive()) return false;
  await yieldToMainThread();
  return isActive();
}

async function scanForwardFrame(
  seq: string,
  frameOffset: number,
  frameLabel: number,
  minLength: number,
  out: ORF[],
  isActive: () => boolean,
  stopCodons: ReadonlySet<string> = STANDARD_STOP_CODONS
): Promise<boolean> {
  const startPositions: number[] = [];
  let codonsSinceYield = 0;

  for (let i = frameOffset; i + 2 < seq.length; i += 3) {
    const codon = seq.substring(i, i + 3);
    if (codon === 'ATG') {
      startPositions.push(i);
    }

    if (stopCodons.has(codon) && startPositions.length > 0) {
      const start = startPositions[0];
      const end = i + 2;
      const length = end - start + 1;
      if (length >= minLength) out.push({ start, end, frame: frameLabel, strand: '+', length });
      startPositions.length = 0;
    }

    codonsSinceYield += 1;
    if (codonsSinceYield >= YIELD_EVERY_CODONS) {
      codonsSinceYield = 0;
      if (!(await maybeYield(YIELD_EVERY_CODONS, isActive))) return false;
    }
  }

  return isActive();
}

async function scanReverseFrame(
  seq: string,
  frameOffset: number,
  frameLabel: number,
  minLength: number,
  out: ORF[],
  isActive: () => boolean,
  stopCodons: ReadonlySet<string> = STANDARD_STOP_CODONS
): Promise<boolean> {
  const startPositions: number[] = [];
  let codonsSinceYield = 0;
  const n = seq.length;

  for (let rcIndex = frameOffset; rcIndex + 2 < n; rcIndex += 3) {
    const codon = reverseComplementCodon(seq, rcIndex);
    if (codon === 'ATG') {
      startPositions.push(rcIndex);
    }

    if (stopCodons.has(codon) && startPositions.length > 0) {
      const rcStart = startPositions[0];
      const rcEnd = rcIndex + 2;
      const length = rcEnd - rcStart + 1;
      if (length >= minLength) {
        out.push({
          start: n - 1 - rcEnd,
          end: n - 1 - rcStart,
          frame: frameLabel,
          strand: '-',
          length,
        });
      }
      startPositions.length = 0;
    }

    codonsSinceYield += 1;
    if (codonsSinceYield >= YIELD_EVERY_CODONS) {
      codonsSinceYield = 0;
      if (!(await maybeYield(YIELD_EVERY_CODONS, isActive))) return false;
    }
  }

  return isActive();
}

export async function findORFsCooperatively(
  sequence: string,
  minLength: number,
  isActive: () => boolean,
  geneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID
): Promise<ORF[] | null> {
  const seq = toNucleicAcid(sequence.toUpperCase(), 'dna');
  const stopCodons = resolveGeneticCode(geneticCode).frameEndingCodons;
  const orfs: ORF[] = [];

  for (let frame = 0; frame < 3; frame++) {
    const ok = await scanForwardFrame(seq, frame, frame + 1, minLength, orfs, isActive, stopCodons);
    if (!ok) return null;
  }

  for (let frame = 0; frame < 3; frame++) {
    const ok = await scanReverseFrame(
      seq,
      frame,
      -(frame + 1),
      minLength,
      orfs,
      isActive,
      stopCodons
    );
    if (!ok) return null;
  }

  return isActive() ? orfs : null;
}

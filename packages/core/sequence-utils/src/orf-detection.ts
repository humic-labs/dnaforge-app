import { reverseComplement } from './translation';
import { toNucleicAcid } from './iupac';
import { resolveGeneticCode, STANDARD_GENETIC_CODE, type GeneticCodeInput } from './genetic-codes';

export interface ORF {
  start: number;
  end: number;
  frame: number;
  strand: '+' | '-';
  length: number;
  segments?: Array<{ start: number; end: number }>;
}

const STOP_CODONS: ReadonlySet<string> = STANDARD_GENETIC_CODE.stopCodons;

export interface FindORFsOptions {
  segments?: ReadonlyArray<{ start: number; end: number }>;
  geneticCode?: GeneticCodeInput;
  allowAlternativeStartCodons?: boolean;
}

export function findORFs(sequence: string, minLength = 100, options: FindORFsOptions = {}): ORF[] {
  const seq = toNucleicAcid(sequence.toUpperCase(), 'dna');
  const scan = scanRulesFor(options);
  if (options.segments && options.segments.length > 0) {
    return findSplicedORFs(seq, minLength, options.segments, scan);
  }

  const orfs: ORF[] = [];

  for (let frame = 0; frame < 3; frame++) {
    scanFrame(seq, frame, frame + 1, '+', minLength, orfs, scan);
  }

  const rc = reverseComplement(seq);
  for (let frame = 0; frame < 3; frame++) {
    const rcOrfs: ORF[] = [];
    scanFrame(rc, frame, -(frame + 1), '-', minLength, rcOrfs, scan);
    for (const orf of rcOrfs) {
      const fwdStart = seq.length - 1 - orf.end;
      const fwdEnd = seq.length - 1 - orf.start;
      orfs.push({ ...orf, start: fwdStart, end: fwdEnd });
    }
  }

  return orfs;
}

function findSplicedORFs(
  seq: string,
  minLength: number,
  segments: ReadonlyArray<{ start: number; end: number }>,
  scan: ScanRules
): ORF[] {
  let splicedFwd = '';
  const splicedIdxToGenomic: number[] = [];
  for (const seg of segments) {
    for (let p = seg.start; p < seg.end; p++) {
      splicedFwd += seq[p] ?? 'N';
      splicedIdxToGenomic.push(p);
    }
  }

  const orfs: ORF[] = [];

  for (let frame = 0; frame < 3; frame++) {
    const found: ORF[] = [];
    scanFrame(splicedFwd, frame, frame + 1, '+', minLength, found, scan);
    for (const o of found) {
      const segs = splicedRangeToGenomicSegments(splicedIdxToGenomic, o.start, o.end);
      orfs.push({
        ...o,
        start: segs[0].start,
        end: segs[segs.length - 1].end - 1,
        segments: segs,
      });
    }
  }

  const rcSpliced = reverseComplement(splicedFwd);
  for (let frame = 0; frame < 3; frame++) {
    const found: ORF[] = [];
    scanFrame(rcSpliced, frame, -(frame + 1), '-', minLength, found, scan);
    for (const o of found) {
      const fwdSplStart = splicedFwd.length - 1 - o.end;
      const fwdSplEnd = splicedFwd.length - 1 - o.start;
      const segs = splicedRangeToGenomicSegments(splicedIdxToGenomic, fwdSplStart, fwdSplEnd);
      orfs.push({
        ...o,
        start: segs[0].start,
        end: segs[segs.length - 1].end - 1,
        segments: segs,
      });
    }
  }

  return orfs;
}

function splicedRangeToGenomicSegments(
  splicedIdxToGenomic: number[],
  splStart: number,
  splEnd: number
): Array<{ start: number; end: number }> {
  const segs: Array<{ start: number; end: number }> = [];
  let runStart = splicedIdxToGenomic[splStart];
  let prev = runStart;
  for (let i = splStart + 1; i <= splEnd; i++) {
    const g = splicedIdxToGenomic[i];
    if (g === prev + 1) {
      prev = g;
      continue;
    }
    segs.push({ start: runStart, end: prev + 1 });
    runStart = g;
    prev = g;
  }
  segs.push({ start: runStart, end: prev + 1 });
  return segs;
}

interface ScanRules {
  readonly startCodons: ReadonlySet<string>;
  readonly stopCodons: ReadonlySet<string>;
}

const ATG_ONLY: ReadonlySet<string> = new Set(['ATG']);

function scanRulesFor(options: FindORFsOptions): ScanRules {
  const code = resolveGeneticCode(options.geneticCode);
  return {
    startCodons: options.allowAlternativeStartCodons ? code.startCodons : ATG_ONLY,
    stopCodons: options.geneticCode === undefined ? STOP_CODONS : code.frameEndingCodons,
  };
}

function scanFrame(
  seq: string,
  frameOffset: number,
  frameLabel: number,
  strand: '+' | '-',
  minLength: number,
  out: ORF[],
  scan: ScanRules
): void {
  const startPositions: number[] = [];

  for (let i = frameOffset; i + 2 < seq.length; i += 3) {
    const codon = seq.substring(i, i + 3);

    if (scan.startCodons.has(codon)) {
      startPositions.push(i);
    }

    if (scan.stopCodons.has(codon) && startPositions.length > 0) {
      const start = startPositions[0];
      const end = i + 2;
      const length = end - start + 1;

      if (length >= minLength) {
        out.push({ start, end, frame: frameLabel, strand, length });
      }

      startPositions.length = 0;
    }
  }
}

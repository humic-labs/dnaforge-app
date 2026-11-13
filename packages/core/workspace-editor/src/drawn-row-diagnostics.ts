import type { PrecomputedLinePosition } from './hooks/usePrecomputedLayout';

export type DrawnRowSource = 'main' | 'worker';

export type DrawnRowRole = 'linear' | 'real' | 'top-buffer' | 'bottom-buffer' | 'wrap-buffer';

export interface DrawnRowDiagnosticsOptions {
  showAnnotations?: boolean;
  showReverseComplement?: boolean;
  showTranslation?: boolean;
}

export interface DrawnRowDiagnostic {
  lineIndex: number;
  role: DrawnRowRole;
  startPos: number;
  endPos: number;
  absoluteYStart: number;
  absoluteYEnd: number;
  absoluteSequenceY: number;
  viewportYStart: number;
  viewportYEnd: number;
  sequenceLength: number;
  complementLength: number;
  sequenceHash: string;
  complementHash: string;
  annotationLaneCount: number;
  annotationCount: number;
  annotationHash: string;
  translationLaneCount: number;
  classifiedCdsCount: number;
  classifiedCdsHash: string;
  forwardOrfLaneCount: number;
  forwardOrfCount: number;
  forwardOrfHash: string;
  reverseOrfLaneCount: number;
  reverseOrfCount: number;
  reverseOrfHash: string;
  hasPrimers: boolean;
  hasForwardPrimers: boolean;
  hasReversePrimers: boolean;
  payloadReady: boolean;
  payloadProblems: string[];
}

export interface CanvasDrawnRowsSnapshot {
  t: number;
  source: DrawnRowSource;
  scrollTop: number;
  height: number;
  rows: DrawnRowDiagnostic[];
}

function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const baseHashes = new WeakMap<
  PrecomputedLinePosition['line'],
  { sequence: string; complement: string; sequenceHash: string; complementHash: string }
>();

function rowBaseHashes(
  line: PrecomputedLinePosition['line'],
  sequence: string,
  complement: string
) {
  const cached = baseHashes.get(line);
  if (cached?.sequence === sequence && cached.complement === complement) return cached;
  const next = {
    sequence,
    complement,
    sequenceHash: cached?.sequence === sequence ? cached.sequenceHash : hashText(sequence),
    complementHash:
      cached?.complement === complement ? cached.complementHash : hashText(complement),
  };
  baseHashes.set(line, next);
  return next;
}

function hashItems<T>(items: readonly T[] | undefined, serialize: (item: T) => string): string {
  if (!items || items.length === 0) return '';
  let combined = '';
  for (let i = 0; i < items.length; i++) {
    combined += `${i}:${serialize(items[i])};`;
  }
  return hashText(combined);
}

function rowRole(line: PrecomputedLinePosition['line']): DrawnRowRole {
  if (line.isTopBuffer) return 'top-buffer';
  if (line.isBottomBuffer) return 'bottom-buffer';
  if (line.isWrapLine) return 'wrap-buffer';
  return 'real';
}

export function summarizeDrawnRow(
  linePosition: PrecomputedLinePosition,
  options: DrawnRowDiagnosticsOptions = {}
): DrawnRowDiagnostic {
  const { line } = linePosition;
  const sequence = line.sequence,
    complement = line.complementSequence;
  let hashes: ReturnType<typeof rowBaseHashes> | undefined;
  const contentHashes = () => (hashes ??= rowBaseHashes(line, sequence, complement));
  const annotationLaneCount = line.annotationLaneCount ?? 0;
  const translationLaneCount = line.translationLaneCount ?? 0;
  const forwardOrfLaneCount = line.forwardOrfLaneCount ?? 0;
  const reverseOrfLaneCount = line.reverseOrfLaneCount ?? 0;
  const annotationCount = line.annotations.length;
  const classifiedCdsCount = line.classifiedCDSs?.length ?? 0;
  const forwardOrfCount = line.forwardOrfs?.length ?? 0;
  const reverseOrfCount = line.reverseOrfs?.length ?? 0;

  const payloadProblems: string[] = [];
  if (options.showReverseComplement !== false && line.sequence.length > 0) {
    if (line.complementSequence.length !== line.sequence.length) {
      payloadProblems.push('reverse-complement-length-mismatch');
    }
  }
  if (options.showAnnotations !== false && annotationLaneCount > 0 && annotationCount === 0) {
    payloadProblems.push('annotation-lanes-without-annotations');
  }
  if (options.showTranslation !== false && translationLaneCount > 0 && classifiedCdsCount === 0) {
    payloadProblems.push('translation-lanes-without-cds');
  }
  if (forwardOrfLaneCount > 0 && forwardOrfCount === 0) {
    payloadProblems.push('forward-orf-lanes-without-orfs');
  }
  if (reverseOrfLaneCount > 0 && reverseOrfCount === 0) {
    payloadProblems.push('reverse-orf-lanes-without-orfs');
  }

  return {
    lineIndex: line.lineIndex,
    role: rowRole(line),
    startPos: line.startPos,
    endPos: line.endPos,
    absoluteYStart: linePosition.absoluteLineY,
    absoluteSequenceY:
      linePosition.absoluteLineY + (linePosition.sequenceY - linePosition.annotationY),
    absoluteYEnd: linePosition.absoluteLineY + (linePosition.lineEndY - linePosition.annotationY),
    viewportYStart: linePosition.annotationY,
    viewportYEnd: linePosition.lineEndY,
    sequenceLength: line.sequence.length,
    complementLength: line.complementSequence.length,
    get sequenceHash() {
      return contentHashes().sequenceHash;
    },
    get complementHash() {
      return contentHashes().complementHash;
    },
    annotationLaneCount,
    annotationCount,
    annotationHash: hashItems(
      line.annotations,
      (ann) => `${ann.name}|${ann.type}|${ann.start}|${ann.end}|${ann.direction}|${ann.lane}`
    ),
    translationLaneCount,
    classifiedCdsCount,
    classifiedCdsHash: hashItems(
      line.classifiedCDSs,
      (cds) =>
        `${cds.name}|${cds.type}|${cds.start}|${cds.end}|${cds.direction}|${cds.translationLane}`
    ),
    forwardOrfLaneCount,
    forwardOrfCount,
    forwardOrfHash: hashItems(
      line.forwardOrfs,
      (orf) => `${orf.start}|${orf.end}|${orf.frame}|${orf.strand}|${orf.lane}`
    ),
    reverseOrfLaneCount,
    reverseOrfCount,
    reverseOrfHash: hashItems(
      line.reverseOrfs,
      (orf) => `${orf.start}|${orf.end}|${orf.frame}|${orf.strand}|${orf.lane}`
    ),
    hasPrimers: linePosition.hasPrimers,
    hasForwardPrimers: linePosition.hasForwardPrimers,
    hasReversePrimers: linePosition.hasReversePrimers,
    payloadReady: payloadProblems.length === 0,
    payloadProblems,
  };
}

export function summarizeDrawnRows(
  linePositions: readonly PrecomputedLinePosition[],
  options: DrawnRowDiagnosticsOptions = {}
): DrawnRowDiagnostic[] {
  return linePositions.map((linePosition) => summarizeDrawnRow(linePosition, options));
}

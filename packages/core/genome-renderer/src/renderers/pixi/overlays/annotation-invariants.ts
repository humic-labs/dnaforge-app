import { isWebGLDiagnosticsEnabled } from '../../../diagnostics-gate';

export type AnnotationInvariantId = 'TRANSCRIPT_BLOCK_COUNT_COHERENCE';

export interface AnnotationInvariantContext {
  readonly visibleFeatureCount: number;
  readonly blockCount: number;
  readonly renderMode: 'none' | 'rebuild' | 'cache-hit' | 'retained';
  readonly transcriptKey: string;
  readonly sourceWindowStartBp: number | null;
  readonly sourceWindowEndBp: number | null;
  readonly viewStartBp: number;
  readonly viewEndBp: number;
  readonly transcriptSamples: ReadonlyArray<{
    id: number;
    type: string;
    displayName?: string;
    start: number;
    end: number;
    exonCount: number;
    cdsCount: number;
    laneResolved: boolean;
  }>;
}

export class AnnotationInvariantViolationError extends Error {
  constructor(
    public readonly invariantId: AnnotationInvariantId,
    public readonly message: string,
    public readonly context: AnnotationInvariantContext
  ) {
    super(`[${invariantId}] ${message}`);
    this.name = 'AnnotationInvariantViolationError';
  }
}

const VIOLATION_LOG_CAP = 20;

interface AnnotationInvariantSink {
  __annotationInvariantViolations?: AnnotationInvariantViolationRecord[];
}

export interface AnnotationInvariantViolationRecord {
  invariantId: AnnotationInvariantId;
  message: string;
  context: AnnotationInvariantContext;
  capturedAt: number;
}

function appendViolationLog(record: AnnotationInvariantViolationRecord): void {
  if (typeof window === 'undefined') return;
  const sink = window as Window & AnnotationInvariantSink;
  if (!sink.__annotationInvariantViolations) {
    sink.__annotationInvariantViolations = [];
  }
  sink.__annotationInvariantViolations.push(record);
  if (sink.__annotationInvariantViolations.length > VIOLATION_LOG_CAP) {
    sink.__annotationInvariantViolations.splice(
      0,
      sink.__annotationInvariantViolations.length - VIOLATION_LOG_CAP
    );
  }
}

export function checkTranscriptBlockCountCoherence(
  context: AnnotationInvariantContext
): AnnotationInvariantViolationRecord | null {
  const { visibleFeatureCount, blockCount, renderMode } = context;
  if (renderMode !== 'retained') return null;
  if (visibleFeatureCount === 0) return null;
  if (blockCount > 0) return null;

  const record: AnnotationInvariantViolationRecord = {
    invariantId: 'TRANSCRIPT_BLOCK_COUNT_COHERENCE',
    message:
      `Retained overview render path believed ${visibleFeatureCount} transcript(s) should ` +
      `draw, but built 0 GPU blocks. Every transcript was rejected by buildTranscriptGlyphBlocks ` +
      `— either none have exons, or none resolved a lane envelope. See ` +
      `annotation-invariant-runbook.md#TRANSCRIPT_BLOCK_COUNT_COHERENCE for diagnostic steps.`,
    context,
    capturedAt: Date.now(),
  };
  return record;
}

export function runAnnotationInvariantGuard(
  context: AnnotationInvariantContext
): AnnotationInvariantViolationRecord | null {
  if (!isWebGLDiagnosticsEnabled()) return null;

  const blockCountViolation = checkTranscriptBlockCountCoherence(context);
  if (blockCountViolation) {
    appendViolationLog(blockCountViolation);
    return blockCountViolation;
  }

  return null;
}

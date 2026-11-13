import type { Feature } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import {
  AnnotationInvariantViolationError,
  runAnnotationInvariantGuard,
  type AnnotationInvariantContext,
} from './annotation-invariants';

export type InvariantGuardHost = {
  retainedLinearSourceWindow: { startBp: number; endBp: number } | null;
  featureEnvelope(feature: Feature): unknown;
};

export function runInvariantGuardAfterRetainedSync(
  host: InvariantGuardHost,
  transcripts: Feature[],
  blockCount: number,
  transcriptKey: string,
  path: PathMapper
): void {
  const visibleFeatureCount = transcripts.length;
  if (visibleFeatureCount === 0) return;
  if (blockCount > 0) return;

  const sourceWindow = host.retainedLinearSourceWindow;
  const samples = transcripts.slice(0, 5).map((f) => ({
    id: f.id,
    type: f.type,
    displayName: f.displayName,
    start: f.start,
    end: f.end,
    exonCount: f.exons?.length ?? 0,
    cdsCount: f.cds?.length ?? 0,
    laneResolved: host.featureEnvelope(f) !== null,
  }));
  const context: AnnotationInvariantContext = {
    visibleFeatureCount,
    blockCount,
    renderMode: 'retained',
    transcriptKey,
    sourceWindowStartBp: sourceWindow?.startBp ?? null,
    sourceWindowEndBp: sourceWindow?.endBp ?? null,
    viewStartBp: path.viewStartBp,
    viewEndBp: path.viewEndBp,
    transcriptSamples: samples,
  };
  const violation = runAnnotationInvariantGuard(context);
  if (!violation) return;

  if (
    typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test'
  ) {
    throw new AnnotationInvariantViolationError(
      violation.invariantId,
      violation.message,
      violation.context
    );
  }
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(`[${violation.invariantId}] ${violation.message}`, violation.context);
  }
}

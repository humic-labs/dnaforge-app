import { Sentry } from '../../../../../lib/sentry';
import type { FirstPaintReadiness } from './viewerReadiness';

export const STRUCTURE_LOAD_TIMEOUT_MS = 30 * 1000;
export const STRUCTURE_LOAD_HARD_CEILING_MS = 5 * 60 * 1000;
export const STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE =
  'Structure load timeout - took longer than the hard ceiling';

export type StructureLoadLeg =
  | 'waitForDimensions'
  | 'initializePlugin'
  | 'loadStructure'
  | 'onBeforeReveal'
  | 'waitForInitialCoordinates'
  | 'waitForFirstPaint';

export type StructureLoadSizeBucket =
  | 'unknown'
  | 'tiny'
  | 'small'
  | 'medium'
  | 'large'
  | 'very-large';

export type StructureLoadLegTimings = {
  startedAt: number;
  sourceKind: 'rcsb' | 'alphafold' | 'url' | 'inline' | 'unknown';
  sizeBucket: StructureLoadSizeBucket;
  legs: Partial<Record<StructureLoadLeg, number>>;
  legDurations: Partial<Record<StructureLoadLeg, number>>;
  slowAt?: number;
  throwingLeg?: StructureLoadLeg | 'hardCeiling';
  finishedAt?: number;
  outcome?: 'ready' | 'cancelled' | 'error';
  firstPaint?: FirstPaintReadiness;
};

export type StructureLoadLifecycle = {
  timings: StructureLoadLegTimings;
  awaitLeg: <T>(leg: StructureLoadLeg, promise: Promise<T>) => Promise<T>;
  checkTimeout: () => void;
  finish: (outcome: NonNullable<StructureLoadLegTimings['outcome']>, error?: string) => void;
  dispose: () => void;
};

type StructureLoadTelemetryEvent = {
  event: 'slow' | 'finished';
  outcome?: StructureLoadLegTimings['outcome'];
  elapsedMs: number;
  sourceKind: StructureLoadLegTimings['sourceKind'];
  sizeBucket: StructureLoadSizeBucket;
  currentLeg?: StructureLoadLeg | 'hardCeiling';
  legDurations: StructureLoadLegTimings['legDurations'];
  firstPaintResolution?: FirstPaintReadiness['resolution'];
};

type StructureLoadSpan = ReturnType<typeof Sentry.startInactiveSpan>;

type StructureSourceOptions = {
  pdbId?: string;
  uniprotId?: string;
  url?: string;
  structureData?: string | Uint8Array;
};

function recordStructureLoadLegDiagnostics(timings: StructureLoadLegTimings): void {
  if (typeof window === 'undefined') return;
  const testWindow = window as typeof window & {
    __structureLoadLegTimings?: StructureLoadLegTimings;
    __test?: unknown;
  };
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test' && !testWindow.__test) return;
  testWindow.__structureLoadLegTimings = timings;
}

function recordStructureLoadTelemetryForTest(event: StructureLoadTelemetryEvent): void {
  if (typeof window === 'undefined') return;
  const testWindow = window as typeof window & {
    __structureLoadTelemetry?: StructureLoadTelemetryEvent[];
    __test?: unknown;
  };
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'test' && !testWindow.__test) return;
  testWindow.__structureLoadTelemetry = [
    ...(testWindow.__structureLoadTelemetry ?? []),
    event,
  ].slice(-50);
}

function telemetryAttributes(
  timings: StructureLoadLegTimings
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    'structure.source_kind': timings.sourceKind,
    'structure.size_bucket': timings.sizeBucket,
    'structure.outcome': timings.outcome ?? 'unknown',
    'structure.slow': timings.slowAt !== undefined,
    'structure.duration_ms': timings.finishedAt ?? Date.now() - timings.startedAt,
  };
  if (timings.throwingLeg) attributes['structure.throwing_leg'] = timings.throwingLeg;
  if (timings.firstPaint) {
    attributes['structure.first_paint.resolution'] = timings.firstPaint.resolution;
    attributes['structure.first_paint.elapsed_ms'] = timings.firstPaint.elapsedMs;
    attributes['structure.first_paint.attempts'] = timings.firstPaint.attempts;
    attributes['structure.first_paint.structure_count'] = timings.firstPaint.structureCount;
    attributes['structure.first_paint.representation_count'] =
      timings.firstPaint.representationCount;
    attributes['structure.first_paint.draw_events'] = timings.firstPaint.drawEvents;
    attributes['structure.first_paint.canvas_representation_count'] =
      timings.firstPaint.canvasRepresentationCount;
    const paintState = timings.firstPaint.paintState;
    if (paintState?.width !== undefined) {
      attributes['structure.first_paint.buffer_width'] = paintState.width;
    }
    if (paintState?.height !== undefined) {
      attributes['structure.first_paint.buffer_height'] = paintState.height;
    }
    if (paintState?.nonWhitePixels !== undefined) {
      attributes['structure.first_paint.non_white_samples'] = paintState.nonWhitePixels;
    }
  }
  for (const [leg, duration] of Object.entries(timings.legDurations)) {
    if (typeof duration === 'number') attributes[`structure.leg.${leg}.duration_ms`] = duration;
  }
  return attributes;
}

function startStructureLoadTelemetrySpan(
  timings: StructureLoadLegTimings
): StructureLoadSpan | undefined {
  try {
    return Sentry.startInactiveSpan({
      name: 'structure.viewer.load',
      op: 'ui.load',
      forceTransaction: true,
      startTime: new Date(timings.startedAt),
      attributes: {
        'structure.source_kind': timings.sourceKind,
        'structure.size_bucket': timings.sizeBucket,
      },
    });
  } catch {
    return undefined;
  }
}

function recordStructureLoadFinishedTelemetry(
  timings: StructureLoadLegTimings,
  span: StructureLoadSpan | undefined
): void {
  const elapsedMs = timings.finishedAt ?? Date.now() - timings.startedAt;
  recordStructureLoadTelemetryForTest({
    event: 'finished',
    outcome: timings.outcome,
    elapsedMs,
    sourceKind: timings.sourceKind,
    sizeBucket: timings.sizeBucket,
    currentLeg: timings.throwingLeg,
    legDurations: { ...timings.legDurations },
    firstPaintResolution: timings.firstPaint?.resolution,
  });
  if (!span) return;
  try {
    span.setAttributes(telemetryAttributes(timings));
    const outcome = timings.outcome;
    span.setStatus({
      code: outcome === 'ready' ? 1 : outcome === 'cancelled' ? 0 : 2,
      message:
        outcome === 'ready' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'internal_error',
    });
    span.end(new Date(timings.startedAt + elapsedMs));
  } catch {}
}

function recordStructureLoadSlowTelemetry(
  timings: StructureLoadLegTimings,
  currentLeg: StructureLoadLeg,
  span: StructureLoadSpan | undefined
): void {
  const elapsedMs = Date.now() - timings.startedAt;
  recordStructureLoadTelemetryForTest({
    event: 'slow',
    elapsedMs,
    sourceKind: timings.sourceKind,
    sizeBucket: timings.sizeBucket,
    currentLeg,
    legDurations: { ...timings.legDurations },
  });
  try {
    span?.addEvent('structure.viewer.load.slow', {
      'structure.elapsed_ms': elapsedMs,
      'structure.current_leg': currentLeg,
    });
    Sentry.captureMessage('structure.viewer.load.slow', {
      level: 'warning',
      tags: {
        source_kind: timings.sourceKind,
        size_bucket: timings.sizeBucket,
        current_leg: currentLeg,
      },
      extra: {
        elapsed_ms: elapsedMs,
        leg_durations_ms: { ...timings.legDurations },
      },
    });
  } catch {}
}

function structureSourceKind(
  options: StructureSourceOptions
): StructureLoadLegTimings['sourceKind'] {
  if (options.structureData) return 'inline';
  if (options.uniprotId) return 'alphafold';
  if (options.pdbId) return 'rcsb';
  if (options.url) return 'url';
  return 'unknown';
}

export function structureLoadSizeBucket(
  structureData: StructureSourceOptions['structureData']
): StructureLoadSizeBucket {
  if (!structureData) return 'unknown';
  const size = structureData.length;
  if (size <= 256 * 1024) return 'tiny';
  if (size <= 1024 * 1024) return 'small';
  if (size <= 5 * 1024 * 1024) return 'medium';
  if (size <= 20 * 1024 * 1024) return 'large';
  return 'very-large';
}

async function withStructureLoadTimeout<T>(
  promise: Promise<T>,
  options: { loadStartTime: number; onSlow?: () => void }
): Promise<T> {
  let slowTimerId: ReturnType<typeof setTimeout> | undefined;
  let hardTimerId: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const elapsed = Date.now() - options.loadStartTime;
  const softRemaining = Math.max(0, STRUCTURE_LOAD_TIMEOUT_MS - elapsed);
  const hardRemaining = Math.max(0, STRUCTURE_LOAD_HARD_CEILING_MS - elapsed);

  const hardTimeout = new Promise<never>((_, reject) => {
    hardTimerId = setTimeout(() => {
      if (!settled) reject(new Error(STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE));
    }, hardRemaining);
  });

  if (softRemaining === 0) {
    options.onSlow?.();
  } else {
    slowTimerId = setTimeout(() => {
      if (!settled) options.onSlow?.();
    }, softRemaining);
  }

  try {
    return await Promise.race([promise, hardTimeout]);
  } finally {
    settled = true;
    if (slowTimerId !== undefined) clearTimeout(slowTimerId);
    if (hardTimerId !== undefined) clearTimeout(hardTimerId);
  }
}

export function createStructureLoadLifecycle(options: {
  source: StructureSourceOptions;
  onSlow?: () => void;
}): StructureLoadLifecycle {
  const loadStartTime = Date.now();
  let slowNotified = false;
  let currentLeg: StructureLoadLeg = 'waitForDimensions';
  let finished = false;
  const timings: StructureLoadLegTimings = {
    startedAt: loadStartTime,
    sourceKind: structureSourceKind(options.source),
    sizeBucket: structureLoadSizeBucket(options.source.structureData),
    legs: {},
    legDurations: {},
  };
  recordStructureLoadLegDiagnostics(timings);
  const loadSpan = startStructureLoadTelemetrySpan(timings);

  const notifySlow = (): void => {
    if (slowNotified || finished) return;
    slowNotified = true;
    timings.slowAt = Date.now() - loadStartTime;
    recordStructureLoadLegDiagnostics(timings);
    recordStructureLoadSlowTelemetry(timings, currentLeg, loadSpan);
    options.onSlow?.();
  };

  const softBoundaryTimerId = window.setTimeout(notifySlow, STRUCTURE_LOAD_TIMEOUT_MS);

  const checkTimeout = (): void => {
    const elapsed = Date.now() - loadStartTime;
    if (elapsed > STRUCTURE_LOAD_TIMEOUT_MS) notifySlow();
    if (elapsed > STRUCTURE_LOAD_HARD_CEILING_MS) {
      timings.throwingLeg = 'hardCeiling';
      recordStructureLoadLegDiagnostics(timings);
      throw new Error(STRUCTURE_LOAD_HARD_TIMEOUT_MESSAGE);
    }
  };

  const awaitLeg = async <T>(leg: StructureLoadLeg, promise: Promise<T>): Promise<T> => {
    currentLeg = leg;
    timings.legs[leg] = Date.now() - loadStartTime;
    recordStructureLoadLegDiagnostics(timings);
    const legStartedAt = Date.now();
    try {
      return await withStructureLoadTimeout(promise, {
        loadStartTime,
        onSlow: notifySlow,
      });
    } finally {
      timings.legDurations[leg] = Date.now() - legStartedAt;
      recordStructureLoadLegDiagnostics(timings);
    }
  };

  const finish: StructureLoadLifecycle['finish'] = (outcome, error) => {
    if (finished) return;
    finished = true;
    if (outcome === 'error' && !timings.throwingLeg) {
      timings.throwingLeg =
        error?.includes('hard ceiling') || error?.includes('Structure load timeout')
          ? 'hardCeiling'
          : currentLeg;
    }
    timings.outcome = outcome;
    timings.finishedAt = Date.now() - loadStartTime;
    recordStructureLoadLegDiagnostics(timings);
    recordStructureLoadFinishedTelemetry(timings, loadSpan);
  };

  return {
    timings,
    awaitLeg,
    checkTimeout,
    finish,
    dispose: () => window.clearTimeout(softBoundaryTimerId),
  };
}

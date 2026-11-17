import type { AnnotationRecord } from '@waypoint/genome-data';

import { writePackedBpCoordinate } from '../overview/bp-coordinate-packing';

export interface AnnotationRecordVertices {
  bpStartChunk: Float32Array;
  bpStartDelta: Float32Array;
  bpEndChunk: Float32Array;
  bpEndDelta: Float32Array;
  offsetCenter: Float32Array;
  halfH: Float32Array;
  xSide: Float32Array;
  ySide: Float32Array;
  color: Float32Array;
  visibleRecordCount: number;
  droppedRecordCount: number;
  activeVertexCount: number;
}

export interface AnnotationRecordVerticesPool {
  bpStartChunk: Float32Array;
  bpStartDelta: Float32Array;
  bpEndChunk: Float32Array;
  bpEndDelta: Float32Array;
  offsetCenter: Float32Array;
  halfH: Float32Array;
  xSide: Float32Array;
  ySide: Float32Array;
  color: Float32Array;
  capacityVertices: number;
}

export function createAnnotationRecordVerticesPool(): AnnotationRecordVerticesPool {
  return {
    bpStartChunk: new Float32Array(0),
    bpStartDelta: new Float32Array(0),
    bpEndChunk: new Float32Array(0),
    bpEndDelta: new Float32Array(0),
    offsetCenter: new Float32Array(0),
    halfH: new Float32Array(0),
    xSide: new Float32Array(0),
    ySide: new Float32Array(0),
    color: new Float32Array(0),
    capacityVertices: 0,
  };
}

export function ensureVerticesPoolCapacity(
  pool: AnnotationRecordVerticesPool,
  vertexCount: number
): boolean {
  if (vertexCount <= pool.capacityVertices) return false;
  const cap = Math.max(vertexCount, Math.ceil(pool.capacityVertices * 1.5), 6);
  pool.bpStartChunk = new Float32Array(cap);
  pool.bpStartDelta = new Float32Array(cap);
  pool.bpEndChunk = new Float32Array(cap);
  pool.bpEndDelta = new Float32Array(cap);
  pool.offsetCenter = new Float32Array(cap);
  pool.halfH = new Float32Array(cap);
  pool.xSide = new Float32Array(cap);
  pool.ySide = new Float32Array(cap);
  pool.color = new Float32Array(cap * 4);
  pool.capacityVertices = cap;
  return true;
}

export interface BuildVerticesConfig {
  laneHeightPx: number;
  defaultColor: number;
  defaultAlpha?: number;
  includeRecord?: (record: AnnotationRecord, index: number) => boolean;
  colorForRecord?: (record: AnnotationRecord, index: number) => number;
}

export type AnnotationLaneAssignment = Int16Array | Int32Array;

export function buildAnnotationRecordVertices(
  records: ReadonlyArray<AnnotationRecord>,
  laneAssignment: AnnotationLaneAssignment,
  config: BuildVerticesConfig
): AnnotationRecordVertices {
  const job = beginAnnotationRecordVerticesJob(records, laneAssignment, config);
  advanceAnnotationRecordVerticesJob(job, Number.POSITIVE_INFINITY);
  return finishAnnotationRecordVerticesJob(job);
}

export interface BeginJobOptions {
  pool?: AnnotationRecordVerticesPool;
  visibleRecordCount?: number;
}

export interface AnnotationRecordVerticesJob {
  readonly records: ReadonlyArray<AnnotationRecord>;
  readonly laneAssignment: AnnotationLaneAssignment;
  readonly halfHeightPx: number;
  readonly laneHeightPx: number;
  readonly defaultColor: number;
  readonly defaultAlpha: number;
  readonly includeRecord: BuildVerticesConfig['includeRecord'];
  readonly colorForRecord: BuildVerticesConfig['colorForRecord'];
  readonly out: AnnotationRecordVertices;
  recordCursor: number;
  vertexCursor: number;
  droppedCursor: number;
}

const X_CORNERS = [0, 1, 1, 0, 1, 0];
const Y_CORNERS = [-1, -1, 1, -1, 1, 1];
const RECORD_BUDGET_CHECK_INTERVAL = 4;
const monotonicNow = (): number => performance.now();

export function beginAnnotationRecordVerticesJob(
  records: ReadonlyArray<AnnotationRecord>,
  laneAssignment: AnnotationLaneAssignment,
  config: BuildVerticesConfig,
  options?: BeginJobOptions
): AnnotationRecordVerticesJob {
  if (records.length !== laneAssignment.length) {
    throw new Error(
      `buildAnnotationRecordVertices: records.length (${records.length}) !== laneAssignment.length (${laneAssignment.length})`
    );
  }
  const { laneHeightPx, defaultColor, includeRecord, colorForRecord } = config;
  const defaultAlpha = config.defaultAlpha ?? 1;
  if (laneHeightPx <= 0) throw new Error(`laneHeightPx must be positive`);

  let visibleCount = options?.visibleRecordCount ?? 0;
  if (options?.visibleRecordCount === undefined) {
    for (let i = 0; i < records.length; i++) {
      if (includeRecord && !includeRecord(records[i], i)) continue;
      if (laneAssignment[i] >= 0) visibleCount++;
    }
  } else if (!Number.isInteger(visibleCount) || visibleCount < 0 || visibleCount > records.length) {
    throw new RangeError('prepared visible record count must fit records');
  }
  const vertexCount = visibleCount * 6;

  let out: AnnotationRecordVertices;
  const pool = options?.pool;
  if (pool) {
    ensureVerticesPoolCapacity(pool, vertexCount);
    out = {
      bpStartChunk: pool.bpStartChunk,
      bpStartDelta: pool.bpStartDelta,
      bpEndChunk: pool.bpEndChunk,
      bpEndDelta: pool.bpEndDelta,
      offsetCenter: pool.offsetCenter,
      halfH: pool.halfH,
      xSide: pool.xSide,
      ySide: pool.ySide,
      color: pool.color,
      visibleRecordCount: visibleCount,
      droppedRecordCount: 0,
      activeVertexCount: vertexCount,
    };
  } else {
    out = {
      bpStartChunk: new Float32Array(vertexCount),
      bpStartDelta: new Float32Array(vertexCount),
      bpEndChunk: new Float32Array(vertexCount),
      bpEndDelta: new Float32Array(vertexCount),
      offsetCenter: new Float32Array(vertexCount),
      halfH: new Float32Array(vertexCount),
      xSide: new Float32Array(vertexCount),
      ySide: new Float32Array(vertexCount),
      color: new Float32Array(vertexCount * 4),
      visibleRecordCount: visibleCount,
      droppedRecordCount: 0,
      activeVertexCount: vertexCount,
    };
  }
  return {
    records,
    laneAssignment,
    halfHeightPx: Math.max(0, (laneHeightPx - 1) / 2),
    laneHeightPx,
    defaultColor,
    defaultAlpha,
    includeRecord,
    colorForRecord,
    out,
    recordCursor: 0,
    vertexCursor: 0,
    droppedCursor: 0,
  };
}

export function advanceAnnotationRecordVerticesJob(
  job: AnnotationRecordVerticesJob,
  maxRecords: number,
  options?: { workBudgetMs?: number; now?: () => number }
): number {
  const {
    records,
    laneAssignment,
    halfHeightPx,
    laneHeightPx,
    defaultColor,
    defaultAlpha,
    includeRecord,
    colorForRecord,
    out,
  } = job;
  const {
    bpStartChunk,
    bpStartDelta,
    bpEndChunk,
    bpEndDelta,
    offsetCenter,
    halfH,
    xSide,
    ySide,
    color,
  } = out;
  const end = Math.min(records.length, job.recordCursor + Math.max(0, maxRecords));
  const workBudgetMs = options?.workBudgetMs;
  if (workBudgetMs !== undefined && (!Number.isFinite(workBudgetMs) || workBudgetMs <= 0)) {
    throw new TypeError('annotation vertex work budget must be finite and positive');
  }
  const now = options?.now ?? monotonicNow;
  const startedAt = workBudgetMs === undefined ? 0 : now();
  let vertex = job.vertexCursor;
  let dropped = job.droppedCursor;
  let consumed = 0;
  for (let recIdx = job.recordCursor; recIdx < end; recIdx++) {
    if (
      workBudgetMs !== undefined &&
      consumed > 0 &&
      consumed % RECORD_BUDGET_CHECK_INTERVAL === 0 &&
      now() - startedAt >= workBudgetMs
    ) {
      break;
    }
    consumed++;
    const r = records[recIdx];
    if (includeRecord && !includeRecord(r, recIdx)) continue;
    const lane = laneAssignment[recIdx];
    if (lane < 0) {
      dropped++;
      continue;
    }
    const recColor = colorForRecord?.(r, recIdx) ?? r.color ?? defaultColor;
    const recR = ((recColor >> 16) & 0xff) / 255;
    const recG = ((recColor >> 8) & 0xff) / 255;
    const recB = (recColor & 0xff) / 255;
    const center = lane * laneHeightPx + laneHeightPx / 2;
    for (let i = 0; i < 6; i++) {
      writePackedBpCoordinate(r.start, bpStartChunk, bpStartDelta, vertex);
      writePackedBpCoordinate(r.end, bpEndChunk, bpEndDelta, vertex);
      offsetCenter[vertex] = center;
      halfH[vertex] = halfHeightPx;
      xSide[vertex] = X_CORNERS[i];
      ySide[vertex] = Y_CORNERS[i];
      const ci = vertex * 4;
      color[ci] = recR;
      color[ci + 1] = recG;
      color[ci + 2] = recB;
      color[ci + 3] = defaultAlpha;
      vertex++;
    }
  }
  job.recordCursor += consumed;
  job.vertexCursor = vertex;
  job.droppedCursor = dropped;
  return consumed;
}

export function isAnnotationRecordVerticesJobComplete(job: AnnotationRecordVerticesJob): boolean {
  return job.recordCursor >= job.records.length;
}

export function finishAnnotationRecordVerticesJob(
  job: AnnotationRecordVerticesJob
): AnnotationRecordVertices {
  if (!isAnnotationRecordVerticesJobComplete(job)) {
    throw new Error(
      `finishAnnotationRecordVerticesJob: incomplete (${job.recordCursor}/${job.records.length})`
    );
  }
  job.out.droppedRecordCount = job.droppedCursor;
  return job.out;
}

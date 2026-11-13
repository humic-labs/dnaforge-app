export interface IntervalLike {
  readonly start: number;
  readonly end: number;
}

export class AnnotationRecordIntervalTree {
  private readonly records: ReadonlyArray<IntervalLike>;
  private readonly sortedIdx: Uint32Array;
  private readonly maxEndPrefix: Float64Array;

  constructor(records: ReadonlyArray<IntervalLike>) {
    this.records = records;
    const n = records.length;
    this.sortedIdx = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.sortedIdx[i] = i;
    const localIdx = this.sortedIdx;
    const localRec = records;
    const sortBuf = Array.from(this.sortedIdx);
    sortBuf.sort((a, b) => localRec[a].start - localRec[b].start);
    for (let i = 0; i < n; i++) localIdx[i] = sortBuf[i];

    this.maxEndPrefix = new Float64Array(n);
    let runningMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const e = records[this.sortedIdx[i]].end;
      if (e > runningMax) runningMax = e;
      this.maxEndPrefix[i] = runningMax;
    }
  }

  get size(): number {
    return this.records.length;
  }

  queryAtBp(bp: number): number[] {
    const n = this.sortedIdx.length;
    if (n === 0) return [];
    const hi = this.upperBoundOnStart(bp);
    if (hi === 0) return [];

    const out: number[] = [];
    for (let i = hi - 1; i >= 0; i--) {
      const idx = this.sortedIdx[i];
      const r = this.records[idx];
      if (r.start <= bp && r.end > bp) {
        out.push(idx);
      }
      if (this.maxEndPrefix[i] <= bp) break;
    }
    return out;
  }

  queryAtBpLane(bp: number, lane: number, laneAssignment: Int16Array): number[] {
    const all = this.queryAtBp(bp);
    if (all.length === 0) return [];
    return all.filter((idx) => laneAssignment[idx] === lane);
  }

  private upperBoundOnStart(bp: number): number {
    let lo = 0;
    let hi = this.sortedIdx.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.records[this.sortedIdx[mid]].start <= bp) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

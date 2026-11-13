export interface RowMaximumRun {
  start: number;
  end: number;
  value: number;
}

export class FeatureLaneIndex {
  private readonly positions: number[] = [];
  private readonly after: number[] = [];
  private readonly peaks: Float64Array;
  private readonly size: number;

  constructor(intervals: readonly { start0: number; end0: number }[]) {
    const events = new Map<number, { starts: number; ends: number }>();
    for (const { start0, end0 } of intervals) {
      if (end0 <= start0) continue;
      const start = events.get(start0) ?? { starts: 0, ends: 0 };
      start.starts++;
      events.set(start0, start);
      const end = events.get(end0) ?? { starts: 0, ends: 0 };
      end.ends++;
      events.set(end0, end);
    }
    const sorted = [...events].sort((a, b) => a[0] - b[0]);
    this.size = 2 ** Math.ceil(Math.log2(Math.max(1, sorted.length)));
    this.peaks = new Float64Array(this.size * 2);
    let active = 0;
    sorted.forEach(([position, event], index) => {
      this.positions.push(position);
      active += event.starts - event.ends;
      this.peaks[this.size + index] = active;
      this.after.push(active);
    });
    for (let i = this.size - 1; i > 0; i--)
      this.peaks[i] = Math.max(this.peaks[i * 2], this.peaks[i * 2 + 1]);
  }

  private bound(value: number, inclusive: boolean): number {
    let left = 0,
      right = this.positions.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (this.positions[mid] < value || (inclusive && this.positions[mid] === value))
        left = mid + 1;
      else right = mid;
    }
    return left;
  }

  query(start: number, end: number): number {
    if (end <= start || this.positions.length === 0) return 0;
    const first = this.bound(start, true),
      last = this.bound(end, false);
    let maximum = first > 0 ? this.after[first - 1] : 0;
    let left = this.size + first,
      right = this.size + last;
    while (left < right) {
      if (left & 1) maximum = Math.max(maximum, this.peaks[left++]);
      if (right & 1) maximum = Math.max(maximum, this.peaks[--right]);
      left >>>= 1;
      right >>>= 1;
    }
    return maximum;
  }

  rowMaximumRuns(
    cpr: number,
    seqLength: number,
    circular: boolean,
    offset: number,
    topBuffer: number,
    rows: number
  ): RowMaximumRun[] {
    if (rows <= 0) return [];
    if (cpr <= 0 || !this.positions.length) return [{ start: 0, end: rows, value: 0 }];
    if (circular && cpr >= seqLength)
      return [{ start: 0, end: rows, value: this.query(0, seqLength) }];
    const firstBp = offset - topBuffer * cpr;
    const lastBp = firstBp + rows * cpr;
    const runs: RowMaximumRun[] = [];
    let at = 0;
    let pendingRow = -1;
    let pendingMaximum = 0;
    const append = (end: number, value: number) => {
      if (end <= at) return;
      const previous = runs[runs.length - 1];
      if (previous?.value === value) previous.end = end;
      else runs.push({ start: at, end, value });
      at = end;
    };

    const queryCost = rows * Math.log2(this.size) * (circular ? 4 : 2);
    if (queryCost < this.positions.length) {
      for (let row = 0; row < rows; row++) {
        const start = firstBp + row * cpr;
        if (!circular) {
          append(row + 1, this.query(start, start + cpr));
          continue;
        }
        const local = ((start % seqLength) + seqLength) % seqLength;
        const end = local + cpr;
        const maximum = this.query(local, Math.min(end, seqLength));
        append(
          row + 1,
          end > seqLength ? Math.max(maximum, this.query(0, end - seqLength)) : maximum
        );
      }
      return runs;
    }
    const firstCycle = circular ? Math.floor(firstBp / seqLength) : 0;
    const lastCycle = circular ? Math.floor((lastBp - 1) / seqLength) : 0;
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
      const shift = circular ? cycle * seqLength : 0;
      for (let i = 0; i < this.positions.length - 1; i++) {
        const value = this.after[i];
        if (!value) continue;
        const startBp = this.positions[i] + shift;
        const endBp = this.positions[i + 1] + shift;
        if (endBp <= firstBp || startBp >= lastBp) continue;
        const start = Math.max(0, Math.floor((startBp - firstBp) / cpr));
        const end = Math.min(rows, Math.ceil((endBp - firstBp) / cpr));
        if (end <= start) continue;
        if (start > pendingRow) {
          if (pendingRow >= 0) append(pendingRow + 1, pendingMaximum);
          append(start, 0);
          pendingRow = start;
          pendingMaximum = value;
        } else pendingMaximum = Math.max(pendingMaximum, value);
        if (end > pendingRow + 1) {
          append(pendingRow + 1, pendingMaximum);
          append(end - 1, value);
          pendingRow = end - 1;
          pendingMaximum = value;
        }
      }
    }
    if (pendingRow >= 0) append(pendingRow + 1, pendingMaximum);
    append(rows, 0);
    return runs;
  }

  rowMaximums(
    cpr: number,
    seqLength: number,
    circular: boolean,
    offset: number,
    topBuffer: number,
    rows: number
  ): Uint8Array | Uint16Array | Uint32Array {
    const maximum = this.peaks[1] ?? 0;
    const result =
      maximum <= 0xff
        ? new Uint8Array(rows)
        : maximum <= 0xffff
          ? new Uint16Array(rows)
          : new Uint32Array(rows);
    for (const run of this.rowMaximumRuns(cpr, seqLength, circular, offset, topBuffer, rows))
      result.fill(run.value, run.start, run.end);
    return result;
  }
}

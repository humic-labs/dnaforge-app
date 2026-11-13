import { expect, it } from 'vitest';
import {
  projectedRowBreakpoints,
  visitProjectedRowBreakpoints,
  type RowGrid,
} from './projected-row-runs';

it('never skips a lane-pattern change across local anchors, circular copies or linear ends', () => {
  for (const circular of [false, true])
    for (const topBp of [0, 47, 511])
      for (const cpr of [10, 33, 101])
        for (const futureCpr of [cpr - 2, cpr + 1, cpr + 7]) {
          const length = 1200;
          const buffer = circular ? 8 : 0;
          const realRows = Math.ceil((length - (circular ? 0 : topBp)) / cpr);
          const futureTop = circular ? (topBp + 211) % length : -3;
          const futureRealRows = Math.ceil((length - (circular ? 0 : futureTop)) / futureCpr);
          const current: RowGrid = {
            cpr,
            topBp,
            topBufferCount: buffer,
            realRowCount: realRows,
            totalRows: realRows + 2 * buffer,
            seqLength: length,
            circular,
          };
          const future: RowGrid = {
            ...current,
            cpr: futureCpr,
            topBp: futureTop,
            realRowCount: futureRealRows,
            totalRows: futureRealRows + 2 * buffer,
          };
          const starts = [0, 2, 7, 13, 22, 31, 51, 89].filter((row) => row < future.totalRows);
          for (const anchor of [null, -125, 3, 135, 260]) {
            const shift = anchor === null ? null : -3;
            const collected = new Set<number>();
            visitProjectedRowBreakpoints(current, future, starts, anchor, shift, (row) =>
              collected.add(row)
            );
            const points = [...collected].sort((a, b) => a - b);
            const patternAt = (row: number) => {
              let projected: number;
              if (anchor !== null && Math.abs(row - anchor) <= 128) projected = row - 3;
              else if (anchor === null)
                projected =
                  row < buffer + realRows
                    ? Math.min(row, buffer + futureRealRows - 1)
                    : row - realRows + futureRealRows;
              else {
                let bp = topBp + (row - buffer) * cpr - futureTop;
                if (circular && row >= buffer && row < buffer + realRows)
                  bp = ((bp % length) + length) % length;
                projected = Math.floor(bp / futureCpr) + buffer;
              }
              projected = Math.max(0, Math.min(future.totalRows - 1, projected));
              return starts.findLastIndex((start) => start <= projected);
            };
            for (let i = 0; i < points.length - 1; i++)
              for (let row = points[i]; row < points[i + 1]; row++)
                expect(
                  patternAt(row),
                  `${circular}:${topBp}:${cpr}:${futureCpr}:${anchor}:${row}`
                ).toBe(patternAt(points[i]));
          }
        }
});

it('keeps projection work bounded by lane changes on a million-row genome', () => {
  const current: RowGrid = {
    cpr: 10,
    topBp: 0,
    topBufferCount: 20,
    realRowCount: 1_000_000,
    totalRows: 1_000_040,
    seqLength: 10_000_000,
    circular: true,
  };
  const future = { ...current, cpr: 11, realRowCount: 909_091, totalRows: 909_131 };
  const points = projectedRowBreakpoints(
    current,
    future,
    [0, 20, 80, 400_000, 900_000],
    510_000,
    -1
  );
  expect(points.length).toBeLessThan(40);
  expect(points[0]).toBe(0);
  expect(points.at(-1)).toBe(current.totalRows);
});

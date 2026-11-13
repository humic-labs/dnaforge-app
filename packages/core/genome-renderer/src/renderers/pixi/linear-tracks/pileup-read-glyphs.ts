import type { PileupMismatch, PileupRecord } from '@waypoint/genome-data';

import type { WebGLThemeMode } from '../shared/theme';

export interface PileupReadDifferenceMark {
  readonly bp: number;
  readonly length: number;
  readonly row: number;
  readonly recordIndex: number;
  readonly event: PileupMismatch;
}

export function buildPileupReadDifferenceMarks(input: {
  readonly records: ReadonlyArray<PileupRecord>;
  readonly rows: Int32Array;
  readonly viewportStartBp?: number;
  readonly viewportEndBp?: number;
}): PileupReadDifferenceMark[] {
  const marks: PileupReadDifferenceMark[] = [];
  if (input.rows.length !== input.records.length) return marks;
  const viewportStartBp = input.viewportStartBp ?? Number.NEGATIVE_INFINITY;
  const viewportEndBp = input.viewportEndBp ?? Number.POSITIVE_INFINITY;

  for (let recordIndex = 0; recordIndex < input.records.length; recordIndex += 1) {
    const row = input.rows[recordIndex]!;
    if (row < 0) continue;
    const record = input.records[recordIndex]!;
    if (record.end <= viewportStartBp || record.start >= viewportEndBp) continue;

    for (const event of record.mismatches ?? []) {
      const length = Math.max(1, event.length ?? 1);
      const eventEnd = event.kind === 'del' ? event.pos + length : event.pos + 1;
      if (eventEnd <= viewportStartBp || event.pos >= viewportEndBp) continue;
      marks.push({
        bp: event.pos,
        length,
        row,
        recordIndex,
        event,
      });
    }
  }

  return marks;
}

export const PILEUP_DIFFERENCE_COLOR_BY_THEME = {
  light: [224 / 255, 68 / 255, 25 / 255],
  dark: [1, 107 / 255, 92 / 255],
} as const;

export function pileupDifferenceColor(theme: WebGLThemeMode): readonly [number, number, number] {
  return PILEUP_DIFFERENCE_COLOR_BY_THEME[theme];
}

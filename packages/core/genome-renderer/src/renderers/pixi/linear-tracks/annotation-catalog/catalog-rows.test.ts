import { describe, expect, it } from 'vitest';

import { deriveCatalogTrackData } from './catalog-derived-data';
import {
  CATALOG_TRACK_PADDING_PX,
  EMPTY_CATALOG_TRACK_HEIGHT_PX,
  assignCatalogLanes,
  awayFromBaseline,
  catalogContentHeightPx,
  fitCatalogRows,
  rowBaseY,
} from './catalog-rows';
import { catalogTrackData, tssRecord, unitRecord } from './catalog-test-fixtures';
import type { AnnotationCatalogTrackData } from './types';

function lanesById(data: AnnotationCatalogTrackData, maxRowsPerStrand = 10) {
  const assignment = assignCatalogLanes({
    derived: deriveCatalogTrackData(data),
    mode: 'stacked',
    maxRowsPerStrand,
  });
  const byId = Object.fromEntries(data.records.map((r, i) => [r.id, assignment.lanes[i]]));
  return { assignment, byId };
}

describe('assignCatalogLanes — strand-rows', () => {
  it('gives each strand present exactly one row and every record row 0', () => {
    const data = catalogTrackData({
      kind: 'tss',
      records: [tssRecord(10, '+'), tssRecord(10, '+'), tssRecord(20, '-')],
    });
    const assignment = assignCatalogLanes({
      derived: deriveCatalogTrackData(data),
      mode: 'strand-rows',
      maxRowsPerStrand: 1,
    });
    expect(assignment).toMatchObject({ forwardRows: 1, reverseRows: 1, overflowed: 0 });
    expect(Array.from(assignment.lanes)).toEqual([0, 0, 0]);
  });

  it('has no reverse row when every record is on the forward strand', () => {
    const data = catalogTrackData({ kind: 'tss', records: [tssRecord(10, '+')] });
    const assignment = assignCatalogLanes({
      derived: deriveCatalogTrackData(data),
      mode: 'strand-rows',
      maxRowsPerStrand: 1,
    });
    expect(assignment).toMatchObject({ forwardRows: 1, reverseRows: 0 });
  });
});

describe('assignCatalogLanes — stacked', () => {
  it('puts overlapping units in separate rows and lets abutting units share one', () => {
    const { assignment, byId } = lanesById(
      catalogTrackData({
        kind: 'transcription_unit',
        records: [
          unitRecord({ start: 0, end: 100 }),
          unitRecord({ start: 50, end: 150 }),
          unitRecord({ start: 100, end: 200 }),
        ],
      })
    );
    expect(byId['unit:+:0-100']).toBe(0);
    expect(byId['unit:+:50-150']).toBe(1);
    expect(byId['unit:+:100-200']).toBe(0);
    expect(assignment.forwardRows).toBe(2);
  });

  it('stacks each strand independently', () => {
    const { assignment, byId } = lanesById(
      catalogTrackData({
        kind: 'transcription_unit',
        records: [
          unitRecord({ start: 0, end: 100, strand: '+' }),
          unitRecord({ start: 0, end: 100, strand: '-' }),
          unitRecord({ start: 10, end: 90, strand: '-' }),
        ],
      })
    );
    expect(byId['unit:+:0-100']).toBe(0);
    expect(byId['unit:-:0-100']).toBe(0);
    expect(byId['unit:-:10-90']).toBe(1);
    expect(assignment).toMatchObject({ forwardRows: 1, reverseRows: 2 });
  });

  it('marks records past the row limit as overflowed instead of piling them into the last row', () => {
    const { assignment, byId } = lanesById(
      catalogTrackData({
        kind: 'transcription_unit',
        records: [
          unitRecord({ start: 0, end: 100 }),
          unitRecord({ start: 1, end: 100 }),
          unitRecord({ start: 2, end: 100 }),
        ],
      }),
      2
    );
    expect(byId['unit:+:2-100']).toBe(-1);
    expect(assignment).toMatchObject({ forwardRows: 2, overflowed: 1 });
  });

  it('assigns rows in span order even when records arrive unsorted', () => {
    const data: AnnotationCatalogTrackData = {
      ...catalogTrackData({ kind: 'transcription_unit', records: [] }),
      records: [unitRecord({ start: 100, end: 200 }), unitRecord({ start: 0, end: 100 })],
    };
    const { byId } = lanesById(data);
    expect(byId['unit:+:0-100']).toBe(0);
    expect(byId['unit:+:100-200']).toBe(0);
  });
});

describe('row layout', () => {
  it('measures empty tracks at a readable minimum and others by rows plus padding', () => {
    expect(catalogContentHeightPx(0, 16)).toBe(EMPTY_CATALOG_TRACK_HEIGHT_PX);
    expect(catalogContentHeightPx(3, 12)).toBe(36 + 2 * CATALOG_TRACK_PADDING_PX);
  });

  it('places the baseline under the forward rows', () => {
    const layout = fitCatalogRows({
      forwardRows: 2,
      reverseRows: 1,
      preferredRowHeightPx: 12,
      heightPx: 200,
    });
    expect(layout).toEqual({
      rowHeightPx: 12,
      forwardRows: 2,
      reverseRows: 1,
      baselineYPx: CATALOG_TRACK_PADDING_PX + 24,
    });
  });

  it('shrinks rows evenly when the slot is shorter than the content', () => {
    const layout = fitCatalogRows({
      forwardRows: 2,
      reverseRows: 2,
      preferredRowHeightPx: 20,
      heightPx: 44,
    });
    expect(layout.rowHeightPx).toBe(10);
    expect(layout.baselineYPx + 2 * layout.rowHeightPx).toBe(44 - CATALOG_TRACK_PADDING_PX);
  });

  it('grows forward rows up and reverse rows down from the baseline', () => {
    const layout = fitCatalogRows({
      forwardRows: 2,
      reverseRows: 2,
      preferredRowHeightPx: 10,
      heightPx: 100,
    });
    expect(awayFromBaseline(true)).toBe(-1);
    expect(awayFromBaseline(false)).toBe(1);
    expect(rowBaseY(layout, -1, 1)).toBe(layout.baselineYPx - 10);
    expect(rowBaseY(layout, 1, 1)).toBe(layout.baselineYPx + 10);
  });
});

import { describe, expect, it } from 'vitest';
import {
  overflowExactSourceDomain,
  overflowGeometryWindow,
  overflowMeshKey,
  overflowRowsHavePaintableSource,
} from './pileup-overflow-geometry';

describe('overflowRowsHavePaintableSource', () => {
  it('requires hidden reads, height, and a field or matching records', () => {
    expect(
      overflowRowsHavePaintableSource({
        hasField: false,
        hasRecords: false,
        hasRows: false,
        recordCount: 0,
        rowCount: 0,
        hiddenReadCount: 4,
        overflowHeightPx: 8,
      })
    ).toBe(false);
    expect(
      overflowRowsHavePaintableSource({
        hasField: true,
        hasRecords: false,
        hasRows: false,
        recordCount: 0,
        rowCount: 0,
        hiddenReadCount: 4,
        overflowHeightPx: 8,
      })
    ).toBe(true);
    expect(
      overflowRowsHavePaintableSource({
        hasField: false,
        hasRecords: true,
        hasRows: true,
        recordCount: 3,
        rowCount: 3,
        hiddenReadCount: 4,
        overflowHeightPx: 8,
      })
    ).toBe(true);
  });
});

describe('overflowExactSourceDomain / overflowGeometryWindow / overflowMeshKey', () => {
  it('prefers the published read window over loaded extents', () => {
    expect(
      overflowExactSourceDomain({
        hasField: false,
        records: { length: 2 },
        rows: { length: 2 },
        readSourceWindowStartBp: 10,
        readSourceWindowEndBp: 40,
        loadedStartBp: 0,
        loadedEndBp: 100,
      })
    ).toEqual({
      exactSourceStartBp: 10,
      exactSourceEndBp: 40,
      hasExactSourceDomain: true,
    });
  });

  it('keeps field geometry when a collapsed field is present', () => {
    expect(
      overflowGeometryWindow({
        field: { startBp: 100, endBp: 200, hiddenCounts: { length: 50 } },
        hasExactSourceDomain: true,
        exactSourceStartBp: 0,
        exactSourceEndBp: 1000,
        viewStart: 120,
        viewEnd: 180,
        maxColumnBars: 4096,
        cameraColumnCount: 200,
      })
    ).toEqual({
      columnCount: 50,
      geometryStartBp: 100,
      geometryEndBp: 200,
      columnBp: 2,
    });
  });

  it('uses a resident key when a field or exact domain owns the mesh', () => {
    expect(
      overflowMeshKey({
        field: {
          startBp: 0,
          endBp: 10,
          binSizeBp: 1,
          hiddenCounts: { length: 10 },
          maxHiddenCount: 4,
        },
        hasExactSourceDomain: false,
        viewStart: 1,
        viewEnd: 9,
        columnCount: 10,
        overflowHeightPx: 8.4,
        recordsKey: 'r1',
        hiddenReadCount: 4,
        morphBucket: 0,
        themedReadColor: 1,
      })
    ).toContain('resident:10:8:');
  });
});

import { describe, expect, it } from 'vitest';
import { createCoordMapping, makeMappingPoint, type CoordMappingRow } from './coord-mapping';
import { LinkedCoordinateRegistry } from './LinkedCoordinateRegistry';
import type { JunctionWorkbenchRow } from './model';

describe('LinkedCoordinateRegistry', () => {
  it('enforces one registered coordinate axis for every linked row', () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const registry = new LinkedCoordinateRegistry(rows, mapping);

    expect(registry.axis).toEqual({
      startBioCol: -40,
      endBioCol: 40,
      length: 80,
      anchorRowPosition: 40,
    });
    expect(registry.screenXForBioCol(0, 10)).toBe(408);
    expect(registry.bioColForScreenX(408, 10)).toBe(0);
    expect(registry.totalWidth(10)).toBe(816);
  });

  it('rejects rows that drift off the registered axis', () => {
    const rows = makeRows();
    rows[2] = { ...rows[2], anchorRowPosition: 39 };
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });

    expect(() => new LinkedCoordinateRegistry(rows, mapping)).toThrow(/does not match row start/);
  });

  it('registers buffered source rows against a shorter product row by bioCol', () => {
    const rows = [
      row('left', 'left-source', 50, 100),
      row('product', 'product', 40, 80),
      row('right', 'right-source', 50, 100),
    ];
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const registry = new LinkedCoordinateRegistry(rows, mapping);

    expect(registry.axis).toEqual({
      startBioCol: -50,
      endBioCol: 50,
      length: 100,
      anchorRowPosition: 50,
    });
    expect(registry.screenXForBioColInRow('product', 0, 10)).toBe(408);
    expect(registry.screenXForBioColInRow('left', 0, 10)).toBe(508);
    expect(registry.scrollLeftForRow('product', 1000, 10)).toBe(900);
    expect(registry.scrollLeftForRow('left', 1000, 10)).toBe(1000);
  });
});

function makeRows(): JunctionWorkbenchRow[] {
  return [
    row('left', 'left-source', 40),
    row('product', 'product', 40),
    row('right', 'right-source', 40),
  ];
}

function row(
  id: string,
  kind: CoordMappingRow['kind'],
  anchorRowPosition: number,
  length = 80
): JunctionWorkbenchRow {
  const sequence = 'A'.repeat(length);
  return {
    id,
    kind,
    label: id,
    sequence,
    coordinateStart: 0,
    anchorRowPosition,
    annotations: [],
    points: Array.from({ length: sequence.length }, (_, rowPosition) =>
      makeMappingPoint(id, rowPosition, rowPosition - anchorRowPosition, rowPosition, 'valid')
    ),
  };
}

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  assertBijectionInvariant,
  createCoordMapping,
  fromScreen,
  makeMappingPoint,
  toScreen,
  type CoordMappingStrategyName,
} from './index';
import * as coordMapping from './index';
import type { CoordMappingRow } from './types';

const STRATEGIES: CoordMappingStrategyName[] = ['gibson', 'nebuilder', 'goldengate'];

describe('junction workbench coord mapping', () => {
  it.each(STRATEGIES)('preserves bijection invariant for %s strategy', (strategy) => {
    const mapping = createCoordMapping(strategy, {
      maxWindowBp: 20,
      rows: makeRows(strategy),
    });

    expect(() => assertBijectionInvariant(mapping)).not.toThrow();

    for (const row of mapping.rows) {
      for (const point of row.points) {
        const screen = toScreen(mapping, row.id, point.rowPosition, 1);
        if (point.kind === 'gap' || point.kind === 'unavailable') {
          expect(screen).toBeNull();
          continue;
        }
        expect(screen).not.toBeNull();
        expect(fromScreen(mapping, row.id, screen!, 1)).toMatchObject({
          rowId: row.id,
          rowPosition: point.rowPosition,
          bioCol: point.bioCol,
        });
      }
    }
  });

  it('keeps gap and unavailable positions first-class instead of mapping them to zero', () => {
    const mapping = createCoordMapping('gibson', {
      maxWindowBp: 10,
      rows: [
        row('source', [
          makeMappingPoint('source', 0, -2, null, 'gap'),
          makeMappingPoint('source', 1, -1, null, 'unavailable'),
          makeMappingPoint('source', 2, 0, 10, 'valid'),
        ]),
      ],
    });

    expect(toScreen(mapping, 'source', 0)).toBeNull();
    expect(toScreen(mapping, 'source', 1)).toBeNull();
    expect(toScreen(mapping, 'source', 2)).toBeGreaterThan(0);
  });

  it('allows many source positions to share product context while row positions stay unique', () => {
    const mapping = createCoordMapping('gibson', {
      maxWindowBp: 10,
      rows: [
        row('source', [
          makeMappingPoint('source', 0, -1, 4, 'many-to-one'),
          makeMappingPoint('source', 1, 0, 4, 'many-to-one'),
        ]),
      ],
    });

    expect(fromScreen(mapping, 'source', toScreen(mapping, 'source', 0)!, 1)).toMatchObject({
      rowPosition: 0,
      productPosition: 4,
    });
    expect(fromScreen(mapping, 'source', toScreen(mapping, 'source', 1)!, 1)).toMatchObject({
      rowPosition: 1,
      productPosition: 4,
    });
  });

  it('does not export a parallel bio-column mapping API', () => {
    expect(coordMapping).not.toHaveProperty('bioColToScreenX');
    expect(coordMapping).not.toHaveProperty('screenXToBioCol');
    expect(typeof coordMapping.toScreen).toBe('function');
    expect(typeof coordMapping.fromScreen).toBe('function');
  });
});

function makeRows(strategy: CoordMappingStrategyName): CoordMappingRow[] {
  const constrainedKind = strategy === 'goldengate' ? 'constrained-end' : 'valid';
  return [
    row('left', [
      makeMappingPoint('left', 0, -3, 7, constrainedKind),
      makeMappingPoint('left', 1, -2, 8, 'many-to-one'),
      makeMappingPoint('left', 2, -1, 9, 'many-to-one'),
    ]),
    row('product', [
      makeMappingPoint('product', 0, -2, 8, 'valid'),
      makeMappingPoint('product', 1, -1, 9, strategy === 'goldengate' ? 'generated-tail' : 'valid'),
      makeMappingPoint('product', 2, 0, 10, 'valid'),
      makeMappingPoint('product', 3, 1, 11, strategy === 'nebuilder' ? 'gap' : 'valid'),
    ]),
    row('right', [
      makeMappingPoint('right', 0, 0, 10, 'many-to-one'),
      makeMappingPoint('right', 1, 1, 11, 'many-to-one'),
      makeMappingPoint('right', 2, 2, null, strategy === 'nebuilder' ? 'unavailable' : 'valid'),
    ]),
  ];
}

function row(id: string, points: CoordMappingRow['points']): CoordMappingRow {
  return {
    id,
    kind: id === 'product' ? 'product' : id === 'left' ? 'left-source' : 'right-source',
    label: id,
    sequence: 'ACGTACGTACGT',
    coordinateStart: 0,
    anchorRowPosition: id === 'right' ? 0 : 2,
    points,
  };
}

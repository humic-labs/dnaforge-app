import { describe, expect, it } from 'vitest';
import {
  assertContactProjection,
  contactCellRect,
  contactPlotRect,
  contactPointToLoci,
  hitTestContactCell,
  panContactCamera,
  resolveContactCamera,
  zoomContactCamera,
  type ContactProjection,
} from './contact-projection';

const length = 4_639_675;
const reference = Object.freeze({ id: 'U00096.2', chrom: 'U00096.2', length });
const projection: ContactProjection = Object.freeze<ContactProjection>({
  kind: 'contact-matrix',
  id: 'GSM2870426-100kb',
  xReference: reference,
  yReference: reference,
  cells: Object.freeze([
    Object.freeze({
      id: 'contact-0-0',
      start: 0,
      end: 100_000,
      targetStart: 0,
      targetEnd: 100_000,
      value: 25_020,
    }),
    Object.freeze({
      id: 'contact-46-46',
      start: 4_600_000,
      end: length,
      targetStart: 4_600_000,
      targetEnd: length,
      value: 5_508,
    }),
  ]),
  colorScale: {
    kind: 'continuous',
    domain: [224, 42_536],
    colors: ['#ffffff', '#b2182b'],
    missingColor: '#808080',
    transform: 'linear',
  },
});

describe('contact projection', () => {
  const rect = contactPlotRect(1_092, 584);

  it('keeps both exact reference axes and published counts in a contact hit', () => {
    assertContactProjection(projection);
    const camera = resolveContactCamera(projection);
    const cellRect = contactCellRect(projection.cells[0], camera, rect)!;
    const hit = hitTestContactCell(
      projection,
      camera,
      rect,
      cellRect.x + cellRect.width / 2,
      cellRect.y + cellRect.height / 2
    );
    expect(hit).toEqual({
      projectionId: projection.id,
      cellId: 'contact-0-0',
      x: { referenceId: 'U00096.2', chrom: 'U00096.2', start: 0, end: 100_000 },
      y: { referenceId: 'U00096.2', chrom: 'U00096.2', start: 0, end: 100_000 },
      value: 25_020,
    });
    expect(projection.cells[0].value).toBe(25_020);
  });

  it('draws and selects the shorter final 47th bin without stretching it to 100 kb', () => {
    const camera = resolveContactCamera(projection);
    const cell = projection.cells[1];
    const painted = contactCellRect(cell, camera, rect)!;
    expect(painted.width).toBeCloseTo((39_675 / length) * rect.width);
    expect(painted.height).toBeCloseTo((39_675 / length) * rect.height);
    expect(painted.x + painted.width).toBeCloseTo(rect.x + rect.width);
    expect(painted.y + painted.height).toBeCloseTo(rect.y + rect.height);
    expect(
      hitTestContactCell(
        projection,
        camera,
        rect,
        painted.x + painted.width / 2,
        painted.y + painted.height / 2
      )
    ).toMatchObject({ cellId: cell.id, x: { end: length }, y: { end: length }, value: 5_508 });
    expect(hitTestContactCell(projection, camera, rect, rect.x + rect.width, rect.y)).toBeNull();
    expect(hitTestContactCell(projection, camera, rect, rect.x, rect.y + rect.height)).toBeNull();
  });

  it('zooms both genomic axes around the pointer and pans them independently', () => {
    const anchor = { x: rect.x + rect.width / 4, y: rect.y + (rect.height * 3) / 4 };
    const original = resolveContactCamera(projection);
    const before = contactPointToLoci(projection, original, rect, anchor.x, anchor.y);
    const zoomed = zoomContactCamera(projection, original, 4, anchor.x, anchor.y, rect);
    const after = contactPointToLoci(projection, zoomed, rect, anchor.x, anchor.y);
    expect(after?.x).toBeCloseTo(before!.x);
    expect(after?.y).toBeCloseTo(before!.y);
    expect(zoomed.xEnd - zoomed.xStart).toBe(length / 4);
    expect(zoomed.yEnd - zoomed.yStart).toBe(length / 4);
    const panX = panContactCamera(projection, zoomed, rect.width / 4, 0, rect);
    expect(panX.xStart).toBeCloseTo(zoomed.xStart + length / 16);
    expect(panX.yStart).toBe(zoomed.yStart);
    const panY = panContactCamera(projection, panX, 0, -rect.height / 4, rect);
    expect(panY.xStart).toBe(panX.xStart);
    expect(panY.yStart).toBeCloseTo(panX.yStart - length / 16);
    expect(original).toMatchObject({ xStart: 0, xEnd: length, yStart: 0, yEnd: length });
  });

  it('preserves distinct X/Y reference identities and chromosome lengths', () => {
    const alternate: ContactProjection = {
      ...projection,
      yReference: { id: 'different-assembly', chrom: 'chr-other', length: 200_000 },
      cells: [projection.cells[0]],
    };
    assertContactProjection(alternate);
    expect(resolveContactCamera(alternate)).toMatchObject({ xEnd: length, yEnd: 200_000 });
    const hit = hitTestContactCell(alternate, null, rect, rect.x + 1, rect.y + 1);
    expect(hit?.x.referenceId).toBe('U00096.2');
    expect(hit?.y).toEqual({
      referenceId: 'different-assembly',
      chrom: 'chr-other',
      start: 0,
      end: 100_000,
    });
  });

  it('bounds camera movement, discards stale projection cameras, and clips painted cells', () => {
    const camera = resolveContactCamera(projection, {
      projectionId: projection.id,
      xStart: -100,
      xEnd: 99_900,
      yStart: length - 100,
      yEnd: length + 99_900,
    });
    expect(camera).toMatchObject({
      xStart: 0,
      xEnd: 100_000,
      yStart: length - 100_000,
      yEnd: length,
    });
    const reset = resolveContactCamera(projection, { ...camera, projectionId: 'older-source' });
    expect(reset).toMatchObject({ xStart: 0, xEnd: length, yStart: 0, yEnd: length });
    const clipped = contactCellRect(
      projection.cells[0],
      { ...camera, xStart: 50_000, xEnd: 150_000, yStart: 25_000, yEnd: 125_000 },
      rect
    );
    expect(clipped).toEqual({
      x: rect.x,
      y: rect.y,
      width: rect.width / 2,
      height: rect.height * 0.75,
    });
    expect(contactCellRect(projection.cells[1], camera, rect)).toBeNull();
  });

  it('fails on invalid source counts and interval bounds', () => {
    expect(() =>
      assertContactProjection({ ...projection, cells: [{ ...projection.cells[0], value: NaN }] })
    ).toThrow('finite and nonnegative');
    expect(() =>
      assertContactProjection({
        ...projection,
        cells: [{ ...projection.cells[0], end: length + 1 }],
      })
    ).toThrow('outside its axis reference');
    expect(() =>
      assertContactProjection({ ...projection, cells: [projection.cells[0], projection.cells[0]] })
    ).toThrow('unique identities');
  });

  it('returns no hit for empty plot space, nonfinite points, or absent cells', () => {
    expect(contactPlotRect(40, 20)).toEqual({ x: 40, y: 20, width: 0, height: 0 });
    expect(contactPointToLoci(projection, null, contactPlotRect(40, 20), 1, 1)).toBeNull();
    expect(contactPointToLoci(projection, null, rect, NaN, rect.y)).toBeNull();
    expect(hitTestContactCell(projection, null, rect, rect.x + rect.width / 2, rect.y)).toBeNull();
  });
});

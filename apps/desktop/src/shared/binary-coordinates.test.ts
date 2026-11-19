import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isBinaryCoordinateText,
  binaryCoordinateBytes,
  binaryCoordinateText,
  coordinateStructureData,
  textCoordinates,
} from './binary-coordinates';

const BCIF = new Uint8Array(
  readFileSync(resolve(__dirname, '../../../../test-fixtures/structure-complexes/rcsb/1FS0.bcif'))
);

describe('binary coordinates in molecular views ', () => {
  it('round-trips the exact bytes of a real binary CIF through base64 text', () => {
    const text = binaryCoordinateText(BCIF);
    expect(isBinaryCoordinateText(text)).toBe(true);
    expect(binaryCoordinateBytes(text)).toEqual(BCIF);
    const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(binaryCoordinateBytes(binaryCoordinateText(everyByte))).toEqual(everyByte);
  });

  it('hands the viewer bytes for binary CIF and text otherwise', () => {
    const text = binaryCoordinateText(BCIF);
    expect(coordinateStructureData({ format: 'bcif', text })).toEqual(BCIF);
    expect(coordinateStructureData({ format: 'pdb', text: 'ATOM' })).toBe('ATOM');
  });

  it('refuses binary CIF where a feature needs text coordinates', () => {
    expect(textCoordinates({ format: 'cif', text: 'data_x' })).toEqual({
      format: 'cif',
      text: 'data_x',
    });
    expect(() => textCoordinates({ format: 'bcif', text: 'AAAA' })).toThrow(/binary CIF/);
  });
});

import { describe, expect, it } from 'vitest';
import { isBinaryCoordinateText } from './binary-coordinates';
import {
  molecularDocumentStorageStatus,
  packMolecularDocument,
  packedMolecularDocumentByteLength,
  serializeMolecularDocument,
  unpackMolecularDocument,
} from './molecular-document';
import {
  assertMolecularCoordinateSize,
  assertMolecularDocumentSize,
  jsonStringByteLength,
  MOLECULAR_COORDINATE_MAX_BYTES,
  MOLECULAR_COORDINATE_MAX_ENCODED_LENGTH,
  MOLECULAR_DOCUMENT_MAX_BYTES,
} from './molecular-storage';
import { molecularDocumentFixture } from '../test/fixtures/molecular-documents';

describe('molecular storage limits', () => {
  it('counts raw UTF-8 and decoded BinaryCIF bytes at the inclusive source limit', () => {
    const text = 'x'.repeat(MOLECULAR_COORDINATE_MAX_BYTES - 2) + 'é';
    expect(() => assertMolecularCoordinateSize({ format: 'cif', text })).not.toThrow();
    expect(() => assertMolecularCoordinateSize({ format: 'cif', text: text + '\n' })).toThrow(
      /64 MiB/
    );

    const encoded = 'A'.repeat(MOLECULAR_COORDINATE_MAX_ENCODED_LENGTH - 2);
    expect(isBinaryCoordinateText(encoded + '==')).toBe(true);
    expect(isBinaryCoordinateText('AAA\n')).toBe(false);
    expect(() =>
      assertMolecularCoordinateSize({ format: 'bcif', text: encoded + '==' })
    ).not.toThrow();
    expect(() => assertMolecularCoordinateSize({ format: 'bcif', text: encoded + 'A=' })).toThrow(
      /64 MiB/
    );
  });

  it('rejects two individually eligible assets that exhaust the serialized file budget', () => {
    expect(() => assertMolecularDocumentSize(MOLECULAR_DOCUMENT_MAX_BYTES)).not.toThrow();
    expect(() => assertMolecularDocumentSize(MOLECULAR_DOCUMENT_MAX_BYTES + 1)).toThrow(/128 MiB/);
    const text = 'x'.repeat(MOLECULAR_COORDINATE_MAX_BYTES - 1);
    const assets = [
      { format: 'cif' as const, text: text + '\n' },
      { format: 'cif' as const, text: text + '\r' },
    ];
    expect(molecularDocumentStorageStatus(assets.slice(0, 1))).toMatchObject({
      status: 'available',
    });
    expect(molecularDocumentStorageStatus(assets)).toMatchObject({
      status: 'over-limit',
      code: 'MVS_DOCUMENT_TOO_LARGE',
    });
  }, 10_000);

  it('measures actual JSON escapes and pools the same text across saved revisions', async () => {
    const difficultText = 'x'.repeat(65_535) + '🧪\r\n\"\\\u0000é\ud800';
    expect(jsonStringByteLength(difficultText)).toBe(
      new TextEncoder().encode(JSON.stringify(difficultText)).length
    );
    const document = await molecularDocumentFixture();
    const stored = packMolecularDocument(document);
    expect(Object.keys(stored.coordinateAssets)).toHaveLength(1);
    expect(unpackMolecularDocument(stored)).toEqual(document);
    const bytes = new TextEncoder().encode(serializeMolecularDocument(document)).length;
    expect(packedMolecularDocumentByteLength(stored)).toBe(bytes);
    expect(
      molecularDocumentStorageStatus([document.history[0].snapshot.coordinates], document)
    ).toMatchObject({ status: 'available', minimumDocumentBytes: bytes });
  });
});

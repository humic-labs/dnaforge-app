import { expect, it, vi } from 'vitest';
import {
  openRangeReadablePrepackedAnnotationSearchIndexV1,
  packPrepackedAnnotationSearchIndexV1,
} from './prepacked-annotation-search-index-v1';

it('starts both annotation search directories together and drains them before rejecting', async () => {
  const packed = await packPrepackedAnnotationSearchIndexV1({
    datasetContract: { datasetId: 'test', datasetVersion: 'v1', sourceSha256: 'a'.repeat(64) },
    assemblyContract: {
      assemblyId: 'test',
      assemblyLengthBp: 1000,
      placementSignature: 'chr1:1000',
      sourceFingerprint: 'b'.repeat(24),
    },
    trackType: 'mRNA',
    features: [
      {
        type: 'mRNA',
        annotationTrackId: 'mRNA',
        canonicalIdentity: 'annotation.v2:test',
        direction: 'forward',
        displayName: 'BRCA1',
        qualifiers: {},
        attributes: {},
        start: 1,
        end: 20,
      },
    ],
  });
  let rejectKeys!: (error: Error) => void;
  let resolveOffsets!: (bytes: Uint8Array) => void;
  const keys = new Promise<Uint8Array>((_, reject) => {
    rejectKeys = reject;
  });
  const offsets = new Promise<Uint8Array>((resolve) => {
    resolveOffsets = resolve;
  });
  let finished = false;
  const read = vi.fn(async (offset: number, length: number) => {
    if (offset === packed.manifest.sections.gramKeys.byteOffset) return keys;
    if (offset === packed.manifest.sections.postingOffsets.byteOffset) return offsets;
    return packed.payload.slice(offset, offset + length);
  });
  const opened = openRangeReadablePrepackedAnnotationSearchIndexV1(packed.manifest, {
    byteLength: packed.payload.byteLength,
    read,
  });
  const error = new Error('keys unavailable');
  const rejected = expect(opened).rejects.toBe(error);
  void opened.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    }
  );
  await vi.waitFor(() =>
    expect(
      read.mock.calls.some(
        ([offset]) => offset === packed.manifest.sections.postingOffsets.byteOffset
      )
    ).toBe(true)
  );
  rejectKeys(error);
  await Promise.resolve();
  expect(finished).toBe(false);
  resolveOffsets(new Uint8Array(packed.manifest.sections.postingOffsets.byteLength));
  await rejected;
});

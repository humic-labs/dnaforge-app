import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sequenceDataLayerTargetFromBytes } from './sequence-data-layer-target';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  fingerprintSequenceDataLayerAnnotations,
  sequenceDataLayerAnnotationCandidates,
} from '../shared/sequence-data-layer-annotations';

describe('native data layer target decoding', () => {
  it('reads the existing GenBank target as text and retains stable annotation joins', async () => {
    const path = resolve('../../test-fixtures/genome-view-prototypes/MG1655-rut-locus.gb');
    const target = await sequenceDataLayerTargetFromBytes(
      'existing-managed-sequence',
      path,
      await readFile(path)
    );
    expect(target).toMatchObject({
      documentId: 'existing-managed-sequence',
      length: 17000,
      sequenceFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      annotationFingerprint: expect.stringMatching(/^annotation-mapping-v1:sha256:[a-f0-9]{64}$/),
    });
    expect(target.annotations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'b1007', start0: 2859, end0: 3354 })])
    );
  });

  it('reads FASTA text bytes without requiring an indexed reference', async () => {
    const target = await sequenceDataLayerTargetFromBytes(
      'saved-fasta',
      '/project/sequence.fa',
      new TextEncoder().encode('>sequence\nacgtACGT\n')
    );
    expect(target).toMatchObject({ documentId: 'saved-fasta', length: 8 });
  });

  it('preserves mapping fingerprints when an imported sequence is promoted into its managed package', async () => {
    const path = resolve('../../test-fixtures/genome-view-prototypes/MG1655-rut-locus.gb');
    const bytes = await readFile(path);
    const imported = await sequenceDataLayerTargetFromBytes(
      'saved-sequence',
      '/project/Existing MG1655 rut locus.gb',
      bytes
    );
    const promoted = await sequenceDataLayerTargetFromBytes(
      'saved-sequence',
      '/project/Existing MG1655 rut locus/Existing MG1655 rut locus.gb',
      bytes
    );
    expect(promoted.annotationFingerprint).toBe(imported.annotationFingerprint);
    expect(promoted.annotations).toEqual(imported.annotations);
  });

  it('agrees with the shared annotation mapping fingerprint used by the viewer', async () => {
    const path = resolve('../../test-fixtures/genome-view-prototypes/MG1655-rut-locus.gb');
    const bytes = await readFile(path);
    const original = await sequenceDataLayerTargetFromBytes('saved-sequence', path, bytes);
    const loaded = parseSequenceFileAsDocument(bytes.toString('utf8'), path).sequence;
    expect(original.annotationFingerprint).toBe(
      await fingerprintSequenceDataLayerAnnotations(sequenceDataLayerAnnotationCandidates(loaded))
    );
  });
});

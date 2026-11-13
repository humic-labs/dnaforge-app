import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  decodeSequenceDocument,
  getSequenceDocumentMetadata,
  getSequenceSavePolicy,
  parseSequenceFileSingle,
  sequenceFormatFromFilename,
  serializeSequenceForInPlaceSave,
} from './index';

function fixturePath(relativePath: string): string {
  return (
    [
      resolve(process.cwd(), relativePath),
      resolve(process.cwd(), '../..', relativePath),
      resolve(process.cwd(), '../../..', relativePath),
    ].find((candidate) => existsSync(candidate)) ?? relativePath
  );
}

describe('SequenceDocument decoder', () => {
  it('recognizes every registered GenBank filename extension', () => {
    expect(
      ['design.gb', 'design.gbk', 'design.gbff', 'design.genbank'].map((filename) =>
        sequenceFormatFromFilename(filename)
      )
    ).toEqual(['genbank', 'genbank', 'genbank', 'genbank']);
  });

  it('decodes GenBank into AnnotatedSequence with source/save metadata', () => {
    const content = readFileSync(fixturePath('test-fixtures/sequences/circular/pUC19.gb'), 'utf8');

    const doc = decodeSequenceDocument(content, {
      path: '/workspace/pUC19.gb',
      filename: 'pUC19.gb',
      contentHash: 'sha256:test',
    });

    expect(doc.format).toBe('genbank');
    expect(doc.source).toEqual({
      path: '/workspace/pUC19.gb',
      filename: 'pUC19.gb',
      contentHash: 'sha256:test',
      binary: false,
    });
    expect(doc.capabilities.canSaveInPlace).toBe(true);
    expect(doc.sequence.id).toBe('/workspace/pUC19.gb');
    expect(doc.sequence.circular).toBe(true);
    expect(doc.sequence.annotations.length).toBeGreaterThan(0);
    expect(getSequenceDocumentMetadata(doc.sequence)?.format).toBe('genbank');
    expect(serializeSequenceForInPlaceSave(doc.sequence, doc.source.filename)).toContain('LOCUS');
  });

  it('rejects GenBank documents that declare a record but contain no sequence', () => {
    const content = `LOCUS       EMPTY_RECORD              12 bp    DNA     linear   SYN 01-JAN-2026
DEFINITION  Inert malformed GenBank fixture with no ORIGIN sequence.
//`;

    expect(() =>
      decodeSequenceDocument(content, {
        path: '/workspace/empty-record.gb',
        filename: 'empty-record.gb',
      })
    ).toThrow('No sequence found in GenBank file');
  });

  it('round-trips an explicitly declared zero-base GenBank document', () => {
    const content = serializeSequenceForInPlaceSave(
      {
        id: 'empty-sequence',
        name: 'Empty sequence',
        sequence: '',
        length: 0,
        circular: false,
        annotations: [],
      },
      'empty-sequence.gb'
    );

    const doc = decodeSequenceDocument(content, {
      path: '/workspace/Empty sequence/Empty sequence.gb',
      filename: 'Empty sequence.gb',
    });

    expect(doc.sequence).toMatchObject({
      name: 'Empty sequence',
      sequence: '',
      length: 0,
      circular: false,
      annotations: [],
    });
  });

  it('decodes SnapGene into the same AnnotatedSequence model but disables in-place save', () => {
    const bytes = readFileSync(fixturePath('test-fixtures/sequences/snapgene/sample-f.dna'));

    const doc = decodeSequenceDocument(bytes, {
      path: '/workspace/sample-f.dna',
      filename: 'sample-f.dna',
    });

    expect(doc.format).toBe('snapgene');
    expect(doc.capabilities.canSaveInPlace).toBe(false);
    expect(doc.capabilities.canExportGenBank).toBe(true);
    expect(doc.sequence.id).toBe('/workspace/sample-f.dna');
    expect(doc.sequence.name).toBe('Sample');
    expect(doc.sequence.circular).toBe(true);
    expect(doc.sequence.annotations.map((ann) => ann.name)).toEqual(
      expect.arrayContaining(['FeatureA', 'FeatureB', 'Primer 1'])
    );
    expect(getSequenceSavePolicy(doc.sequence, 'sample-f.dna').format).toBe('snapgene');
    expect(() => serializeSequenceForInPlaceSave(doc.sequence, 'sample-f.dna')).toThrow(
      /does not write SnapGene binaries/
    );
  });

  it('keeps GenBank annotations on the legacy ParsedSequence metadata path', () => {
    const content = `LOCUS       MINI                     12 bp    DNA     linear   SYN 01-JAN-2026
DEFINITION  Mini annotated record.
FEATURES             Location/Qualifiers
     promoter        1..4
                     /label="T7 promoter"
ORIGIN
        1 atgcatgcatgc
//`;

    const parsed = parseSequenceFileSingle(content, { filename: 'mini.gb' });
    const metadata = parsed.metadata as { annotations?: unknown[]; circular?: boolean };

    expect(parsed.format).toBe('genbank');
    expect(metadata.annotations).toEqual([
      expect.objectContaining({
        name: 'T7 promoter',
        type: 'promoter',
        start: 1,
        end: 4,
      }),
    ]);
    expect(metadata.circular).toBe(false);
  });
});

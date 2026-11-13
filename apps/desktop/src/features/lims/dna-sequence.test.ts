import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { computeChecksum, updateGenBankGeneticCodeComment } from '@waypoint/sequence-utils';
import {
  buildInlineDnaSequenceRef,
  buildFileDnaSequenceRef,
  buildFileDnaSequenceSnapshot,
  resolveDnaSequence,
} from './dna-sequence';
import { normalizeInlineDnaSequenceRef, type FileDnaSequenceRef } from '../../shared/lims';

const mocks = vi.hoisted(() => ({
  fs: {
    exists: vi.fn(),
    readFile: vi.fn(),
    readTextFile: vi.fn(),
    stat: vi.fn(),
  },
  ensureSequenceIdentity: vi.fn(),
  assertCanonicalSequenceSource: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: mocks.fs,
    db: { assertCanonicalSequenceSource: mocks.assertCanonicalSequenceSource },
  }),
}));

vi.mock('../../db/sequence-identity', () => ({
  ensureSequenceIdentity: mocks.ensureSequenceIdentity,
}));

describe('LIMS dna_sequence resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSequenceIdentity.mockResolvedValue(42);
  });

  it('keeps inline primer base case during preparation and resolution', async () => {
    const bases = 'acGTacGTac';
    const ref = await buildInlineDnaSequenceRef('acGT acGT\nac');
    expect(ref.bases).toBe(bases);
    expect(ref.contentHash).toBe(await computeChecksum(bases));
    expect(normalizeInlineDnaSequenceRef('acGT acGT\nac').bases).toBe(bases);
    const resolved = await resolveDnaSequence(ref);
    expect(resolved).toMatchObject({ status: 'loaded', bases, length: 10 });
  });

  it('returns a missing state without reading a missing file', async () => {
    mocks.fs.exists.mockResolvedValue(false);
    const ref = fileRef({ relPath: '/workspace/missing.fa', length: 17 });

    const resolved = await resolveDnaSequence(ref);

    expect(resolved).toMatchObject({
      status: 'missing',
      length: 17,
      topology: 'linear',
    });
    expect(mocks.fs.readTextFile).not.toHaveBeenCalled();
    expect(mocks.ensureSequenceIdentity).not.toHaveBeenCalled();
  });

  it('marks file-backed sequence refs drifted when file content hash changes', async () => {
    const original = '>p1\nATGC\n';
    const modified = '>p1\nATGCG\n';
    mocks.fs.exists.mockResolvedValue(true);
    mocks.fs.readTextFile.mockResolvedValue(modified);

    const resolved = await resolveDnaSequence(
      fileRef({
        documentId: 'sequence-p1',
        relPath: '/workspace/p1.fa',
        length: 4,
        contentHash: await computeChecksum(original),
      })
    );

    expect(resolved.status).toBe('drifted');
    if (resolved.status !== 'drifted') throw new Error(`Expected drifted, got ${resolved.status}`);
    expect(resolved.bases).toBe('ATGCG');
    expect(resolved.length).toBe(5);
    expect(mocks.ensureSequenceIdentity).toHaveBeenCalledWith(
      'sequence-p1',
      '/workspace/p1.fa',
      'p1',
      5,
      false
    );
  });

  it('builds file refs with cached identity, size, mtime, topology, and content hash', async () => {
    const genbank = [
      'LOCUS       plasmid                 4 bp    DNA     circular SYN 01-JAN-2000',
      'FEATURES             Location/Qualifiers',
      'ORIGIN',
      '        1 atgc',
      '//',
      '',
    ].join('\n');
    mocks.fs.stat.mockResolvedValue({ size: genbank.length, mtime: 1234 });
    mocks.fs.readTextFile.mockResolvedValue(genbank);
    mocks.ensureSequenceIdentity.mockResolvedValue(77);

    const ref = await buildFileDnaSequenceRef('/workspace/plasmid.gb', {
      documentId: 'sequence-plasmid',
    });

    expect(ref).toMatchObject({
      mode: 'file',
      relPath: '/workspace/plasmid.gb',
      topology: 'circular',
      length: 4,
      sourceFormat: 'gb',
      sequenceId: 77,
      sizeBytes: genbank.length,
      modifiedAt: 1234,
    });
    expect(ref.contentHash).toBe(await computeChecksum(genbank));
    expect(mocks.ensureSequenceIdentity).toHaveBeenCalledWith(
      'sequence-plasmid',
      '/workspace/plasmid.gb',
      'plasmid',
      4,
      true
    );
  });

  it('returns parsed bases and stable identity from one file read', async () => {
    const fasta = '>target\nATGCGT\n';
    mocks.fs.stat.mockResolvedValue({ size: fasta.length, mtime: 5678 });
    mocks.fs.readTextFile.mockResolvedValue(fasta);

    const snapshot = await buildFileDnaSequenceSnapshot('/workspace/target.fa', {
      workspaceRoot: '/workspace',
      documentId: 'sequence-target',
    });

    expect(snapshot.bases).toBe('ATGCGT');
    expect(snapshot.ref).toMatchObject({
      relPath: '/workspace/target.fa',
      length: 6,
      topology: 'linear',
      sequenceId: 42,
    });
    expect(mocks.fs.readTextFile).toHaveBeenCalledTimes(1);
  });

  it('carries the saved genetic code through registration and a later file refresh', async () => {
    const source = [
      'LOCUS       mitochondrial           4 bp    DNA     linear   SYN 01-JAN-2000',
      'ORIGIN',
      '        1 atgc',
      '//',
      '',
    ].join('\n');
    const saved = updateGenBankGeneticCodeComment(source, 3);
    mocks.fs.stat.mockResolvedValue({ size: saved.length, mtime: 5678 });
    mocks.fs.exists.mockResolvedValue(true);
    mocks.fs.readTextFile.mockResolvedValue(saved);

    const ref = await buildFileDnaSequenceRef('/workspace/mitochondrial.gb', {
      documentId: 'sequence-mitochondrial',
    });

    expect(ref).toMatchObject({ geneticCode: 3 });
    expect(ref.fileContentHash).toBe(await computeChecksum(saved));
    expect(mocks.fs.readTextFile).toHaveBeenCalledTimes(1);

    const changed = updateGenBankGeneticCodeComment(saved, 2);
    mocks.fs.readTextFile.mockResolvedValue(changed);
    const refreshed = await resolveDnaSequence(ref);

    expect(refreshed).toMatchObject({ status: 'drifted', ref: { geneticCode: 2 } });
    expect(mocks.fs.readTextFile).toHaveBeenCalledTimes(2);
  });

  it('builds SnapGene file refs from binary bytes with snapgene provenance', async () => {
    const bytes = readFileSync(fixturePath('test-fixtures/sequences/snapgene/sample-f.dna'));
    const contentForHash = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    mocks.fs.stat.mockResolvedValue({ size: bytes.byteLength, mtime: 4321 });
    mocks.fs.readFile.mockResolvedValue(new Uint8Array(bytes));
    mocks.ensureSequenceIdentity.mockResolvedValue(88);

    const ref = await buildFileDnaSequenceRef('/workspace/sample-f.dna', {
      documentId: 'sequence-sample-f',
    });

    expect(mocks.fs.readFile).toHaveBeenCalledWith('/workspace/sample-f.dna');
    expect(mocks.fs.readTextFile).not.toHaveBeenCalled();
    expect(ref).toMatchObject({
      mode: 'file',
      relPath: '/workspace/sample-f.dna',
      topology: 'circular',
      length: 1000,
      sourceFormat: 'snapgene',
      sequenceId: 88,
      sizeBytes: bytes.byteLength,
      modifiedAt: 4321,
    });
    expect(ref.contentHash).toBe(await computeChecksum(contentForHash));
    expect(mocks.ensureSequenceIdentity).toHaveBeenCalledWith(
      'sequence-sample-f',
      '/workspace/sample-f.dna',
      'Sample',
      1000,
      true
    );
  });
});

function fileRef(overrides: Partial<FileDnaSequenceRef>): FileDnaSequenceRef {
  return {
    mode: 'file',
    documentId: 'sequence-fixture',
    relPath: '/workspace/seq.fa',
    topology: 'linear',
    length: 4,
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceFormat: 'fasta',
    ...overrides,
  };
}

function fixturePath(relativePath: string): string {
  return (
    [
      resolve(process.cwd(), relativePath),
      resolve(process.cwd(), '../..', relativePath),
      resolve(process.cwd(), '../../..', relativePath),
    ].find((candidate) => existsSync(candidate)) ?? relativePath
  );
}

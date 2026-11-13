import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: fsMock }),
}));

import {
  resolveAminoAcidSequence,
  buildFileAminoAcidSequenceRef,
  buildInlineAminoAcidSequenceRef,
  buildInlineProteinSequenceRef,
  proteinSequenceValidationError,
} from './protein-sequence';
import {
  parseFastaAminoAcidSequence,
  serializeAminoAcidFasta,
} from '../../shared/amino-acid-sequence';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseFastaAminoAcidSequence', () => {
  it('strips a FASTA header line, whitespace, and uppercases', () => {
    expect(parseFastaAminoAcidSequence('>GFP\nmsk\ngee\n')).toBe('MSKGEE');
  });

  it('handles bodies with no FASTA header', () => {
    expect(parseFastaAminoAcidSequence('msk gee')).toBe('MSKGEE');
  });

  it('accepts blank lines before a single FASTA record', () => {
    expect(parseFastaAminoAcidSequence('\n\n>protein\nMSK\n')).toBe('MSK');
  });

  it('refuses to concatenate multiple FASTA records into one protein', () => {
    expect(() => parseFastaAminoAcidSequence('>first\nMKT\n>second\nWQ\n')).toThrow(
      'This protein FASTA contains multiple records'
    );
  });
});

describe('serializeAminoAcidFasta', () => {
  it('writes a single-record FASTA file', () => {
    expect(serializeAminoAcidFasta('GFP', 'MSK')).toBe('>GFP\nMSK\n');
  });

  it('strips embedded newlines from the name so it cannot splice a second FASTA record into the header line', () => {
    const result = serializeAminoAcidFasta('GFP\n>injected\nMALICIOUS', 'MSK');
    const lines = result.split('\n');
    expect(lines[0].startsWith('>')).toBe(true);
    expect(lines.filter((line) => line.startsWith('>')).length).toBe(1);
    expect(result).toContain('GFP');
    expect(parseFastaAminoAcidSequence(result)).toBe('MSK');
  });
});

describe('buildInlineAminoAcidSequenceRef', () => {
  it('strips whitespace, uppercases, and computes a sha256 content hash', async () => {
    const ref = await buildInlineAminoAcidSequenceRef('msk gee\nlft');
    expect(ref.mode).toBe('inline');
    expect(ref.bases).toBe('MSKGEELFT');
    expect(ref.length).toBe(9);
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic — the same (normalized) sequence always produces the same hash', async () => {
    const a = await buildInlineAminoAcidSequenceRef('MSKGEE');
    const b = await buildInlineAminoAcidSequenceRef('msk gee');
    expect(b.contentHash).toBe(a.contentHash);
  });
});

describe('portable protein sequence references', () => {
  it('stores the standard protein alphabet, X, and stop markers without DNA-shaped fields', async () => {
    const ref = await buildInlineProteinSequenceRef('msk x*');
    expect(ref).toMatchObject({ mode: 'inline', aminoAcids: 'MSKX*', length: 5 });
    expect(ref).not.toHaveProperty('bases');
    expect(ref.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects unsupported residues through one shared validator', () => {
    expect(proteinSequenceValidationError('MSKX*')).toBeNull();
    expect(proteinSequenceValidationError('MSKZ')).toMatch(/one-letter amino-acid/i);
  });
});

describe('resolveAminoAcidSequence', () => {
  it('returns unresolved for an unresolved ref without touching the filesystem', async () => {
    const result = await resolveAminoAcidSequence({ mode: 'unresolved' });
    expect(result).toEqual({ status: 'unresolved' });
    expect(fsMock.exists).not.toHaveBeenCalled();
  });

  it('returns loaded for an inline ref directly', async () => {
    const result = await resolveAminoAcidSequence({
      mode: 'inline',
      bases: 'MSK',
      length: 3,
    });
    expect(result).toEqual({ status: 'loaded', bases: 'MSK', length: 3 });
  });

  it('returns loaded for the portable inline protein ref used by entity packages', async () => {
    const result = await resolveAminoAcidSequence({
      mode: 'inline',
      aminoAcids: 'MSKX*',
      length: 5,
    });
    expect(result).toEqual({ status: 'loaded', bases: 'MSKX*', length: 5 });
  });

  it('returns missing when the file-backed ref points at a nonexistent file', async () => {
    fsMock.exists.mockResolvedValue(false);
    const result = await resolveAminoAcidSequence({
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: 3,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    });
    expect(result).toEqual({ status: 'missing', length: 3 });
    expect(fsMock.readTextFile).not.toHaveBeenCalled();
  });

  it('reads and parses a file-backed ref', async () => {
    fsMock.exists.mockResolvedValue(true);
    fsMock.readTextFile.mockResolvedValue('>GFP\nMSK\n');
    const result = await resolveAminoAcidSequence({
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: 3,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    });
    expect(result).toEqual({ status: 'loaded', bases: 'MSK', length: 3 });
  });

  it('returns a clear error instead of presenting multiple records as one sequence', async () => {
    fsMock.exists.mockResolvedValue(true);
    fsMock.readTextFile.mockResolvedValue('>first\nMKT\n>second\nWQ\n');
    const result = await resolveAminoAcidSequence({
      mode: 'file',
      relPath: 'proteins/multiple.faa',
      length: 5,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    });
    expect(result).toEqual({
      status: 'error',
      error:
        'This protein FASTA contains multiple records. Open it in the sequence viewer to browse its records.',
    });
  });

  it('returns an error state if reading throws', async () => {
    fsMock.exists.mockResolvedValue(true);
    fsMock.readTextFile.mockRejectedValue(new Error('disk exploded'));
    const result = await resolveAminoAcidSequence({
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: 3,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    });
    expect(result).toEqual({ status: 'error', error: 'disk exploded' });
  });
});

describe('buildFileAminoAcidSequenceRef', () => {
  it('builds a file ref from stat + file contents', async () => {
    fsMock.stat.mockResolvedValue({ size: 10, isFile: true, isDirectory: false, mtime: 1000 });
    fsMock.readTextFile.mockResolvedValue('>GFP\nMSK\n');
    const ref = await buildFileAminoAcidSequenceRef('proteins/gfp.faa');
    expect(ref.mode).toBe('file');
    expect(ref.relPath).toBe('proteins/gfp.faa');
    expect(ref.length).toBe(3);
    expect(ref.sourceFormat).toBe('fasta');
    expect(ref.sizeBytes).toBe(10);
  });
});

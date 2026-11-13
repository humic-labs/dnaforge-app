import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  baseName,
  defaultTargetPath,
  hasSupportedSequenceExtension,
  legacySourcePathToImportSource,
  loadSequenceImportSource,
  normalizeSequenceImportSource,
  sanitizeFileName,
} from './sequence-import-source';

const { mockPlatform, mockSidecarFetchSequenceBytes, mockSidecarFetchSequenceUrlBytes } =
  vi.hoisted(() => ({
  mockPlatform: {
    fs: {
      stat: vi.fn(),
      readTextFile: vi.fn(),
    },
  },
  mockSidecarFetchSequenceBytes: vi.fn(),
  mockSidecarFetchSequenceUrlBytes: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
}));

vi.mock('./sidecar-client', () => ({
  sidecarFetchSequenceBytes: mockSidecarFetchSequenceBytes,
  sidecarFetchSequenceUrlBytes: mockSidecarFetchSequenceUrlBytes,
}));

const WORKSPACE = '/home/user/lab';
const singleFolder: WorkspaceFolder[] = [{ name: 'lab', path: WORKSPACE, addedAt: 1 }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pure source helpers', () => {
  it('normalizes source vs sourcePath and rejects both', () => {
    expect(normalizeSequenceImportSource({ source: { kind: 'local_file', path: 'a.gb' } })).toEqual(
      {
        kind: 'local_file',
        path: 'a.gb',
      }
    );
    expect(normalizeSequenceImportSource({ sourcePath: '/tmp/a.gb' })).toEqual({
      kind: 'local_file',
      path: '/tmp/a.gb',
    });
    expect(() =>
      normalizeSequenceImportSource({
        source: { kind: 'local_file', path: 'a.gb' },
        sourcePath: 'b.gb',
      })
    ).toThrow(/either source or sourcePath/);
  });

  it('maps a legacy http path to a url source and a local path to local_file', () => {
    expect(legacySourcePathToImportSource('https://example.com/x.gb')).toEqual({
      kind: 'url',
      url: 'https://example.com/x.gb',
    });
    expect(legacySourcePathToImportSource('/tmp/x.gb')).toEqual({
      kind: 'local_file',
      path: '/tmp/x.gb',
    });
  });

  it('sanitizes filenames and computes defaults', () => {
    expect(sanitizeFileName('NC_000913.3 (E. coli).gb')).toBe('NC_000913.3-E.-coli-.gb');
    expect(defaultTargetPath('pUC19.gb')).toBe('imports/pUC19.gb');
    expect(baseName('/a/b/c.gb')).toBe('c.gb');
    for (const path of ['x.fasta', 'x.fas', 'x.fna', 'x.ffn', 'x.gb', 'x.gbk', 'x.gbff']) {
      expect(hasSupportedSequenceExtension(path)).toBe(true);
    }
    expect(hasSupportedSequenceExtension('x.txt')).toBe(false);
  });
});

describe('loadSequenceImportSource — local file', () => {
  it('parses a local GenBank file and tags filesystem provenance', async () => {
    mockPlatform.fs.stat.mockResolvedValue({ size: 100 });
    mockPlatform.fs.readTextFile.mockResolvedValue(genBankContent('x', 'A'));

    const loaded = await loadSequenceImportSource(singleFolder, {
      source: { kind: 'local_file', path: '/home/user/x.gb' },
    });

    expect(loaded.source).toMatchObject({
      kind: 'local_file',
      absolutePath: '/home/user/x.gb',
      provenance: { provider: 'local_file', fetchedVia: 'filesystem' },
    });
  });
});

describe('loadSequenceImportSource — NCBI via sidecar', () => {
  it('fetches via the sidecar and attaches rich provenance', async () => {
    mockSidecarFetchSequenceBytes.mockResolvedValue({
      provider: 'ncbi-nuccore',
      externalId: 'NC_000913.3',
      format: 'genbank',
      content: genBankContent('E. coli', 'A'),
      contentSha256: 'b'.repeat(64),
      sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
      license: 'Public domain (NCBI/GenBank)',
      attribution: 'Courtesy of the U.S. National Library of Medicine (NCBI)',
      versionIdentifier: '3',
      metadata: { organism: 'Escherichia coli', definition: 'complete genome', taxon_id: '511145' },
    });
    const loaded = await loadSequenceImportSource(
      singleFolder,
      {
        source: { kind: 'ncbi', accession: 'nc_000913.3', database: 'nucleotide' },
      },
      { grantedCapabilities: ['external-fetch:annotation'] }
    );

    expect(mockSidecarFetchSequenceBytes).toHaveBeenCalledWith(
      { externalId: 'nc_000913.3' },
      { grantedCapabilities: ['external-fetch:annotation'] }
    );
    expect(loaded.defaultFileName).toBe('NC_000913.3.gb');
    expect(loaded.source).toMatchObject({
      kind: 'ncbi',
      accession: 'NC_000913.3',
      database: 'nucleotide',
      provenance: {
        provider: 'ncbi-nuccore',
        fetchedVia: 'sidecar',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/nuccore/NC_000913.3',
        license: 'Public domain (NCBI/GenBank)',
        contentSha256: 'b'.repeat(64),
        versionIdentifier: '3',
        organism: 'Escherichia coli',
        definition: 'complete genome',
        taxonId: '511145',
      },
    });
  });

  it('🟥 forwards the stop signal into the sidecar fetch ', async () => {
    const controller = new AbortController();
    mockSidecarFetchSequenceBytes.mockResolvedValue({
      provider: 'ncbi-nuccore',
      externalId: 'NC_000913.3',
      format: 'genbank',
      content: genBankContent('E. coli', 'A'),
      contentSha256: 'b'.repeat(64),
      metadata: {},
    });

    await loadSequenceImportSource(
      singleFolder,
      { source: { kind: 'ncbi', accession: 'NC_000913.3' } },
      { grantedCapabilities: ['external-fetch:annotation'], abortSignal: controller.signal }
    );

    expect(mockSidecarFetchSequenceBytes).toHaveBeenCalledWith(
      { externalId: 'NC_000913.3' },
      { grantedCapabilities: ['external-fetch:annotation'], signal: controller.signal }
    );
  });

  it('🟥 rethrows the download abort untouched so the caller can recognize Stop', async () => {
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    });
    mockSidecarFetchSequenceBytes.mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();

    await expect(
      loadSequenceImportSource(
        singleFolder,
        { source: { kind: 'ncbi', accession: 'NC_000913.3' } },
        { abortSignal: controller.signal }
      )
    ).rejects.toBe(abortError);
    expect(mockSidecarFetchSequenceBytes).toHaveBeenCalledWith(
      { externalId: 'NC_000913.3' },
      { signal: controller.signal }
    );
  });

  it('propagates the sidecar error message', async () => {
    mockSidecarFetchSequenceBytes.mockRejectedValue(new Error('NCBI is temporarily unavailable.'));
    await expect(
      loadSequenceImportSource(singleFolder, { source: { kind: 'ncbi', accession: 'NC_000913.3' } })
    ).rejects.toThrow(/NCBI is temporarily unavailable/);
  });
});

function genBankContent(name: string, sequence: string): string {
  return [
    `LOCUS       ${name.padEnd(16)} ${String(sequence.length).padStart(7)} bp    DNA     circular SYN 01-JAN-2026`,
    `DEFINITION  ${name}.`,
    'FEATURES             Location/Qualifiers',
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
  ].join('\n');
}

describe('loadSequenceImportSource — public URL via sidecar', () => {
  it('fetches through the guarded sidecar boundary and preserves provenance', async () => {
    mockSidecarFetchSequenceUrlBytes.mockResolvedValue({
      provider: 'public-url',
      externalId: 'https://example.com/y.gb',
      format: 'auto',
      content: genBankContent('remote', 'A'),
      contentSha256: 'c'.repeat(64),
      sourceUrl: 'https://example.com/y.gb',
      attribution: 'Source: example.com',
      metadata: {},
    });

    const loaded = await loadSequenceImportSource(
      singleFolder,
      { source: { kind: 'url', url: 'https://example.com/y.gb' } },
      { grantedCapabilities: ['external-fetch:annotation'] }
    );

    expect(mockSidecarFetchSequenceUrlBytes).toHaveBeenCalledWith(
      { url: 'https://example.com/y.gb' },
      { grantedCapabilities: ['external-fetch:annotation'] }
    );
    expect(loaded.defaultFileName).toBe('y.gb');
    expect(loaded.source).toMatchObject({
      kind: 'url',
      url: 'https://example.com/y.gb',
      provenance: {
        provider: 'public-url',
        fetchedVia: 'sidecar',
        sourceUrl: 'https://example.com/y.gb',
        attribution: 'Source: example.com',
        contentSha256: 'c'.repeat(64),
      },
    });
  });

  it('forwards cancellation to URL downloads', async () => {
    const controller = new AbortController();
    mockSidecarFetchSequenceUrlBytes.mockResolvedValue({
      provider: 'public-url',
      externalId: 'https://example.com/y.fasta',
      format: 'auto',
      content: '>remote\nA\n',
      contentSha256: 'd'.repeat(64),
      metadata: {},
    });

    await loadSequenceImportSource(
      singleFolder,
      { source: { kind: 'url', url: 'https://example.com/y.fasta' } },
      { abortSignal: controller.signal }
    );

    expect(mockSidecarFetchSequenceUrlBytes).toHaveBeenCalledWith(
      { url: 'https://example.com/y.fasta' },
      { signal: controller.signal }
    );
  });
});

describe('loadSequenceImportSource — reserved adapters', () => {
  it('rejects Addgene with picker-aligned, recoverable copy', async () => {
    await expect(
      loadSequenceImportSource(singleFolder, { source: { kind: 'addgene', plasmidId: '12345' } })
    ).rejects.toThrow(/Addgene import isn't available yet.*import it as a local file/);
  });
});

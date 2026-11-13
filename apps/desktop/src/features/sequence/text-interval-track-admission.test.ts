import { beforeEach, describe, expect, it, vi } from 'vitest';

import { directTrackAdmissionRequest } from '@waypoint/genome-data';

import { admitTextIntervalTrackRequest } from './text-interval-track-admission';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  stat: vi.fn(),
  readFileBounded: vi.fn(),
  open: vi.fn(),
  closeSource: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    dialog: { authorizeLocalIndexedTrack: mocks.authorize },
    fs: { stat: mocks.stat, readFileBounded: mocks.readFileBounded },
  }),
}));

vi.mock('./text-interval-reader-runtime', () => ({
  getTextIntervalReaderWorkerClient: () => ({
    open: mocks.open,
    closeSource: mocks.closeSource,
  }),
}));

const fileStat = {
  canonicalPath: '/analysis/transcripts.bed',
  size: 24,
  isFile: true,
  isDirectory: false,
  mtime: 1,
  ctime: 1,
  mtimeNs: '1000',
  ctimeNs: '1000',
  device: '1',
  inode: '2',
};

describe('local text interval admission', () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue({
      canonicalPath: '/analysis/transcripts.bed',
      authority: 'opaque-native-authority',
    });
    mocks.stat.mockReset().mockResolvedValue(fileStat);
    mocks.readFileBounded.mockReset().mockResolvedValue(new TextEncoder().encode('chr1\t10\t20\n'));
    mocks.open.mockReset().mockResolvedValue({
      formatId: 'bed',
      scientificKind: 'interval',
      referenceExtents: [{ name: 'chr1', maxEnd: 20 }],
      recordCount: 1,
      sourceByteLength: 24,
      decodedByteLength: 24,
      contentSha256: `sha256:${'a'.repeat(64)}`,
    });
    mocks.closeSource.mockReset().mockResolvedValue(undefined);
  });

  it('authorizes, parses, verifies, and returns one durable source-neutral receipt', async () => {
    const request = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'path', path: '/analysis/transcripts.bed' },
      formatId: 'bed',
      ingress: 'file-picker',
    });

    const source = await admitTextIntervalTrackRequest({
      request,
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
    });

    expect(mocks.authorize).toHaveBeenCalledWith({ path: '/analysis/transcripts.bed' });
    expect(mocks.readFileBounded).toHaveBeenCalledWith(
      '/analysis/transcripts.bed',
      128 * 1024 * 1024
    );
    expect(source).toMatchObject({
      admissionVersion: 2,
      formatId: 'bed',
      readerKind: 'interval-text',
      scientificKind: 'interval',
      fingerprint: `bed:sha256:${'a'.repeat(64)}`,
      input: { kind: 'path', path: '/analysis/transcripts.bed' },
      request: {
        source: { kind: 'local-file', path: '/analysis/transcripts.bed' },
        scientificKind: 'interval',
      },
      expectedValidators: { contentLength: 24 },
      referenceReceipt: { contigMap: { chr1: 'chr1' }, checkedContigs: 1 },
    });
    expect(source.provenance).not.toHaveProperty('authority');
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });

  it('rejects remote text before reading because unindexed remote streaming is not this adapter', async () => {
    const request = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://example.org/features.bed' },
      formatId: 'bed',
      ingress: 'url',
    });

    await expect(
      admitTextIntervalTrackRequest({
        request,
        assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      })
    ).rejects.toThrow('Remote BED requires a tabix index');
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('rejects a file that changes while its admission bytes are read', async () => {
    mocks.stat
      .mockResolvedValueOnce(fileStat)
      .mockResolvedValueOnce({ ...fileStat, mtimeNs: '2000' });
    const request = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'path', path: '/analysis/transcripts.bed' },
      formatId: 'bed',
      ingress: 'file-picker',
    });

    await expect(
      admitTextIntervalTrackRequest({
        request,
        assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      })
    ).rejects.toThrow('changed while it was being admitted');
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdmittedTrackSource } from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';

import { createTextIntervalSourceSession } from './text-interval-source-session';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  stat: vi.fn(),
  readFileBounded: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    dialog: { authorizeLocalIndexedTrack: mocks.authorize },
    fs: { stat: mocks.stat, readFileBounded: mocks.readFileBounded },
  }),
}));

const assembly: Assembly = {
  id: 'grch38',
  displayName: 'GRCh38',
  totalLengthBp: 1_000,
  chromosomes: [
    {
      chromosome: { id: 'chr1', displayName: 'chr1', length: 1_000, cytobands: [] },
      globalStartBp: 0,
      globalEndBp: 1_000,
      order: 0,
    },
  ],
};

const source: AdmittedTrackSource = {
  admissionVersion: 2,
  request: {
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: 'grch38',
    source: { kind: 'local-file', path: '/analysis/regions.bed' },
    formatId: 'bed',
    scientificKind: 'interval',
    ingress: { kind: 'file-picker' },
  },
  admittedAt: '2026-09-21T19:00:00.000Z',
  uri: 'file:///analysis/regions.bed',
  input: { kind: 'path', path: '/analysis/regions.bed' },
  formatId: 'bed',
  readerKind: 'interval-text',
  scientificKind: 'interval',
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: 'reference',
    sourceSignature: 'source',
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-21T19:00:00.000Z',
  },
  provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'regions.bed' },
  fingerprint: `bed:sha256:${'a'.repeat(64)}`,
  expectedValidators: { contentLength: 100 },
};

const stat = {
  canonicalPath: '/analysis/regions.bed',
  size: 100,
  isFile: true,
  isDirectory: false,
  mtime: 1,
  ctime: 1,
  mtimeNs: '1000',
  ctimeNs: '1000',
  device: '1',
  inode: '2',
};

describe('createTextIntervalSourceSession', () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue({
      canonicalPath: '/analysis/regions.bed',
      authority: 'opaque-authority',
    });
    mocks.stat.mockReset().mockResolvedValue(stat);
    mocks.readFileBounded.mockReset().mockResolvedValue(new Uint8Array(100));
  });

  it('opens one verified worker generation and reuses it across regional operations', async () => {
    const reader = {
      open: vi.fn().mockResolvedValue({
        formatId: 'bed' as const,
        scientificKind: 'interval' as const,
        referenceExtents: [{ name: 'chr1', maxEnd: 900 }],
        recordCount: 10,
        sourceByteLength: 100,
        decodedByteLength: 100,
        contentSha256: `sha256:${'a'.repeat(64)}`,
      }),
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    const session = createTextIntervalSourceSession({ assembly, source, reader });
    const operation = vi.fn(async ({ sourceKey }: { sourceKey: string }) => sourceKey);

    const first = await session.execute(new AbortController().signal, operation);
    const second = await session.execute(new AbortController().signal, operation);

    expect(first).toBe(second);
    expect(reader.open).toHaveBeenCalledOnce();
    expect(mocks.readFileBounded).toHaveBeenCalledOnce();
    await session.dispose();
    expect(reader.closeSource).toHaveBeenCalledWith(first);
  });

  it('fails closed and retires the worker handle when the content fingerprint changed', async () => {
    const reader = {
      open: vi.fn().mockResolvedValue({
        formatId: 'bed' as const,
        scientificKind: 'interval' as const,
        referenceExtents: [{ name: 'chr1', maxEnd: 900 }],
        recordCount: 10,
        sourceByteLength: 100,
        decodedByteLength: 100,
        contentSha256: `sha256:${'b'.repeat(64)}`,
      }),
      closeSource: vi.fn().mockResolvedValue(undefined),
    };
    const session = createTextIntervalSourceSession({ assembly, source, reader });

    await expect(session.execute(new AbortController().signal, async () => true)).rejects.toThrow(
      'changed since it was added'
    );
    expect(reader.closeSource).toHaveBeenCalledOnce();
  });
});

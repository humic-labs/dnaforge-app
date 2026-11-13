import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  files: new Set<string>(),
  workspaces: [] as string[],
  rows: [] as Array<{
    path: string;
    file_kind: string;
    entity_id: string;
    status: string;
    sequence_fingerprint: string | null;
  }>,
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { exists: async (path: string) => state.files.has(path) },
    db: {
      select: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM workspaces')) return state.workspaces.map((path) => ({ path }));
        if (sql.includes('sequence_fingerprint = ?'))
          return state.rows.filter(
            (row) => row.sequence_fingerprint === params[0] && row.status === 'current'
          );
        if (sql.includes('DISTINCT entity_id'))
          return [
            ...new Set(state.rows.filter((row) => row.path === params[0]).map((r) => r.entity_id)),
          ].map((entity_id) => ({ entity_id }));
        if (sql.includes('entity_id = ?'))
          return state.rows.filter(
            (row) => row.entity_id === params[0] && row.status === 'current'
          );
        throw new Error(`unexpected query ${sql}`);
      },
    },
  }),
}));

vi.mock('../../sequence/public/sequence-package-product', () => ({
  resolveSequencePackageProductPath: async (root: string) => `${root}/${root.split('/').pop()}.gb`,
}));

import { AlignmentQueryMissingError, resolveAlignmentQuery } from './resolve-alignment-query';

const FINGERPRINT = `seq-v1:dna:linear:sha256:${'a'.repeat(64)}`;
const reference = '/lab/project/pUC19/pUC19.gb';

function row(path: string, overrides: Partial<(typeof state.rows)[number]> = {}) {
  state.rows.push({
    path,
    file_kind: 'fasta',
    entity_id: 'read-entity',
    status: 'current',
    sequence_fingerprint: FINGERPRINT,
    ...overrides,
  });
}

describe('resolveAlignmentQuery', () => {
  beforeEach(() => {
    state.files = new Set();
    state.workspaces = ['/lab/project'];
    state.rows = [];
  });

  it('keeps a read that is still where it was recorded', async () => {
    state.files.add('/lab/project/pUC19/read.fasta');

    await expect(
      resolveAlignmentQuery({ queryPath: 'read.fasta', queryFingerprint: FINGERPRINT }, reference)
    ).resolves.toBe('/lab/project/pUC19/read.fasta');
  });

  it('finds a moved read by its bases', async () => {
    row('/lab/project/reads/renamed.fasta');
    state.files.add('/lab/project/reads/renamed.fasta');

    await expect(
      resolveAlignmentQuery(
        { queryPath: '/lab/project/read.fasta', queryFingerprint: FINGERPRINT },
        reference
      )
    ).resolves.toBe('/lab/project/reads/renamed.fasta');
  });

  it('finds a read that became a package through its product', async () => {
    row('/lab/project/read', { file_kind: 'waypoint-sequence' });
    state.files.add('/lab/project/read/read.gb');

    await expect(
      resolveAlignmentQuery(
        { queryPath: '/lab/project/read.fasta', queryFingerprint: FINGERPRINT },
        reference
      )
    ).resolves.toBe('/lab/project/read/read.gb');
  });

  it('follows the catalog identity of a read saved before fingerprints existed', async () => {
    row('/lab/project/read.fasta', { status: 'historical', sequence_fingerprint: null });
    row('/lab/project/read', { file_kind: 'waypoint-sequence', sequence_fingerprint: null });
    state.files.add('/lab/project/read/read.gb');

    await expect(
      resolveAlignmentQuery({ queryPath: '/lab/project/read.fasta' }, reference)
    ).resolves.toBe('/lab/project/read/read.gb');
  });

  it('never takes a matching read from another project', async () => {
    state.workspaces = ['/lab/project', '/lab/other'];
    row('/lab/other/read.fasta');
    state.files.add('/lab/other/read.fasta');

    await expect(
      resolveAlignmentQuery(
        { queryPath: '/lab/project/read.fasta', queryFingerprint: FINGERPRINT },
        reference
      )
    ).rejects.toBeInstanceOf(AlignmentQueryMissingError);
  });

  it('reports a read that is gone everywhere', async () => {
    await expect(
      resolveAlignmentQuery(
        { queryPath: '/lab/project/read.fasta', queryFingerprint: FINGERPRINT },
        reference
      )
    ).rejects.toThrow('was moved or deleted');
  });
});

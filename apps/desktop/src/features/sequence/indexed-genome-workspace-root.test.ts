// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { pickIndexedGenomeWorkspaceRoot } from './indexed-genome-workspace-root';

describe('pickIndexedGenomeWorkspaceRoot', () => {
  it('selects the deepest containing project regardless of mount order', () => {
    const source = '/lab/client-a/genomes/ecoli.fasta';

    expect(pickIndexedGenomeWorkspaceRoot(source, null, ['/lab', '/lab/client-a'])).toBe(
      '/lab/client-a'
    );
    expect(pickIndexedGenomeWorkspaceRoot(source, null, ['/lab/client-a', '/lab'])).toBe(
      '/lab/client-a'
    );
  });

  it('refuses duplicate normalized owners instead of selecting by input order', () => {
    const source = '/lab/client-a/genomes/ecoli.fasta';

    expect(
      pickIndexedGenomeWorkspaceRoot(source, null, ['/lab/client-a', '/lab/client-a/'])
    ).toBeNull();
    expect(
      pickIndexedGenomeWorkspaceRoot(source, null, ['/lab/client-a/', '/lab/client-a'])
    ).toBeNull();
  });
});

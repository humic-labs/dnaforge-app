import { parseMigrationScope } from './contracts';

describe('local-export Folder Tree scope', () => {
  const localRoot = {
    id: 'local-export-folder-3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    url: 'urn:dnaforge:benchling-local-export:pending:3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    objectType: 'folder',
  };

  it('accepts a minted local root for a provider-free downloaded export', () => {
    expect(
      parseMigrationScope({
        version: 1,
        kind: 'folder_tree',
        roots: [localRoot],
        includeChildren: true,
        acquisition: 'local_bundle',
      })
    ).toEqual({
      version: 1,
      kind: 'folder_tree',
      roots: [localRoot],
      includeChildren: true,
      includeArchived: false,
      acquisition: 'local_bundle',
    });
  });

  it('rejects the local root when the run is not provider-free', () => {
    expect(() =>
      parseMigrationScope({
        version: 1,
        kind: 'folder_tree',
        roots: [localRoot],
        includeChildren: true,
      })
    ).toThrow();
  });
});

describe('local-export File scope', () => {
  it('preserves the provider-free acquisition marker', () => {
    expect(
      parseMigrationScope({
        version: 1,
        kind: 'file',
        source: {
          id: 'seq_downloaded',
          url: 'https://benchling.com/exampleuser/seq_downloaded',
          objectType: 'dna_sequence',
        },
        acquisition: 'local_bundle',
      })
    ).toMatchObject({
      version: 1,
      kind: 'file',
      acquisition: 'local_bundle',
    });
  });
});

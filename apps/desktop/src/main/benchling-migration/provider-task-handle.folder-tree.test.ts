import type { FolderTreeExportAuthority } from '../../shared/benchling-migration';

import { folderTreeAuthorityDigest } from './provider-task-handle';

describe('Folder Tree authority digest', () => {
  it('is stable across equivalent property insertion orders', () => {
    const authority: FolderTreeExportAuthority = {
      schema: 'dnaforge.benchling.folder-tree-export-authority.v1',
      capturePlanDigest: `sha256:${'1'.repeat(64)}`,
      traversalJournalDigest: `sha256:${'2'.repeat(64)}`,
      selectedRootId: 'lib_Root123',
      sourceItemId: 'etr_Entry123',
      sourceItemUrl: 'https://benchling.com/exampleuser/f/lib_Root123/etr_Entry123',
      sourceItemType: 'entry',
      sourceFolderIds: ['lib_Root123'],
      maximumFolderDepth: 0,
      requestCapabilityId: 'benchling.notebook-entry-html-export.v1',
    };
    const reordered: FolderTreeExportAuthority = {
      requestCapabilityId: authority.requestCapabilityId,
      maximumFolderDepth: authority.maximumFolderDepth,
      sourceFolderIds: [...authority.sourceFolderIds],
      sourceItemType: authority.sourceItemType,
      sourceItemUrl: authority.sourceItemUrl,
      sourceItemId: authority.sourceItemId,
      selectedRootId: authority.selectedRootId,
      traversalJournalDigest: authority.traversalJournalDigest,
      capturePlanDigest: authority.capturePlanDigest,
      schema: authority.schema,
    };

    expect(folderTreeAuthorityDigest(authority)).toMatch(/[0-9a-f]{64}/);
    expect(folderTreeAuthorityDigest(reordered)).toBe(folderTreeAuthorityDigest(authority));
  });
});

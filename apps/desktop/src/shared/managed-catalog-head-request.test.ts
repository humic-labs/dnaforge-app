// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  MAX_MANAGED_CATALOG_PRESERVE_PATHS,
  validateManagedCatalogHeadIndexRequest,
} from './managed-catalog-head-request';

describe('validateManagedCatalogHeadIndexRequest', () => {
  it('accepts bounded normalized repo-relative catalog paths', () => {
    expect(() =>
      validateManagedCatalogHeadIndexRequest({
        repoPath: '/managed/lab',
        preserveRelPaths: ['notes/experiment.notebook/meta.json', 'sequence.gb'],
        healWorkingTree: false,
        mutationToken: 'inert-test-token',
      })
    ).not.toThrow();
  });

  it.each(['', '/outside.txt', '../outside.txt', 'folder/../outside.txt', 'folder\\file.txt'])(
    'rejects malformed renderer path %j',
    (relPath) => {
      expect(() =>
        validateManagedCatalogHeadIndexRequest({
          repoPath: '/managed/lab',
          preserveRelPaths: [relPath],
        })
      ).toThrow('MANAGED_CATALOG_PRESERVE_PATH_INVALID');
    }
  );

  it('rejects an oversized renderer path collection before Git work begins', () => {
    expect(() =>
      validateManagedCatalogHeadIndexRequest({
        repoPath: '/managed/lab',
        preserveRelPaths: Array.from(
          { length: MAX_MANAGED_CATALOG_PRESERVE_PATHS + 1 },
          (_, index) => `entry-${index}.txt`
        ),
      })
    ).toThrow('MANAGED_CATALOG_PRESERVE_PATHS_LIMIT');
  });
});

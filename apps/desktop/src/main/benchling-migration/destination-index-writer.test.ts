import { describe, expect, it } from 'vitest';

import type { ProjectionReceipt, SourceObject } from '../../shared/benchling-migration';
import { buildMigrationDestinationIndexEntries } from './destination-index-writer';
import {
  buildMigrationDestinationLinkIndex,
  isSafeMigrationDestinationRelativePath,
} from '../../shared/benchling-migration-destination-index';

it('permits only identity-bound generated collection links under the protected metadata root', () => {
  const id = `folder-${'a'.repeat(24)}`;
  const entry = {
    destinationObjectId: id,
    sourceStableIds: ['lib_SOURCEFOLDER'],
    title: 'Yeast',
    locator: {
      kind: 'workspace_path' as const,
      tabType: 'scientific-document' as const,
      relativePath: `.dnaforge/migration/collections/${id}.json`,
    },
  };
  expect(buildMigrationDestinationLinkIndex([entry]).entries[0]).toEqual(entry);
  for (const relativePath of [
    '.dnaforge/migration/state.json',
    `.dnaforge/migration/collections/folder-${'b'.repeat(24)}.json`,
  ]) {
    expect(() =>
      buildMigrationDestinationLinkIndex([
        { ...entry, locator: { ...entry.locator, relativePath } },
      ])
    ).toThrow(/unsafe/iu);
  }
});

describe('buildMigrationDestinationIndexEntries', () => {
  it('accepts native root paths while preserving existing traversal and protected-root defenses', () => {
    expect(isSafeMigrationDestinationRelativePath('YEN1.gb')).toBe(true);
    expect(isSafeMigrationDestinationRelativePath('Designs/YEN1.gb')).toBe(true);
    expect(isSafeMigrationDestinationRelativePath('Benchling Imports/Legacy/YEN1.gb')).toBe(true);
    for (const path of [
      '',
      '../canary.txt',
      '/canary.txt',
      'Designs/%2e%2e/canary.txt',
      '.git/config',
      '.dnaforge/migration/state.json',
    ]) {
      expect(isSafeMigrationDestinationRelativePath(path)).toBe(false);
    }
  });

  it('routes a projected protein FASTA to the native protein tab', () => {
    const sourceObject: SourceObject = {
      id: 'prot_source_1',
      stableId: 'prot_stable_1',
      sourceType: 'protein',
      name: 'Reporter protein',
      aliases: [],
      sourceUrl: 'https://example.benchling.com/proteins/prot_source_1',
      attachmentHashes: [],
      memberships: [],
      metadata: {},
      content: { bases: 'MKTW' },
      relationships: [],
    };
    const receipt: ProjectionReceipt = {
      id: 'receipt-1',
      runId: 'run-1',
      sourceObjectId: sourceObject.id,
      destinationObjectId: 'protein-native-1',
      destinationPath: 'Benchling Imports/Proteins/Reporter protein.faa',
      projection: 'native',
      converterId: 'native-protein',
      converterVersion: '1',
      sourceHash: 'source-hash',
      destinationHash: 'destination-hash',
      warnings: [],
      exception: null,
      createdAt: '2026-08-17T00:00:00.000Z',
    };

    expect(
      buildMigrationDestinationIndexEntries({
        sourceObjects: [sourceObject],
        receipts: [receipt],
      })
    ).toEqual([
      expect.objectContaining({
        locator: {
          kind: 'workspace_path',
          relativePath: receipt.destinationPath,
          tabType: 'protein',
        },
      }),
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import type { FolderTreeMigrationScope } from '../../shared/benchling-migration';
import { buildNestedFolderTreeNativeExportFixture } from './__fixtures__/native-export-zip-fixture';
import {
  LocalBenchlingExportHierarchyError,
  planLocalBenchlingExportHierarchy,
  type LocalBenchlingExportCanonicalItem,
} from './local-export-hierarchy';

const ROOT_ID = 'lib_WHOLE_TREE_ROOT';

describe('planLocalBenchlingExportHierarchy whole-tree contract', () => {
  it('selects every unique object and preserves every proven membership and folder edge', () => {
    const fixture = buildNestedFolderTreeNativeExportFixture();

    const plan = planLocalBenchlingExportHierarchy({
      scope: folderTreeScope(),
      canonicalItems: fixture.canonicalItems,
    });

    expect([...new Set(plan.items.map((item) => item.sourceObjectId))].sort()).toEqual(
      fixture.expectedUniqueStableIds
    );
    expect(plan.items.every((item) => item.included)).toBe(true);
    expect(plan.evidence.folders.map((folder) => folder.relativePath)).toEqual(
      fixture.expectedFolderPaths
    );
    expect(plan.evidence.folders.every((folder) => folder.included)).toBe(true);
    expect(plan.evidence.excludedChildFolders).toEqual([]);
    expect(plan.evidence.excludedChildFolderCount).toBe(0);
    expect(plan.evidence.excludedSourceObjectCount).toBe(0);
    expect(plan.evidence.selectedSourceObjectCount).toBe(fixture.expectedUniqueStableIds.length);

    const folderPathById = new Map(
      plan.evidence.folders.map((folder) => [folder.id, folder.relativePath] as const)
    );
    expect(
      plan.items
        .map(
          (item) =>
            `${item.sourceObjectId}\0${requiredFolderPath(folderPathById, item.membershipFolderId)}`
        )
        .sort()
    ).toEqual(fixture.expectedMembershipPairs);

    const grandchild = plan.evidence.folders.find(
      (folder) => folder.relativePath === fixture.expectedGrandchildPath
    );
    const parent = plan.evidence.folders.find(
      (folder) => folder.relativePath === fixture.expectedGrandchildParentPath
    );
    expect(grandchild?.parentId).toBe(parent?.id);
  });

  it('uses NFC-normalized archive-relative paths for deterministic descendant identity', () => {
    const decomposed = 'Cafe\u0301';
    const composed = 'Café';

    const first = planLocalBenchlingExportHierarchy({
      scope: folderTreeScope(),
      canonicalItems: [sequenceItem(`Selected Root/${decomposed}/DNA (seq_NORMALIZED).gb`)],
    });
    const second = planLocalBenchlingExportHierarchy({
      scope: folderTreeScope(),
      canonicalItems: [sequenceItem(`Selected Root/${composed}/DNA (seq_NORMALIZED).gb`)],
    });

    expect(first.evidence.folders[1].relativePath).toBe(`Selected Root/${composed}`);
    expect(first.evidence.folders[1].id).toBe(second.evidence.folders[1].id);
  });

  it('refuses two folder paths that normalize to the same destination identity', () => {
    expect(() =>
      planLocalBenchlingExportHierarchy({
        scope: folderTreeScope(),
        canonicalItems: [
          sequenceItem('Selected Root/Cafe\u0301/One (seq_NORMALIZED1).gb'),
          sequenceItem('Selected Root/Café/Two (seq_NORMALIZED2).gb'),
        ],
      })
    ).toThrow(/normalize to the same folder path/i);
  });

  it('refuses a ZIP that presents more than one possible selected root', () => {
    expect(() =>
      planLocalBenchlingExportHierarchy({
        scope: folderTreeScope(),
        canonicalItems: [
          sequenceItem('First Root/DNA (seq_FIRSTROOT).gb'),
          sequenceItem('Second Root/DNA (seq_SECONDROOT).gb'),
        ],
      })
    ).toThrow(/2 possible selected roots/i);
  });

  it.each([
    '../Selected Root/DNA (seq_TRAVERSAL).gb',
    'Selected Root/../DNA (seq_TRAVERSAL).gb',
    '/Selected Root/DNA (seq_ABSOLUTE).gb',
  ])('keeps the existing unsafe-path rejection pinned for %s', (canonicalPath) => {
    expect(() =>
      planLocalBenchlingExportHierarchy({
        scope: folderTreeScope(),
        canonicalItems: [sequenceItem(canonicalPath)],
      })
    ).toThrow(/not inside one selected root directory/i);
  });

  it('refuses duplicate canonical paths that claim different stable identities', () => {
    const canonicalPath = 'Selected Root/Contradiction (seq_FIRSTCLAIM).gb';
    expect(() =>
      planLocalBenchlingExportHierarchy({
        scope: folderTreeScope(),
        canonicalItems: [
          sequenceItem(canonicalPath, 'seq_FIRSTCLAIM'),
          sequenceItem(canonicalPath, 'seq_SECONDCLAIM'),
        ],
      })
    ).toThrow(/duplicate canonical object path/i);
  });

  it('refuses two canonical representations for one object in one membership folder', () => {
    expect(() =>
      planLocalBenchlingExportHierarchy({
        scope: folderTreeScope(),
        canonicalItems: [
          sequenceItem('Selected Root/Alpha/First (seq_SAME).gb', 'seq_SAME'),
          sequenceItem('Selected Root/Alpha/Second (seq_SAME).gb', 'seq_SAME'),
        ],
      })
    ).toThrow(/more than one canonical representation/i);
  });
});

function folderTreeScope(): FolderTreeMigrationScope {
  return {
    version: 1,
    kind: 'folder_tree',
    acquisition: 'local_bundle',
    roots: [
      {
        id: ROOT_ID,
        url: `https://local.dnaforge.invalid/benchling-folder/${ROOT_ID}`,
        objectType: 'folder',
      },
    ],
    includeChildren: true,
    includeArchived: false,
  };
}

function sequenceItem(
  canonicalPath: string,
  sourceObjectId = /\((seq_[A-Za-z0-9]+)\)/u.exec(canonicalPath)?.[1]
): LocalBenchlingExportCanonicalItem {
  if (!sourceObjectId) throw new Error(`Fixture path has no sequence identity: ${canonicalPath}`);
  return { canonicalPath, sourceObjectId, sourceKind: 'sequence' };
}

function requiredFolderPath(map: ReadonlyMap<string, string>, id: string): string {
  const value = map.get(id);
  if (!value) throw new Error(`Missing test folder path for ${id}.`);
  return value;
}

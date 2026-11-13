import { describe, expect, it } from 'vitest';
import {
  mergeWorkspaceSessionFiles,
  WorkspaceSessionContractError,
  type WorkspaceSessionFile,
} from './workspace-sessions';

const ORIGINAL: WorkspaceSessionFile[] = [
  {
    resourceId: 'resource-one',
    path: 'notes/readme.md',
    contentRevision: `sha256:${'1'.repeat(64)}`,
    contentSha256: '1'.repeat(64),
    sizeBytes: 12,
    contentType: 'text/markdown',
  },
  {
    resourceId: null,
    path: 'sequences/first.gbk',
    contentRevision: `sha256:${'2'.repeat(64)}`,
    contentSha256: '2'.repeat(64),
    sizeBytes: 24,
    contentType: 'application/genbank',
  },
];

describe('mergeWorkspaceSessionFiles', () => {
  it('preserves unchanged files and stable identity while replacing one placement', () => {
    const merged = mergeWorkspaceSessionFiles(ORIGINAL, [
      {
        path: 'notes/readme.md',
        contentRevision: `sha256:${'3'.repeat(64)}`,
        contentSha256: '3'.repeat(64),
        sizeBytes: 18,
        contentType: 'text/markdown',
      },
    ]);

    expect(merged).toEqual([
      {
        resourceId: 'resource-one',
        path: 'notes/readme.md',
        contentRevision: `sha256:${'3'.repeat(64)}`,
        contentSha256: '3'.repeat(64),
        sizeBytes: 18,
        contentType: 'text/markdown',
      },
      ORIGINAL[1],
    ]);
  });

  it('adds multiple files and returns deterministic UTF-8 path order', () => {
    const merged = mergeWorkspaceSessionFiles(
      [],
      [
        {
          resourceId: null,
          path: 'sequences/zeta.gbk',
          contentRevision: `sha256:${'4'.repeat(64)}`,
          contentSha256: '4'.repeat(64),
          sizeBytes: 4,
          contentType: 'application/genbank',
        },
        {
          resourceId: null,
          path: 'sequences/alpha.gbk',
          contentRevision: `sha256:${'5'.repeat(64)}`,
          contentSha256: '5'.repeat(64),
          sizeBytes: 5,
          contentType: 'application/genbank',
        },
      ]
    );

    expect(merged.map((file) => file.path)).toEqual(['sequences/alpha.gbk', 'sequences/zeta.gbk']);
  });

  it('rejects case-insensitive path collisions instead of publishing ambiguous placements', () => {
    expect(() =>
      mergeWorkspaceSessionFiles(ORIGINAL, [
        {
          resourceId: null,
          path: 'Sequences/FIRST.gbk',
          contentRevision: `sha256:${'6'.repeat(64)}`,
          contentSha256: '6'.repeat(64),
          sizeBytes: 6,
          contentType: 'application/genbank',
        },
      ])
    ).toThrowError(
      expect.objectContaining<Partial<WorkspaceSessionContractError>>({ code: 'PATH_COLLISION' })
    );
  });

  it('omits removed placements so a rename does not keep the old path', () => {
    const merged = mergeWorkspaceSessionFiles(
      ORIGINAL,
      [
        {
          resourceId: ORIGINAL[1].resourceId,
          path: 'sequences/renamed.gbk',
          contentRevision: ORIGINAL[1].contentRevision,
          contentSha256: ORIGINAL[1].contentSha256,
          sizeBytes: ORIGINAL[1].sizeBytes,
          contentType: ORIGINAL[1].contentType,
        },
      ],
      { removePaths: ['sequences/first.gbk'] }
    );

    expect(merged.map((file) => file.path)).toEqual(['notes/readme.md', 'sequences/renamed.gbk']);
    expect(merged.find((file) => file.path === 'sequences/renamed.gbk')?.resourceId).toBe(
      ORIGINAL[1].resourceId
    );
  });

  it.each(['../outside.gbk', '/absolute.gbk', 'folder\\escape.gbk', 'folder//empty.gbk'])(
    'rejects unsafe placement %s',
    (path) => {
      expect(() =>
        mergeWorkspaceSessionFiles(
          [],
          [
            {
              resourceId: null,
              path,
              contentRevision: `sha256:${'7'.repeat(64)}`,
              contentSha256: '7'.repeat(64),
              sizeBytes: 7,
              contentType: 'application/genbank',
            },
          ]
        )
      ).toThrowError(
        expect.objectContaining<Partial<WorkspaceSessionContractError>>({ code: 'UNSAFE_PATH' })
      );
    }
  );
});

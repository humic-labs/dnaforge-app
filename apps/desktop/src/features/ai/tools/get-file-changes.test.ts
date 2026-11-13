   
                                                                                  
  
                                                                                
                                                                                  
                                                               
   
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFileChangesOutputSchema, createGetFileChangesTool as uncheckedcreateGetFileChangesTool } from './get-file-changes';
import { execTool } from './test-helpers';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';

                                                                                           
vi.mock('../../workspace/git', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  gitStatus: vi.fn().mockResolvedValue(
    new Map([
      ['src/app.ts', 'modified'],
      ['src/new.ts', 'added'],
    ])
  ),
  gitLog: vi.fn().mockResolvedValue('abc1234 Fix the thing\ndef5678 Add feature\n'),
  gitDiffStat: vi.fn().mockResolvedValue(
    ' src/app.ts | 10 ++++------\n src/new.ts | 5 +++++\n 2 files changed, 9 insertions(+), 6 deletions(-)\n'
  ),
}));

const folders: WorkspaceFolder[] = [
  { path: '/workspace/project', name: 'project', addedAt: 0 },
];

describe('get_file_changes output shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recentCommits is an array of {hash, subject}, not a raw string', async () => {
    const tool = createGetFileChangesTool(folders);
    const result = await execTool<{
      recentCommits?: unknown;
      changedFiles?: unknown[];
    }>(tool, { includeLog: true, includeDiff: false });

    expect(result.recentCommits).toBeDefined();
    expect(Array.isArray(result.recentCommits)).toBe(true);

    const commits = result.recentCommits as Array<{ hash: string; subject: string }>;
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toHaveProperty('hash');
    expect(commits[0]).toHaveProperty('subject');
    expect(commits[0].hash).toBe('abc1234');
    expect(commits[0].subject).toBe('Fix the thing');
  });

  it('diffStat is a structured object, not a raw string', async () => {
    const tool = createGetFileChangesTool(folders);
    const result = await execTool<{
      diffStat?: unknown;
    }>(tool, { includeLog: false, includeDiff: true });

    expect(result.diffStat).toBeDefined();
    expect(typeof result.diffStat).toBe('object');

    const stat = result.diffStat as { filesChanged: number; additions: number; deletions: number };
    expect(stat.filesChanged).toBe(2);
    expect(stat.additions).toBe(9);
    expect(stat.deletions).toBe(6);
  });

  it('changedFiles is an array of {path, status}', async () => {
    const tool = createGetFileChangesTool(folders);
    const result = await execTool<{
      changedFiles?: Array<{ path: string; status: string }>;
    }>(tool, {});

    expect(Array.isArray(result.changedFiles)).toBe(true);
    expect(result.changedFiles!.length).toBeGreaterThan(0);
    expect(result.changedFiles![0]).toHaveProperty('path');
    expect(result.changedFiles![0]).toHaveProperty('status');
  });

  it('refuses duplicate project display names instead of inspecting the first', async () => {
    const duplicateNames: WorkspaceFolder[] = [
      { path: '/projects/first', name: 'Shared', addedAt: 1 },
      { path: '/projects/second', name: 'Shared', addedAt: 2 },
    ];
    const result = await execTool<{ error?: string; tracked?: boolean }>(
      createGetFileChangesTool(duplicateNames),
      { folder: 'Shared' }
    );

    expect(result).toMatchObject({
      ok: false, code: 'PROJECT_NOT_FOUND', stateChanged: false, retriable: false, partialEffects: [],
      error:
        'Project "Shared" was not found or is ambiguous. Available projects: "Shared", "Shared"',
      tracked: false,
    });
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const createGetFileChangesTool = checkedToolFactory(uncheckedcreateGetFileChangesTool, getFileChangesOutputSchema);

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({ stat: vi.fn() }));

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: fsMock }),
}));

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  createPrepareManagedAlignmentIndexTool as originalCreatePrepareManagedAlignmentIndexTool,
  projectManagedAlignmentIndexPreparation,
} from './alignment-index-operation';
import { checkedSequenceToolFactory as checkedToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { operationsAlignmentIndexPreparationStartOutputSchema } from './operation-output-schemas';
const createPrepareManagedAlignmentIndexTool = checkedToolFactory(
  originalCreatePrepareManagedAlignmentIndexTool,
  operationsAlignmentIndexPreparationStartOutputSchema
);

import { execTool } from './test-helpers';

const folders: WorkspaceFolder[] = [{ path: '/workspace', name: 'Project', addedAt: 1 }];

function fileStat(canonicalPath: string) {
  return {
    canonicalPath,
    size: 1234,
    isFile: true,
    isDirectory: false,
    mtime: 10_000,
    ctime: 20_000,
    mtimeNs: '10000000000',
    ctimeNs: '20000000000',
  };
}

function directoryStat(canonicalPath: string) {
  return {
    ...fileStat(canonicalPath),
    size: 0,
    isFile: false,
    isDirectory: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('managed alignment-index agent preparation', () => {
  it('resolves an ordinary alignment file inside an open workspace', async () => {
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/workspace/reads/sample.bam'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    const result = await execTool<Record<string, unknown>>(
      createPrepareManagedAlignmentIndexTool(folders),
      { path: 'reads/sample.bam' }
    );

    expect(result).toMatchObject({
      ok: true,
      input: { bamPath: '/workspace/reads/sample.bam' },
    });
  });

  it('refuses a symlink whose canonical target escaped the open workspace', async () => {
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/private/secret/sample.bam'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    const result = await execTool<{ error?: string }>(
      createPrepareManagedAlignmentIndexTool(folders),
      { path: 'reads/sample.bam' }
    );

    expect(result.error).toMatch(/escaped its open project boundary/i);
    expect(result).toMatchObject({
      ok: false,
      code: 'ALIGNMENT_SOURCE_OUTSIDE_WORKSPACE',
      stateChanged: false,
      partialEffects: [],
    });
  });

  it('keeps private paths out of the renderer audit projection', () => {
    const prepared = {
      ok: true,
      input: { bamPath: '/workspace/reads/sample.bam' },
    };

    expect(projectManagedAlignmentIndexPreparation(prepared)).toEqual({
      input: { basename: 'sample.bam' },
    });
    expect(JSON.stringify(projectManagedAlignmentIndexPreparation(prepared))).not.toContain(
      '/workspace'
    );
  });
});

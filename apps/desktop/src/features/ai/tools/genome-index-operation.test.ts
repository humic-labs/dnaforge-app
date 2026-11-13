import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({ stat: vi.fn() }));

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: fsMock }),
}));

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool } from './test-helpers';
import {
  createPrepareManagedGenomeIndexTool as originalCreatePrepareManagedGenomeIndexTool,
  projectManagedGenomeIndexPreparation,
} from './genome-index-operation';
import { checkedSequenceToolFactory as checkedToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { operationsGenomeIndexingStartOutputSchema } from './operation-output-schemas';
const createPrepareManagedGenomeIndexTool = checkedToolFactory(
  originalCreatePrepareManagedGenomeIndexTool,
  operationsGenomeIndexingStartOutputSchema
);

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
    canonicalPath,
    size: 0,
    isFile: false,
    isDirectory: true,
    mtime: 10_000,
    ctime: 20_000,
    mtimeNs: '10000000000',
    ctimeNs: '20000000000',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('managed genome-index agent preparation', () => {
  it('turns an open-workspace source into the same private index request the app uses', async () => {
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/workspace/reference.gbff'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    const result = await execTool<Record<string, unknown>>(
      createPrepareManagedGenomeIndexTool(folders),
      { path: 'reference.gbff' }
    );

    expect(result).toMatchObject({
      ok: true,
      input: {
        input: '/workspace/reference.gbff',
        name: 'reference',
        workspaceRoot: '/workspace',
      },
    });
    expect((result.input as { outputDir: string }).outputDir).toMatch(
      /^\/workspace\/\.waypoint\/genome-index\/reference-/
    );
  });

  it('refuses a symlink whose canonical target escaped the open workspace', async () => {
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/private/secret/reference.gbff'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    const result = await execTool<{ error?: string }>(
      createPrepareManagedGenomeIndexTool(folders),
      { path: 'reference.gbff' }
    );

    expect(result.error).toMatch(/escaped its open project boundary/i);
    expect(result).toMatchObject({
      ok: false,
      code: 'GENOME_SOURCE_OUTSIDE_WORKSPACE',
      stateChanged: false,
      partialEffects: [],
    });
  });

  it('keeps private paths out of the renderer audit projection', () => {
    const prepared = {
      ok: true,
      input: {
        input: '/workspace/reference.gbff',
        outputDir: '/workspace/.waypoint/genome-index/reference-v1',
        name: 'reference',
        workspaceRoot: '/workspace',
      },
    };

    expect(projectManagedGenomeIndexPreparation(prepared)).toEqual({
      input: { name: 'reference' },
    });
    expect(JSON.stringify(projectManagedGenomeIndexPreparation(prepared))).not.toContain(
      '/workspace'
    );
  });
});

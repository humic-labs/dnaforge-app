import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({ stat: vi.fn() }));

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: fsMock }),
}));

import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import { execTool, resetCanvasStore } from './test-helpers';
import {
  createPrepareManagedVariantSourceTool as originalCreatePrepareManagedVariantSourceTool,
  managedVariantSourceStartSchema,
  projectManagedVariantSourcePreparation,
} from './variant-source-operation';
import { checkedSequenceToolFactory as checkedToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { operationsVariantSourcePreparationStartOutputSchema } from './operation-output-schemas';
const createPrepareManagedVariantSourceTool = checkedToolFactory(
  originalCreatePrepareManagedVariantSourceTool,
  operationsVariantSourcePreparationStartOutputSchema
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
  return { ...fileStat(canonicalPath), size: 0, isFile: false, isDirectory: true };
}

function mountAssembly(length = 100): void {
  useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: `assembly:grch38:${length}`,
    sequenceDocument: { kind: 'indexed-sequence', documentId: `assembly:grch38:${length}` },
    label: 'GRCh38',
    indexedGenome: {
      sourcePath: '/references/grch38.fa',
      sourceExt: '.fa',
      chrom: 'chr1',
      assembly: {
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        chromosomes: [
          {
            chrom: 'chr1',
            displayName: 'chr1',
            length,
            manifest: { chrom: 'chr1', fastaPath: 'chr1.fa', faiPath: 'chr1.fa.fai' },
          },
        ],
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCanvasStore();
});

describe('managed variant-source agent preparation', () => {
  it('resolves a workspace path and mounted assembly into the public operation input', async () => {
    mountAssembly();
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/workspace/data/calls.vcf'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    const result = await execTool<Record<string, unknown>>(
      createPrepareManagedVariantSourceTool(folders),
      { assemblyId: 'grch38', path: 'data/calls.vcf' }
    );

    expect(result).toEqual({
      ok: true,
      assemblyId: 'grch38',
      input: {
        variantPath: '/workspace/data/calls.vcf',
        references: [{ name: 'chr1', length: 100 }],
      },
    });
  });

  it('fails closed when matching mounted assemblies disagree', async () => {
    mountAssembly(100);
    mountAssembly(200);
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/workspace/data/calls.vcf'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    expect(
      await execTool(createPrepareManagedVariantSourceTool(folders), {
        assemblyId: 'grch38',
        path: 'data/calls.vcf',
      })
    ).toMatchObject({ ok: false, code: 'VARIANT_ASSEMBLY_AMBIGUOUS' });
  });

  it('refuses a canonical path outside the open workspace', async () => {
    mountAssembly();
    fsMock.stat
      .mockResolvedValueOnce(fileStat('/private/calls.vcf'))
      .mockResolvedValueOnce(directoryStat('/workspace'));

    expect(
      await execTool(createPrepareManagedVariantSourceTool(folders), {
        assemblyId: 'grch38',
        path: 'data/calls.vcf',
      })
    ).toMatchObject({ ok: false, code: 'VARIANT_SOURCE_OUTSIDE_WORKSPACE' });
  });

  it('keeps private paths and reference names out of the audit projection', () => {
    const projection = projectManagedVariantSourcePreparation({
      ok: true,
      assemblyId: 'grch38',
      input: {
        variantPath: '/private/project/calls.vcf',
        references: [{ name: 'private-contig', length: 100 }],
      },
    });

    expect(projection).toEqual({
      assemblyId: 'grch38',
      pathBasename: 'calls.vcf',
      referenceCount: 1,
    });
    expect(JSON.stringify(projection)).not.toContain('/private');
    expect(JSON.stringify(projection)).not.toContain('private-contig');
    expect(
      managedVariantSourceStartSchema.safeParse({
        assemblyId: 'grch38',
        path: 'data/calls.vcf',
        references: [],
      }).success
    ).toBe(false);
  });
});

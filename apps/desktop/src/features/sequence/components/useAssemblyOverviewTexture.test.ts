import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GenomeAssembly } from '@waypoint/genome-data';
import {
  assemblyOverviewTextureReadRequestForAssembly,
  useAssemblyOverviewTexture,
} from './useAssemblyOverviewTexture';

const { mockReadAssemblyOverviewTexture } = vi.hoisted(() => ({
  mockReadAssemblyOverviewTexture: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genome: {
      readAssemblyOverviewTexture: mockReadAssemblyOverviewTexture,
    },
  }),
}));

function assemblyFixture(): GenomeAssembly {
  return {
    assemblyId: 'test-assembly',
    displayName: 'Test Assembly',
    chromosomes: [
      {
        chrom: 'chr2',
        displayName: 'chr2',
        length: 200,
        manifest: {
          chrom: 'chr2',
          fastaPath: '/w/chr2.fa',
          faiPath: '/w/chr2.fa.fai',
          gffPath: '/w/chr2.gff3.gz',
          tbiPath: '/w/chr2.gff3.gz.tbi',
          length: 200,
        },
      },
      {
        chrom: 'chrM',
        displayName: 'chrM',
        length: 10,
        manifest: {
          chrom: 'chrM',
          fastaPath: '/w/chrM.fa',
          faiPath: '/w/chrM.fa.fai',
          length: 10,
        },
      },
      {
        chrom: 'chr1',
        displayName: 'chr1',
        length: 100,
        manifest: {
          chrom: 'chr1',
          fastaPath: '/w/chr1.fa',
          faiPath: '/w/chr1.fa.fai',
          gffPath: '/w/chr1.gff3.gz',
          tbiPath: '/w/chr1.gff3.gz.tbi',
          length: 100,
        },
      },
    ],
  };
}

describe('assemblyOverviewTextureReadRequestForAssembly', () => {
  it('builds the read/write cache request from the full assembly placement', () => {
    expect(assemblyOverviewTextureReadRequestForAssembly(assemblyFixture(), '/workspace')).toEqual({
      assemblyId: 'test-assembly',
      workspaceRoot: '/workspace',
      chromosomes: [
        {
          chrom: 'chr2',
          sourcePath: '/w/chr2.gff3.gz',
          manifest: assemblyFixture().chromosomes[0].manifest,
          length: 200,
        },
        { chrom: 'chrM', sourcePath: null, manifest: null, length: 10 },
        {
          chrom: 'chr1',
          sourcePath: '/w/chr1.gff3.gz',
          manifest: assemblyFixture().chromosomes[2].manifest,
          length: 100,
        },
      ],
    });
  });

  it('returns null until both assembly and workspace root are available', () => {
    expect(assemblyOverviewTextureReadRequestForAssembly(undefined, '/workspace')).toBeNull();
    expect(assemblyOverviewTextureReadRequestForAssembly(assemblyFixture(), null)).toBeNull();
  });

  it('returns null when no chromosomes have an indexed annotation source', () => {
    expect(
      assemblyOverviewTextureReadRequestForAssembly(
        {
          ...assemblyFixture(),
          chromosomes: assemblyFixture().chromosomes.map((c) => ({
            ...c,
            manifest: { ...c.manifest, gffPath: undefined },
          })),
        },
        '/workspace'
      )
    ).toBeNull();
  });
});

describe('useAssemblyOverviewTexture', () => {
  it('reports an assembly texture cache miss as an explicit required-overview failure state', async () => {
    mockReadAssemblyOverviewTexture.mockResolvedValueOnce(null);
    const assembly = assemblyFixture();

    const { result } = renderHook(() => useAssemblyOverviewTexture(assembly, '/workspace'));

    await waitFor(() => {
      expect(result.current.status).toBe('miss');
    });

    expect(result.current.texture).toBeNull();
    expect(result.current.request?.chromosomes.map((c) => c.chrom)).toEqual([
      'chr2',
      'chrM',
      'chr1',
    ]);
    expect(mockReadAssemblyOverviewTexture).toHaveBeenCalledOnce();
  });
});

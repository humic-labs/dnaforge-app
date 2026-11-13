// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildIndexedGenomePaths,
  CURRENT_INDEXED_GENOME_SCHEMA,
  extensionForPath,
  safeIndexedGenomeName,
} from './indexed-genome-paths';

describe('indexed genome path helpers', () => {
  it('derives a stable chromosome name from real-world human chromosome filenames', () => {
    expect(safeIndexedGenomeName('/Users/me/Downloads/chr11.gbff')).toBe('chr11');
    expect(safeIndexedGenomeName('/Users/me/Downloads/chr22.fasta')).toBe('chr22');
  });

  it('extracts extensions used by NCBI FASTA and complete GenBank flat files', () => {
    expect(extensionForPath('/Users/me/Downloads/chr1.gbff')).toBe('gbff');
    expect(extensionForPath('/workspace/genomes/chr11.fna')).toBe('fna');
  });

  it('strips a `.gz` suffix when the inner extension is a recognized biology format', () => {
    expect(extensionForPath('/workspace/genomes/chr1.gff3.gz')).toBe('gff3');
    expect(extensionForPath('/workspace/genomes/chr11.gff.gz')).toBe('gff');
    expect(extensionForPath('/workspace/genomes/chr22.fa.gz')).toBe('fa');
    expect(extensionForPath('/workspace/genomes/chrX.gbff.gz')).toBe('gbff');
  });

  it('drops compound `.gff3.gz` / `.fa.gz` extensions from chromosome names', () => {
    expect(safeIndexedGenomeName('/workspace/genomes/chr22.gff3.gz')).toBe('chr22');
    expect(safeIndexedGenomeName('/workspace/genomes/chr1.fa.gz')).toBe('chr1');
    expect(safeIndexedGenomeName('/workspace/genomes/chrX.gbff.gz')).toBe('chrX');
    expect(safeIndexedGenomeName('/workspace/genomes/chr22.gff3')).toBe('chr22');
  });

  it('routes a `.gff3.gz` source path to annotation-bearing index bundle paths', () => {
    const paths = buildIndexedGenomePaths({
      sourcePath: '/workspace/genomes/chr22.gff3.gz',
      workspaceRoot: '/workspace',
      sizeBytes: 10 * 1024 * 1024,
    });
    expect(paths.manifest.gffPath).not.toBeNull();
    expect(paths.manifest.tbiPath).not.toBeNull();
  });

  it('builds a workspace-contained index bundle path', () => {
    const paths = buildIndexedGenomePaths({
      sourcePath: '/Users/me/Downloads/chr11.gbff',
      workspaceRoot: '/Users/scientist/projects/waypoint',
      sizeBytes: 203 * 1024 * 1024,
    });

    expect(paths.chrom).toBe('chr11');
    expect(paths.outputDir).toContain('/.waypoint/genome-index/chr11-');
    expect(paths.manifest.fastaPath).toBe(`${paths.outputDir}/chr11.fa.gz`);
    expect(paths.manifest.faiPath).toBe(`${paths.outputDir}/chr11.fa.gz.fai`);
    expect(paths.manifest.gziPath).toBe(`${paths.outputDir}/chr11.fa.gz.gzi`);
    expect(paths.manifest.gffPath).toBe(`${paths.outputDir}/chr11.gff3.gz`);
    expect(paths.manifest.tbiPath).toBe(`${paths.outputDir}/chr11.gff3.gz.tbi`);
    expect(paths.metadataPath).toBe(`${paths.outputDir}/chr11.waypoint-index.json`);
    expect(CURRENT_INDEXED_GENOME_SCHEMA).toBe(5);
  });

  it('uses source ctime in the index path so same-size rewrites cannot reuse stale bundles', () => {
    const first = buildIndexedGenomePaths({
      sourcePath: '/workspace/genomes/chr11.gbff',
      workspaceRoot: '/workspace',
      sizeBytes: 212_946_313,
      sourceMtimeMs: 10_000,
      sourceCtimeMs: 20_000,
    });
    const rewrittenSameSizeAndMtime = buildIndexedGenomePaths({
      sourcePath: '/workspace/genomes/chr11.gbff',
      workspaceRoot: '/workspace',
      sizeBytes: 212_946_313,
      sourceMtimeMs: 10_000,
      sourceCtimeMs: 30_000,
    });

    expect(first.outputDir).toBe('/workspace/.waypoint/genome-index/chr11-7ve06m');
    expect(rewrittenSameSizeAndMtime.outputDir).not.toBe(first.outputDir);
  });
});

import { describe, expect, it } from 'vitest';

import { puc19IndexedManifest } from '@waypoint/genome-data/test-support';
import {
  InMemoryGenomeDataSource,
  type GenomeFeature,
  type IndexedGenomeManifest,
} from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';

import { materializeGenomeDataSourceRange } from './data-source-adapter';
import { genomeFeatures, type Feature } from './types';

const PUC19_LENGTH = 2686;

function structural(f: Feature) {
  return {
    type: f.type,
    start: f.start,
    end: f.end,
    direction: f.direction,
    displayName: f.displayName,
  };
}

function byStart(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start - b.start || a.end - b.end;
}

async function collectAllFeatures(
  source: LocalIndexedGenomeDataSource,
  manifest: IndexedGenomeManifest
): Promise<GenomeFeature[]> {
  const length = await source.getChromosomeLength(manifest.chrom);
  return source.getFeatures(manifest.chrom, 0, length, 1);
}

describe('cross-source identity (Indexed ↔ InMemory) on real fixtures', () => {
  it('round-trips pUC19 feature set: indexed → InMemory → materialize matches indexed → materialize', async () => {
    const manifest = puc19IndexedManifest();
    const indexed = new LocalIndexedGenomeDataSource(manifest);
    const allFeatures = await collectAllFeatures(indexed, manifest);
    const length = await indexed.getChromosomeLength(manifest.chrom);
    expect(length).toBe(PUC19_LENGTH);

    const fullSequence = await indexed.getSequence(manifest.chrom, 0, length);
    const inMemory = new InMemoryGenomeDataSource({
      chrom: manifest.chrom,
      sequence: fullSequence,
      features: allFeatures,
    });

    const ranges: Array<[number, number]> = [
      [0, length],
      [0, 1000],
      [600, 1000],
      [1500, 2000],
      [2000, 2686],
    ];

    for (const [start, end] of ranges) {
      const fromIndexed = await materializeGenomeDataSourceRange({
        source: indexed,
        chrom: manifest.chrom,
        start,
        end,
        zoomLevel: 1,
        circular: true,
      });
      const fromMemory = await materializeGenomeDataSourceRange({
        source: inMemory,
        chrom: manifest.chrom,
        start,
        end,
        zoomLevel: 1,
        circular: true,
      });

      expect(fromMemory.range, `range ${start}-${end}`).toEqual(fromIndexed.range);
      expect(fromMemory.genome.length).toBe(fromIndexed.genome.length);
      expect(fromMemory.genome.circular).toBe(fromIndexed.genome.circular);

      const indexedStructural = genomeFeatures(fromIndexed.genome).map(structural).sort(byStart);
      const memoryStructural = genomeFeatures(fromMemory.genome).map(structural).sort(byStart);
      expect(memoryStructural, `range ${start}-${end} feature set`).toEqual(indexedStructural);
    }
  });

  it('a sequence read from both sources at multiple offsets is byte-identical', async () => {
    const manifest = puc19IndexedManifest();
    const indexed = new LocalIndexedGenomeDataSource(manifest);
    const length = await indexed.getChromosomeLength(manifest.chrom);
    const allFeatures = await collectAllFeatures(indexed, manifest);
    const fullSequence = await indexed.getSequence(manifest.chrom, 0, length);
    const inMemory = new InMemoryGenomeDataSource({
      chrom: manifest.chrom,
      sequence: fullSequence,
      features: allFeatures,
    });

    const offsets = [0, 100, 1000, 2500, 2680];
    const windowSize = 50;
    for (const offset of offsets) {
      const end = Math.min(length, offset + windowSize);
      const aSeq = await indexed.getSequence(manifest.chrom, offset, end);
      const bSeq = await inMemory.getSequence(manifest.chrom, offset, end);
      expect(bSeq, `seq window @${offset}`).toBe(aSeq);
    }
  });

  it('feature lane assignments are deterministic across the two sources', async () => {
    const manifest = puc19IndexedManifest();
    const indexed = new LocalIndexedGenomeDataSource(manifest);
    const length = await indexed.getChromosomeLength(manifest.chrom);
    const allFeatures = await collectAllFeatures(indexed, manifest);
    const fullSequence = await indexed.getSequence(manifest.chrom, 0, length);
    const inMemory = new InMemoryGenomeDataSource({
      chrom: manifest.chrom,
      sequence: fullSequence,
      features: allFeatures,
    });

    const fromIndexed = await materializeGenomeDataSourceRange({
      source: indexed,
      chrom: manifest.chrom,
      start: 0,
      end: length,
      zoomLevel: 1,
    });
    const fromMemory = await materializeGenomeDataSourceRange({
      source: inMemory,
      chrom: manifest.chrom,
      start: 0,
      end: length,
      zoomLevel: 1,
    });

    const indexedLanes = genomeFeatures(fromIndexed.genome)
      .map((f) => ({ ...structural(f), lane: f.lane }))
      .sort(byStart);
    const memoryLanes = genomeFeatures(fromMemory.genome)
      .map((f) => ({ ...structural(f), lane: f.lane }))
      .sort(byStart);
    expect(memoryLanes).toEqual(indexedLanes);
  });
});

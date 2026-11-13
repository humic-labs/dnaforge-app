import { describe, expect, it } from 'vitest';
import type { GenomeDataSource, GenomeFeature, SearchHit } from '@waypoint/genome-data';
import { InMemoryGenomeDataSource } from '@waypoint/genome-data';

import {
  materializeGenomeDataSourceRange,
  rendererGenomeToInMemoryManifest,
} from './data-source-adapter';
import { genomeFeatures, type Feature, type Genome } from './types';

class FakeGenomeDataSource implements GenomeDataSource {
  readonly featureQueries: Array<{
    chrom: string;
    start: number;
    end: number;
    zoomLevel: number;
  }> = [];
  readonly sequenceQueries: Array<{ chrom: string; start: number; end: number }> = [];

  constructor(
    private readonly length: number,
    private readonly features: GenomeFeature[]
  ) {}

  async getChromosomeLength(): Promise<number> {
    return this.length;
  }

  async getSequence(chrom: string, start: number, end: number): Promise<string> {
    this.sequenceQueries.push({ chrom, start, end });
    return 'N'.repeat(Math.max(0, end - start));
  }

  async getFeatures(
    chrom: string,
    start: number,
    end: number,
    zoomLevel: number
  ): Promise<GenomeFeature[]> {
    this.featureQueries.push({ chrom, start, end, zoomLevel });
    return this.features.filter(
      (feature) => feature.chrom === chrom && feature.end > start && feature.start < end
    );
  }

  searchSequence(): AsyncIterable<SearchHit> {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SearchHit>> {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}

function feature(partial: Partial<GenomeFeature> & Pick<GenomeFeature, 'start' | 'end'>) {
  return {
    chrom: partial.chrom ?? 'chrIV',
    source: partial.source ?? 'fixture',
    type: partial.type ?? 'gene',
    start: partial.start,
    end: partial.end,
    score: partial.score ?? null,
    strand: partial.strand ?? '+',
    phase: partial.phase ?? null,
    attributes: partial.attributes ?? {},
    raw: partial.raw ?? 'chrIV\tfixture\tgene\t1\t10\t.\t+\t.\tID=f1',
    ...(partial.fileOffset !== undefined ? { fileOffset: partial.fileOffset } : {}),
  };
}

describe('GenomeDataSource renderer adapter', () => {
  it('materializes an annotation-only genome shell from one visible feature range', async () => {
    const source = new FakeGenomeDataSource(1_000_000, [
      feature({
        type: 'gene',
        start: 49_800,
        end: 50_200,
        strand: '+',
        attributes: { Name: ['HXT15'], gene: ['HXT15'] },
        fileOffset: 100,
      }),
      feature({
        type: 'CDS',
        start: 50_250,
        end: 50_900,
        strand: '-',
        attributes: { product: ['hexose transporter'] },
        fileOffset: 200,
      }),
      feature({
        type: 'promoter',
        start: 75_000,
        end: 75_120,
        strand: '.',
        attributes: { Name: ['outside viewport'] },
        fileOffset: 300,
      }),
    ]);

    const snapshot = await materializeGenomeDataSourceRange({
      source,
      chrom: 'chrIV',
      start: 50_000,
      end: 51_000,
      zoomLevel: 8,
      name: 'chrIV indexed',
      circular: false,
    });

    expect(source.featureQueries).toEqual([
      { chrom: 'chrIV', start: 50_000, end: 51_000, zoomLevel: 8 },
    ]);
    expect(source.sequenceQueries).toEqual([]);
    expect(snapshot.range).toEqual([50_000, 51_000]);
    expect(snapshot.genome).toMatchObject({
      name: 'chrIV indexed',
      length: 1_000_000,
      circular: false,
      sequence: undefined,
    });
    expect(snapshot.genome.features).toEqual([
      expect.objectContaining({
        type: 'gene',
        start: 49_800,
        end: 50_200,
        direction: 'forward',
        displayName: 'HXT15',
        color: 0x3b82f6,
        lane: 0,
        qualifiers: expect.objectContaining({ Name: 'HXT15', gene: 'HXT15' }),
      }),
      expect.objectContaining({
        type: 'CDS',
        start: 50_250,
        end: 50_900,
        direction: 'reverse',
        displayName: 'hexose transporter',
        color: 0x3b82f6,
        lane: 0,
      }),
    ]);
  });

  it('assigns stable renderer ids for the same indexed feature across overlapping ranges', async () => {
    const indexedFeature = feature({
      type: 'gene',
      start: 100,
      end: 220,
      attributes: { ID: ['gene-stable'] },
      fileOffset: 42,
    });
    const source = new FakeGenomeDataSource(1_000, [indexedFeature]);

    const first = await materializeGenomeDataSourceRange({
      source,
      chrom: 'chrIV',
      start: 90,
      end: 180,
      zoomLevel: 1,
    });
    const second = await materializeGenomeDataSourceRange({
      source,
      chrom: 'chrIV',
      start: 120,
      end: 260,
      zoomLevel: 1,
    });

    expect(genomeFeatures(first.genome)).toHaveLength(1);
    expect(genomeFeatures(second.genome)).toHaveLength(1);
    expect(genomeFeatures(first.genome)[0].id).toBe(genomeFeatures(second.genome)[0].id);
    expect(genomeFeatures(first.genome)[0].id).toBeLessThan(1_000_000_000);
  });

  it('keeps overlapping visible features on separate lanes', async () => {
    const source = new FakeGenomeDataSource(1_000, [
      feature({ start: 100, end: 220, attributes: { ID: ['a'] } }),
      feature({ start: 150, end: 260, attributes: { ID: ['b'] } }),
      feature({ start: 300, end: 360, attributes: { ID: ['c'] } }),
    ]);

    const snapshot = await materializeGenomeDataSourceRange({
      source,
      chrom: 'chrIV',
      start: 0,
      end: 400,
      zoomLevel: 1,
    });

    expect(genomeFeatures(snapshot.genome).map((f) => f.lane)).toEqual([0, 1, 0]);
  });
});

describe('rendererGenomeToInMemoryManifest', () => {
  function rendererFeature(partial: Partial<Feature> & Pick<Feature, 'start' | 'end'>): Feature {
    return {
      id: partial.id ?? 0,
      type: partial.type ?? 'gene',
      start: partial.start,
      end: partial.end,
      direction: partial.direction ?? 'forward',
      displayName: partial.displayName ?? 'feat',
      color: partial.color ?? 0x3b82f6,
      lane: partial.lane ?? 0,
      qualifiers: partial.qualifiers,
    };
  }

  it('translates a renderer Genome into a single-chromosome InMemoryGenomeManifest', () => {
    const genome: Genome = {
      name: 'chrI',
      length: 1000,
      circular: false,
      sequence: 'ACGT'.repeat(250),
      features: [
        rendererFeature({
          start: 100,
          end: 200,
          type: 'CDS',
          direction: 'forward',
          displayName: 'lacZ',
          qualifiers: { gene: 'lacZ', product: 'beta-galactosidase' },
        }),
        rendererFeature({
          start: 300,
          end: 350,
          type: 'promoter',
          direction: 'reverse',
          displayName: 'pTrc',
        }),
      ],
    };
    const manifest = rendererGenomeToInMemoryManifest(genome);
    expect(manifest.chrom).toBe('chrI');
    expect(manifest.sequence).toBe(genome.sequence);
    expect(manifest.circular).toBe(false);
    expect(manifest.features).toHaveLength(2);
    expect(manifest.features[0]).toMatchObject({
      chrom: 'chrI',
      source: 'renderer',
      type: 'CDS',
      start: 100,
      end: 200,
      strand: '+',
      attributes: expect.objectContaining({
        gene: ['lacZ'],
        product: ['beta-galactosidase'],
      }),
    });
    expect(manifest.features[1]).toMatchObject({
      type: 'promoter',
      strand: '-',
      attributes: expect.objectContaining({ Name: ['pTrc'] }),
    });
  });

  it('handles a renderer Genome with no qualifiers and a default name', () => {
    const genome: Genome = {
      name: '',
      length: 100,
      circular: false,
      features: [rendererFeature({ start: 0, end: 30, displayName: 'gene', type: 'gene' })],
    };
    const manifest = rendererGenomeToInMemoryManifest(genome);
    expect(manifest.chrom).toBe('sequence');
    expect(manifest.features[0].attributes).toEqual({});
  });
});

describe('cross-source identity (InMemory ↔ Indexed via materialize)', () => {
  it('roundtrips structural feature identity through InMemoryGenomeDataSource', async () => {
    const original: Genome = {
      name: 'chrI',
      length: 5000,
      circular: false,
      sequence: 'ACGT'.repeat(1250),
      features: [
        {
          id: 1,
          type: 'CDS',
          start: 100,
          end: 250,
          direction: 'forward',
          displayName: 'cdsA',
          color: 0x3b82f6,
          lane: 0,
          qualifiers: { gene: 'cdsA' },
        },
        {
          id: 2,
          type: 'CDS',
          start: 200,
          end: 400,
          direction: 'reverse',
          displayName: 'cdsB',
          color: 0x3b82f6,
          lane: 1,
          qualifiers: { gene: 'cdsB' },
        },
        {
          id: 3,
          type: 'promoter',
          start: 50,
          end: 100,
          direction: 'forward',
          displayName: 'pTrc',
          color: 0x22c55e,
          lane: 0,
        },
      ],
    };

    const manifest = rendererGenomeToInMemoryManifest(original);
    const source = new InMemoryGenomeDataSource(manifest);
    const materialized = await materializeGenomeDataSourceRange({
      source,
      chrom: 'chrI',
      start: 0,
      end: original.length,
      zoomLevel: 1,
      name: original.name,
      circular: original.circular,
    });

    expect(materialized.genome.length).toBe(original.length);
    expect(materialized.genome.circular).toBe(false);

    const structural = (f: Feature) => ({
      type: f.type,
      start: f.start,
      end: f.end,
      direction: f.direction,
      displayName: f.displayName,
    });
    expect(genomeFeatures(materialized.genome).map(structural).sort(byStart)).toEqual(
      genomeFeatures(original).map(structural).sort(byStart)
    );
  });

  it('two InMemoryGenomeDataSources built from the same input materialize identically', async () => {
    const features: GenomeFeature[] = [
      {
        chrom: 'chrI',
        source: 'fixture',
        type: 'CDS',
        start: 100,
        end: 250,
        score: null,
        strand: '+',
        phase: null,
        attributes: { gene: ['cdsA'], ID: ['cds-1'] },
        raw: 'chrI\tfixture\tCDS\t101\t250\t.\t+\t.\tID=cds-1;gene=cdsA',
        fileOffset: 100,
      },
      {
        chrom: 'chrI',
        source: 'fixture',
        type: 'gene',
        start: 50,
        end: 80,
        score: null,
        strand: '-',
        phase: null,
        attributes: { Name: ['gA'] },
        raw: 'chrI\tfixture\tgene\t51\t80\t.\t-\t.\tName=gA',
      },
    ];
    const sourceA = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'N'.repeat(1000),
      features,
    });
    const sourceB = new InMemoryGenomeDataSource({
      chrom: 'chrI',
      sequence: 'N'.repeat(1000),
      features,
    });

    const a = await materializeGenomeDataSourceRange({
      source: sourceA,
      chrom: 'chrI',
      start: 0,
      end: 1000,
      zoomLevel: 1,
    });
    const b = await materializeGenomeDataSourceRange({
      source: sourceB,
      chrom: 'chrI',
      start: 0,
      end: 1000,
      zoomLevel: 1,
    });

    expect(b.genome).toEqual(a.genome);
  });
});

function byStart(a: { start: number }, b: { start: number }): number {
  return a.start - b.start;
}

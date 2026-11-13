// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GenomeFeature, IndexedGenomeManifest } from '@waypoint/genome-data';

import {
  IndexedGenomeCompatibilityScene,
  type IndexedGenomeCompatibilityProjection,
  type IndexedGenomeCompatibilitySceneProps,
} from './IndexedGenomeCompatibilityScene';

const MANIFEST = {
  workspaceRoot: '/workspace',
  indexDir: '/workspace/.waypoint/genome-index/chr11-test',
  chrom: 'chr11',
  fastaPath: 'chr11.fa',
  faiPath: 'chr11.fa.fai',
  gffPath: 'chr11.gff3.gz',
  tbiPath: 'chr11.gff3.gz.tbi',
  sourcePath: '/workspace/chr11.gbff',
  indexedAt: '2026-05-11T00:00:00.000Z',
  chromosomes: [{ chrom: 'chr11', length: 10_000 }],
  topology: 'linear',
} as IndexedGenomeManifest;

function geneFeature(): GenomeFeature {
  return {
    chrom: 'chr11',
    source: 'test',
    type: 'gene',
    start: 100,
    end: 400,
    score: null,
    strand: '+',
    phase: null,
    attributes: { ID: ['gene-1'], gene_name: ['TEST1'] },
    raw: '',
  };
}

function readyState(): IndexedGenomeCompatibilitySceneProps['state'] {
  return {
    kind: 'ready',
    tileFeatures: [geneFeature()],
    featureModel: 'raw-gff3',
    tileCacheState: 'hit',
    summaryTileState: 'ready',
    summaryTileFidelity: 'summary',
    summaryTileGeneration: 1,
    summaryTileByteCount: 128,
    summaryTileValidationState: 'metadata_match',
    sourceRecordCount: 1,
    layerTypes: ['gene'],
    sequence: '',
  };
}

function sceneProps(
  overrides: Partial<IndexedGenomeCompatibilitySceneProps> = {}
): IndexedGenomeCompatibilitySceneProps {
  return {
    state: readyState(),
    manifest: MANIFEST,
    sessionId: 'session-chr11',
    length: 10_000,
    height: 480,
    containerWidth: 800,
    glyphV2Enabled: false,
    rendererAssembly: null,
    rendererEffectiveVisibleTypes: new Set(['gene', 'mRNA']),
    rendererEffectiveVisibleLayerTypes: ['gene', 'mRNA'],
    laneLimit: 2,
    transcriptDisplayMode: 'canonical',
    expandedGeneIds: new Set(),
    annotationViewportTiles: [],
    annotationViewportTile: null,
    pendingAnnotationViewportTile: null,
    sceneViewportRange: { start: 0, end: 10_000 },
    sequenceWindow: null,
    pendingSequenceWindow: null,
    overviewTextureStatus: 'not-applicable',
    stableAnnotationSourceIdentity: null,
    assemblyExactAnnotationCoverage: [],
    prepackedAnnotationLayoutOwnerKey: null,
    ...overrides,
  };
}

function CompatibilityMountHost({
  compiledBroadOwnsAssembly,
  onProjectionChange,
}: {
  compiledBroadOwnsAssembly: boolean;
  onProjectionChange: (projection: IndexedGenomeCompatibilityProjection) => void;
}) {
  if (compiledBroadOwnsAssembly) {
    return <div data-testid="compiled-broad-shell" />;
  }
  return (
    <IndexedGenomeCompatibilityScene {...sceneProps()} onProjectionChange={onProjectionChange}>
      {(projection) => (
        <div
          data-testid="compatibility-features"
          data-feature-count={projection.activeFilteredRendererFeatures?.features.length ?? 0}
        />
      )}
    </IndexedGenomeCompatibilityScene>
  );
}

describe('IndexedGenomeCompatibilityScene', () => {
  it('does not mount or publish flat compatibility features when compiled-broad owns the assembly', () => {
    const onProjectionChange = vi.fn();
    render(
      <CompatibilityMountHost compiledBroadOwnsAssembly onProjectionChange={onProjectionChange} />
    );

    expect(screen.getByTestId('compiled-broad-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('compatibility-features')).toBeNull();
    expect(onProjectionChange).not.toHaveBeenCalled();
  });

  it('produces a Genome and scene from a tiny feature set when compiled-broad does not own', () => {
    const onProjectionChange = vi.fn();
    render(
      <IndexedGenomeCompatibilityScene {...sceneProps()} onProjectionChange={onProjectionChange}>
        {(projection) => (
          <div
            data-testid="compatibility-scene"
            data-scene-ready={projection.activeTileNativeScene ? 'yes' : 'no'}
            data-genome-ready={projection.tileNativeRendererGenome ? 'yes' : 'no'}
            data-feature-count={projection.activeFilteredRendererFeatures?.features.length ?? 0}
          />
        )}
      </IndexedGenomeCompatibilityScene>
    );

    expect(onProjectionChange).toHaveBeenCalled();
    const published = onProjectionChange.mock.calls.at(
      -1
    )?.[0] as IndexedGenomeCompatibilityProjection;
    expect(published.activeTileNativeScene).not.toBeNull();
    expect(published.tileNativeRendererGenome).not.toBeNull();
    expect(published.tileNativeRendererGenome?.length).toBe(10_000);
    expect(published.activeFilteredRendererFeatures?.features.length).toBeGreaterThan(0);
    expect(screen.getByTestId('compatibility-scene')).toHaveAttribute('data-scene-ready', 'yes');
    expect(screen.getByTestId('compatibility-scene')).toHaveAttribute('data-genome-ready', 'yes');
  });
});

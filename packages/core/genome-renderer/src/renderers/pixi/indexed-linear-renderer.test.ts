import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';
import { PixiLinearRenderer } from './linear-renderer';
import { IndexedAnnotationOverlay } from './overlays/annotation-overlay';
import { SequenceAnnotationOverlay } from './overlays/sequence-annotation-overlay';
import type { PixiLinearTrackRenderer } from './linear-tracks';

function fakePileupTrack(): PixiLinearTrackRenderer {
  return {
    type: 'pileup',
    mount: () => new Container(),
    paint: () => undefined,
    unmount: () => undefined,
  };
}

describe('IndexedPixiLinearRenderer product cut', () => {
  it('exposes compiled-broad only on the indexed subclass', () => {
    expect(typeof new IndexedPixiLinearRenderer().requireCompiledBroadSurface).toBe('function');
    expect('requireCompiledBroadSurface' in new PixiLinearRenderer()).toBe(false);
    expect('setAnnotationPresentationSnapshot' in new PixiLinearRenderer()).toBe(false);
  });

  it('constructs an indexed overlay while the linear default stays sequence', () => {
    expect(Reflect.get(new IndexedPixiLinearRenderer(), 'annotationOverlay')).toBeInstanceOf(
      IndexedAnnotationOverlay
    );
    expect(Reflect.get(new PixiLinearRenderer(), 'annotationOverlay')).toBeInstanceOf(
      SequenceAnnotationOverlay
    );
  });

  it('does not require compiled-broad at construct time', () => {
    expect(() => new IndexedAnnotationOverlay()).not.toThrow();
    expect(() => new IndexedPixiLinearRenderer()).not.toThrow();
  });

  it('keeps the indexed overlay when a pileup track is registered', () => {
    const renderer = new IndexedPixiLinearRenderer();
    const overlay = Reflect.get(renderer, 'annotationOverlay');
    renderer.registerTrack(fakePileupTrack());
    renderer.setTrackInstances([
      {
        id: 'pileup-genomewide-grch38',
        type: 'pileup',
        order: 1,
        visible: true,
        assemblyId: 'grch38',
      },
    ]);
    expect(Reflect.get(renderer, 'annotationOverlay')).toBe(overlay);
    expect(overlay).toBeInstanceOf(IndexedAnnotationOverlay);
  });

  it('restores the visible genome after extract success or throw', async () => {
    const renderer = new IndexedPixiLinearRenderer();
    const boxed = renderer as unknown as {
      genome: { name: string; length: number; circular: boolean };
      getState: () => { viewOffset: number; zoom: number; viewportRange: [number, number] };
      loadGenome: (genome: { name: string; length: number; circular: boolean }) => Promise<void>;
      render: () => void;
      buildAndExtractGenomeWideTexturePng: () => Promise<unknown>;
    };
    const visible = { name: 'visible', length: 10, circular: false };
    const precompute = { name: 'precompute', length: 99, circular: false };
    const loaded: string[] = [];
    boxed.genome = visible;
    boxed.getState = () => ({
      viewOffset: 0.2,
      zoom: 4,
      viewportRange: [1, 2],
    });
    boxed.loadGenome = async (genome) => {
      loaded.push(genome.name);
      boxed.genome = genome;
    };
    boxed.render = () => undefined;
    boxed.buildAndExtractGenomeWideTexturePng = async () => {
      throw new Error('extract');
    };

    await expect(renderer.buildAndExtractGenomeWideTextureForGenome(precompute)).rejects.toThrow(
      'extract'
    );
    expect(loaded).toEqual(['precompute', 'visible']);
    expect(boxed.genome).toBe(visible);
  });
});

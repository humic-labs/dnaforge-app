import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { AnnotationOverlay } from './overlays/annotation-overlay';
import { SequenceAnnotationOverlay } from './overlays/sequence-annotation-overlay';
import { PixiLinearRenderer } from './linear-renderer';
import type { PixiLinearTrackRenderer } from './linear-tracks';

function fakePileupTrack(): PixiLinearTrackRenderer {
  return {
    type: 'pileup',
    mount: () => new Container(),
    paint: () => undefined,
    unmount: () => undefined,
  };
}

describe('PixiLinearRenderer overlay injection', () => {
  it('uses the overlay passed to the constructor', () => {
    const overlay = new AnnotationOverlay();
    const renderer = new PixiLinearRenderer({ overlay });
    expect(Reflect.get(renderer, 'annotationOverlay')).toBe(overlay);
  });

  it('constructs a default sequence overlay when none is passed', () => {
    const renderer = new PixiLinearRenderer();
    expect(Reflect.get(renderer, 'annotationOverlay')).toBeInstanceOf(SequenceAnnotationOverlay);
  });

  it('keeps the sequence overlay when a pileup track is registered', () => {
    const renderer = new PixiLinearRenderer();
    const overlay = Reflect.get(renderer, 'annotationOverlay');
    renderer.registerTrack(fakePileupTrack());
    expect(Reflect.get(renderer, 'annotationOverlay')).toBe(overlay);
    expect(overlay).toBeInstanceOf(SequenceAnnotationOverlay);
  });
});

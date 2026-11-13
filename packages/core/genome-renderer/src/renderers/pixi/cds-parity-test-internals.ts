import type { CodonTrack } from './tracks/codon-track';
import type { SequenceAnnotationOverlay } from './overlays/sequence-annotation-overlay';
import type { IndexedAnnotationOverlay } from './overlays/annotation-overlay';

export function installMeasureTextCanvasContext(): void {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 7 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
}

export type CdsRendererInternals = {
  readonly codonTrack: CodonTrack;
  readonly annotationOverlay: SequenceAnnotationOverlay | IndexedAnnotationOverlay;
};

export function cdsRendererInternals(renderer: object): CdsRendererInternals {
  return renderer as CdsRendererInternals;
}

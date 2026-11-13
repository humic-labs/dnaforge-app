import type { Container, Renderer } from 'pixi.js';
import {
  AnnotationSidecarRasterPresenter,
  type AnnotationSidecarRasterExternalSources,
} from '../overview/annotation-sidecar-raster-presenter';
import { normalizeAnnotationLayerTypes } from './annotation-feature-semantics';

export class IndexedSidecarRasterController {
  private presenter: AnnotationSidecarRasterPresenter | null = null;
  private sources: AnnotationSidecarRasterExternalSources | null = null;
  private visibleTypes: readonly string[] = ['mRNA'];
  private laneLimit = 1;

  install(
    sources: AnnotationSidecarRasterExternalSources,
    host: {
      parentContainer: Container;
      readRenderer: () => Renderer | null;
    }
  ): void {
    if (this.sources === sources) return;
    this.presenter?.destroy();
    this.presenter = new AnnotationSidecarRasterPresenter({
      ...sources,
      parentContainer: host.parentContainer,
      readRenderer: host.readRenderer,
    });
    this.sources = sources;
  }

  clear(): void {
    this.presenter?.destroy();
    this.presenter = null;
    this.sources = null;
  }

  hide(): void {
    this.presenter?.hide();
  }

  destroy(): void {
    this.clear();
  }

  setVisibleTypes(types: readonly string[]): void {
    const normalized = normalizeAnnotationLayerTypes(types);
    if (normalized.length === 0) return;
    this.visibleTypes = normalized;
  }

  getVisibleTypes(): readonly string[] {
    return this.visibleTypes;
  }

  setLaneLimit(laneLimit: number): void {
    if (!Number.isFinite(laneLimit) || laneLimit < 1) return;
    this.laneLimit = Math.trunc(laneLimit);
  }

  getLaneLimit(): number {
    return this.laneLimit;
  }

  getAvailableTypes(): readonly string[] {
    return this.presenter?.getAvailableTypes() ?? [];
  }

  get isPresenting(): boolean {
    return this.presenter?.isPresenting ?? false;
  }

  get visibleTrackTypes(): readonly string[] {
    return this.presenter?.visibleTrackTypes ?? [];
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlaySidecarRasterCollaborator extends IndexedSidecarRasterController {}
}

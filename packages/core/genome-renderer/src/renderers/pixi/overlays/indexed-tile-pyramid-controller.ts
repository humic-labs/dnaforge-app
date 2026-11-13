import type { Container, Renderer } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import type { RetainedOverlayCameraState } from './overlay-track';
import {
  buildTranscriptGlyphBlocks,
  RetainedLinearTranscriptLayer,
  type DirectionalBlock,
} from '../overview/retained-linear-transcript-layer';
import { VectorTilePyramidCompositor } from '../overview/vector-tile-compositor';
import { RttGlyphTilePyramidCompositor } from '../overview/rtt-glyph-tile-compositor';
import {
  genomeTilePyramidEnabled,
  overviewGlyphTilesEnabled,
} from '../overview/retained-overview-style';
import { crossoverLevel } from '../overview/tile-pyramid-coords';
import { linearViewerRenderContract } from '../overview/viewer-render-contract';
import { isOutlineOnlyFeature, isTranscript } from './annotation-feature-semantics';
import { transcriptVectorTilesCoverLayerTypes } from './annotation-presentation-owners';

export const OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP = 512_000;

export type TilePyramidCompositeHost = {
  pixiRenderer: Renderer | null;
  genomeLength: number;
  features: { readonly length: number };
  genomeWideTextureCacheLayer: { hide(): void } | null;
  container: Container;
  annotationLayerTypesForPresentation(): string[];
  cdsDetailProgress(): number;
  featuresInRange(startBp: number, endBp: number): Iterable<Feature>;
  featureEnvelope(feature: Feature): { centerOffset: number } | null;
  scaledBarHeight(): number;
};

export class IndexedTilePyramidController {
  vector: VectorTilePyramidCompositor | null = null;
  rtt: RttGlyphTilePyramidCompositor | null = null;
  bakeLayer: RetainedLinearTranscriptLayer | null = null;

  makeLayer(): RetainedLinearTranscriptLayer {
    const layer = new RetainedLinearTranscriptLayer();
    layer.container.eventMode = 'none';
    return layer;
  }

  buildBlocksForRange(
    host: TilePyramidCompositeHost,
    startBp: number,
    endBp: number,
    state: RenderState
  ): ReadonlyArray<DirectionalBlock> {
    const cdsDetail = host.cdsDetailProgress();
    const transcripts: Feature[] = [];
    for (const feature of host.featuresInRange(startBp, endBp)) {
      if (isTranscript(feature) && !isOutlineOnlyFeature(feature)) transcripts.push(feature);
    }
    return buildTranscriptGlyphBlocks(transcripts, {
      getOffset: (feature) => {
        const env = host.featureEnvelope(feature as Feature);
        return env ? env.centerOffset : null;
      },
      halfHeight: host.scaledBarHeight() / 2,
      themeMode: state.themeMode,
      cdsDetail,
    });
  }

  ensureVector(host: {
    pixiRenderer: Renderer | null;
    container: Container;
  }): VectorTilePyramidCompositor | null {
    if (host.pixiRenderer === null) return null;
    if (!this.vector) {
      this.vector = new VectorTilePyramidCompositor({
        makeLayer: () => this.makeLayer(),
      });
      host.container.addChildAt(this.vector.container, Math.min(2, host.container.children.length));
    }
    return this.vector;
  }

  ensureRtt(host: {
    pixiRenderer: Renderer | null;
    container: Container;
  }): RttGlyphTilePyramidCompositor | null {
    if (host.pixiRenderer === null) return null;
    if (!this.rtt) {
      this.rtt = new RttGlyphTilePyramidCompositor();
      host.container.addChildAt(this.rtt.container, Math.min(2, host.container.children.length));
    }
    if (!this.bakeLayer) {
      this.bakeLayer = new RetainedLinearTranscriptLayer();
      this.bakeLayer.container.eventMode = 'none';
    }
    return this.rtt;
  }

  resetTilePyramid(opts: { retainRtt?: boolean } = {}): void {
    this.reset(opts);
  }

  reset(opts: { retainRtt?: boolean } = {}): void {
    this.vector?.destroy();
    this.vector = null;
    if (opts.retainRtt && this.rtt) {
      this.rtt.markDataChanged();
    } else {
      this.rtt?.destroy();
      this.rtt = null;
    }
  }

  tryComposite(host: TilePyramidCompositeHost, camera: RetainedOverlayCameraState): boolean {
    const vectorEnabled = genomeTilePyramidEnabled();
    const overviewEnabled = overviewGlyphTilesEnabled();
    if (!vectorEnabled && !overviewEnabled) return false;
    if (host.pixiRenderer === null || host.genomeLength <= 0) return false;
    if (host.features.length === 0) return false;

    const path = camera.path;
    const liveContract = linearViewerRenderContract(path);
    const L = host.genomeLength;
    const featureCount = Math.max(1, host.features.length);
    const medianFeatureSpanBp = L / featureCount;
    const maxLevel = 24;
    const zXover = crossoverLevel({ L, medianFeatureSpanBp, maxLevel });
    const visibleBp = Math.max(1, path.viewEndBp - path.viewStartBp);
    if (visibleBp > OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP) {
      this.vector?.resetData();
      if (!overviewEnabled) {
        this.rtt?.hide();
        return false;
      }
      const resolution = Math.max(1, host.pixiRenderer?.resolution ?? 1);

      const rtt = this.ensureRtt(host);
      if (!rtt || !this.bakeLayer) return false;
      const g = globalThis as typeof globalThis & {
        __WAYPOINT_RTT_MATCH_SCREEN_DENSITY?: boolean;
        __WAYPOINT_RTT_SCALE_MODE?: 'nearest' | 'linear';
        __WAYPOINT_RTT_ANTIALIAS?: boolean;
        __WAYPOINT_RTT_TILE_PX?: number;
        __WAYPOINT_RTT_SUPERSAMPLE?: number;
      };
      const rttOwned = rtt.compositeCoarse(
        {
          L,
          viewStartBp: path.viewStartBp,
          viewEndBp: path.viewEndBp,
          screenPx: Math.max(1, camera.state.width),
          maxLevel,
        },
        liveContract,
        {
          renderer: host.pixiRenderer as Renderer,
          bakeLayer: this.bakeLayer,
          buildBlocksForRange: (s, e) => this.buildBlocksForRange(host, s, e, camera.state),
          resolution,
          viewportH: camera.state.height,
          spineOffsetPx: liveContract.projectY(0),
          cdsDetail: host.cdsDetailProgress(),
          tilePx: g.__WAYPOINT_RTT_TILE_PX ?? 512,
          matchScreenDensity: g.__WAYPOINT_RTT_MATCH_SCREEN_DENSITY !== false,
          scaleMode: g.__WAYPOINT_RTT_SCALE_MODE ?? 'nearest',
          antialias: g.__WAYPOINT_RTT_ANTIALIAS !== false,
          supersample: g.__WAYPOINT_RTT_SUPERSAMPLE ?? 1,
        }
      );
      if (rttOwned) {
        host.genomeWideTextureCacheLayer?.hide();
        return true;
      }
      return false;
    }

    this.rtt?.hide();
    if (!vectorEnabled) {
      this.vector?.resetData();
      return false;
    }
    host.genomeWideTextureCacheLayer?.hide();
    const requestedLayerTypes = host.annotationLayerTypesForPresentation();
    if (!transcriptVectorTilesCoverLayerTypes(requestedLayerTypes)) {
      this.vector?.resetData();
      return false;
    }
    const vector = this.ensureVector(host);
    const vectorOwned =
      vector?.compositeVector(
        {
          L,
          viewStartBp: path.viewStartBp,
          viewEndBp: path.viewEndBp,
          screenPx: Math.max(1, camera.state.width),
          maxLevel,
        },
        liveContract,
        zXover,
        {
          buildBlocksForRange: (s, e) => this.buildBlocksForRange(host, s, e, camera.state),
          viewportW: camera.state.width,
          viewportH: camera.state.height,
          cdsDetail: host.cdsDetailProgress(),
        }
      ) ?? false;
    if (vectorOwned) return true;
    return false;
  }

  tryPresent(
    host: TilePyramidCompositeHost,
    camera: RetainedOverlayCameraState,
    onPresented: () => void
  ): boolean {
    if (!this.tryComposite(host, camera)) return false;
    onPresented();
    return true;
  }

  hide(): void {
    this.vector?.hide();
    this.rtt?.hide();
  }

  destroy(): void {
    this.vector?.destroy();
    this.vector = null;
    this.rtt?.destroy();
    this.rtt = null;
    this.bakeLayer?.destroy();
    this.bakeLayer = null;
  }
}

declare module './indexed-annotation-overlay-collaborators' {
  interface OverlayTilePyramidCollaborator extends IndexedTilePyramidController {}
}

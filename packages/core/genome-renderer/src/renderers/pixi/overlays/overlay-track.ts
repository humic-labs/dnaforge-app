import type { Container } from 'pixi.js';
import type { PathMapper } from '../shared/path-types';
import type { Genome, RenderState } from '../../../types';
import type { WebGLHitTarget } from '../shared/hit-targets';

export type OverlayPosition = 'above' | 'on' | 'below';

export interface OverlayLayoutBands {
  aboveSequenceHeight?: number;
  belowSequenceHeight?: number;
  occupiesSequenceBand?: boolean;
  sequenceBandHeight?: number;
}

export type OverlayHitResult = WebGLHitTarget & {
  tooltipHtml?: string;
};

export type RetainedOverlayRenderMode = 'inactive' | 'retained' | 'fallback';

export type RetainedOverlayFallbackReason =
  | 'disabled'
  | 'unsupported-mode'
  | 'unsupported-visual-state'
  | 'dirty-data'
  | 'budget-exceeded'
  | 'error';

export interface RetainedOverlayDebugSnapshot {
  id: string;
  style?: string;
  supported: boolean;
  enabled: boolean;
  mode: RetainedOverlayRenderMode;
  dataBuilds: number;
  cameraUpdates: number;
  interactionUpdates: number;
  fallbackRenders: number;
  lastFallbackReason: RetainedOverlayFallbackReason | null;
  retainedInstanceCount: number;
  visibleInstanceCount: number;
}

export interface RetainedOverlayCameraState {
  path: PathMapper;
  state: RenderState;
  yOffset: number;
  height: number;
}

export interface OverlayTrack {
  readonly id: string;

  readonly displayName: string;

  readonly position: OverlayPosition;

  sortOrder: number;

  hitTestOrder?: number;

  enabled: boolean;

  layoutCacheKey?(
    genome: Genome,
    state: RenderState,
    pixelsPerBp: number
  ): string | number | boolean | null;

  computeHeight(genome: Genome, state: RenderState, pixelsPerBp: number): number;

  computeLayoutBands?(
    genome: Genome,
    state: RenderState,
    pixelsPerBp: number
  ): OverlayLayoutBands | null;

  loadGenome(genome: Genome): void;

  render(path: PathMapper, state: RenderState, yOffset: number, height: number): void;

  hitTest(
    screenX: number,
    screenY: number,
    path: PathMapper,
    state: RenderState
  ): OverlayHitResult | null;

  readonly container: Container;

  destroy(): void;

  setFrameRequester?(requester: (() => void) | null): void;
}

export interface RetainedOverlayTrack extends OverlayTrack {
  buildRetainedData?(genome: Genome): void;

  updateRetainedCamera?(camera: RetainedOverlayCameraState): boolean;

  updateRetainedInteraction?(state: RenderState): void;

  getRetainedDebugSnapshot?(): RetainedOverlayDebugSnapshot | null;
}

export function isRetainedOverlayTrack(track: OverlayTrack): track is RetainedOverlayTrack {
  return (
    typeof (track as RetainedOverlayTrack).buildRetainedData === 'function' ||
    typeof (track as RetainedOverlayTrack).updateRetainedCamera === 'function' ||
    typeof (track as RetainedOverlayTrack).getRetainedDebugSnapshot === 'function'
  );
}

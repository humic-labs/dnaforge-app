import type { Container, Renderer } from 'pixi.js';

import type { Assembly } from '../../../assembly';
import type { Chromosome } from '../../../chromosome';
import type {
  Track,
  TrackLayoutEntry,
  TrackPresentationMetadata,
  TrackType,
} from '../../../tracks/types';
import type { PathMapper } from '../shared/path-types';
import type { WebGLRenderTheme } from '../shared/theme';
import type { Genome, RenderState } from '../../../types';

export interface BpRange {
  start: number;
  end: number;
}

export interface TrackMountArgs {
  chromosome: Chromosome;
  assembly?: Assembly;
  theme: WebGLRenderTheme;
}

export interface TrackPaintArgs<TData = unknown> {
  container: Container;
  pathMapper: PathMapper;
  viewportBpRange: BpRange;
  viewportWidthPx: number;
  viewportHeightPx: number;
  layoutEntry: TrackLayoutEntry;
  containerTopPx: number;
  data: TData | null;
  presentation: Readonly<TrackPresentationMetadata>;
  chromosome: Chromosome;
  assembly?: Assembly;
  renderer: Renderer;
  theme: WebGLRenderTheme;
  cdsRendering?: {
    readonly genome: Pick<
      Genome,
      'length' | 'circular' | 'geneticCode' | 'sequence' | 'sequenceWindow'
    >;
    readonly state: RenderState;
    readonly detailProgress: number;
  };
}

export interface TrackMeasureContentArgs<TData = unknown> {
  data: TData | null;
  presentation: Readonly<TrackPresentationMetadata>;
  chromosome: Chromosome;
  assembly?: Assembly;
}

export interface TrackHitArgs {
  localX: number;
  localY: number;
  viewportWidthPx: number;
  layoutEntry: TrackLayoutEntry;
  pathMapper: PathMapper;
  viewportBpRange: BpRange;
  chromosome: Chromosome;
  assembly?: Assembly;
}

export interface TrackHoverArgs extends TrackHitArgs {
  container: Container;
}

export type TrackHitResult =
  | { kind: 'jump-to-bp'; bp: number }
  | {
      kind: 'frame-bp-range';
      startBp: number;
      endBp: number;
      chromosomeId: string;
    }
  | {
      kind: 'select-bp-range';
      startBp: number;
      endBp: number;
      chromosomeId: string;
      name?: string;
    };

export interface TrackCoverageDepthSnapshot {
  coverageDepthP99: number | null;
  coverageDepthMax: number | null;
}

export interface PixiLinearTrackRenderer<TData = unknown> {
  readonly type: TrackType;
  prepareGpuPrograms?(renderer: Renderer): void;
  mount(args: TrackMountArgs): Container;
  measureContentHeight?(args: TrackMeasureContentArgs<TData>): number;
  paint(args: TrackPaintArgs<TData>): void;
  hasPendingPaintWork?(container: Container): boolean;
  hitTest?(args: TrackHoverArgs): TrackHitResult | null;
  updateHover?(args: TrackHoverArgs): void;
  clearHover?(container: Container): void;
  getDiagnostics?(container: Container): object | null;
  getColdGestureDiagnostics?(container: Container): object | null;
  getCoverageDepthSnapshot?(container: Container): TrackCoverageDepthSnapshot | null;
  unmount(container: Container): void;
}

export interface SupplementalLinearTrack {
  readonly track: Track;
  readonly renderer: PixiLinearTrackRenderer;
  readonly data: unknown;
}

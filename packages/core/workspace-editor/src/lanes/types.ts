import type { HitResult } from '../layout-interface';
import type { ReferenceColumnOverlay } from './overlay-types';

export type LaneLodTier = 'wide' | 'medium' | 'close';

export interface ColumnRange {
  start: number;
  end: number;
}

export interface LaneHeightState {
  pxPerColumn: number;
  lodTier: LaneLodTier;
}

export interface LaneDrawState extends LaneHeightState {
  columnRange: ColumnRange;
  laneY: number;
  laneHeight: number;
  columnGridLeft: number;
  contentWidth: number;
}

export interface LaneHitState extends LaneHeightState {
  columnRange: ColumnRange;
  laneY: number;
  laneHeight: number;
  columnGridLeft: number;
  contentWidth: number;
}

export interface LaneHeaderState extends LaneHeightState {
  laneY: number;
  laneHeight: number;
  width: number;
}

export interface LanePlugin {
  id: string;
  type: 'reference' | 'read' | 'consensus' | 'feature' | 'translation' | string;
  height: (state: LaneHeightState) => number;
  draw: (ctx: CanvasRenderingContext2D, columnRange: ColumnRange, state: LaneDrawState) => void;
  hitTest?: (x: number, y: number, state: LaneHitState) => HitResult | null;
  header?: {
    width: number;
    draw: (ctx: CanvasRenderingContext2D, state: LaneHeaderState) => void;
  };
  referenceColumnOverlays?: ReadonlyArray<ReferenceColumnOverlay>;
}

export interface MeasuredLane {
  id: string;
  type: LanePlugin['type'];
  plugin: LanePlugin;
  y: number;
  height: number;
  visible: boolean;
  headerWidth: number;
}

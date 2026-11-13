import { getLaneLodTier } from './lod';
import type { LaneHeightState, LanePlugin, LaneLodTier } from './types';

const DEFAULT_LANE_HEIGHT = 24;

export interface SolidLaneOptions {
  id: string;
  color: string;
  height?: number;
  type?: LanePlugin['type'];
  header?: { width: number; label: string; color?: string; textColor?: string };
}

export function solidLane(options: SolidLaneOptions): LanePlugin {
  const height = options.height ?? DEFAULT_LANE_HEIGHT;
  const headerOpt = options.header;
  return {
    id: options.id,
    type: options.type ?? 'feature',
    height: () => height,
    draw: (ctx, _columnRange, state) => {
      ctx.fillStyle = options.color;
      ctx.fillRect(state.columnGridLeft, state.laneY, state.contentWidth, state.laneHeight);
    },
    header: headerOpt
      ? {
          width: headerOpt.width,
          draw: (ctx, headerState) => {
            ctx.fillStyle = headerOpt.color ?? 'rgba(15, 23, 42, 0.04)';
            ctx.fillRect(0, headerState.laneY, headerState.width, headerState.laneHeight);
            if (headerOpt.label) {
              ctx.fillStyle = headerOpt.textColor ?? 'rgba(15, 23, 42, 0.85)';
              ctx.font = '12px system-ui, sans-serif';
              ctx.textBaseline = 'middle';
              ctx.textAlign = 'left';
              ctx.fillText(
                headerOpt.label,
                8,
                headerState.laneY + headerState.laneHeight / 2,
                Math.max(0, headerState.width - 16)
              );
            }
          },
        }
      : undefined,
  };
}

export interface LodAwareLaneOptions {
  id: string;
  heights: Record<LaneLodTier, number>;
  colors: Record<LaneLodTier, string>;
  type?: LanePlugin['type'];
}

export function lodAwareLane(options: LodAwareLaneOptions): LanePlugin {
  return {
    id: options.id,
    type: options.type ?? 'feature',
    height: (state: LaneHeightState) => options.heights[state.lodTier],
    draw: (ctx, _columnRange, state) => {
      ctx.fillStyle = options.colors[state.lodTier];
      ctx.fillRect(state.columnGridLeft, state.laneY, state.contentWidth, state.laneHeight);
    },
  };
}

export { getLaneLodTier };

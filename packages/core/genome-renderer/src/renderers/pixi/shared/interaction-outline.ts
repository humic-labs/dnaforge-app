import type { RenderState } from '../../../types';

export interface InteractionOutlineStyle {
  width: number;
  color: number;
  alpha: number;
}

export function interactionOutlineColor(state: RenderState): number {
  return state.themeMode === 'dark' ? 0xf8fafc : 0x111827;
}

export function sourceColorInteractionOutline(color: number, state: RenderState): number {
  const target = state.themeMode === 'dark' ? 0xffffff : 0x000000;
  const amount = state.themeMode === 'dark' ? 0.38 : 0.3;
  const blend = (shift: number): number => {
    const sourceChannel = (color >> shift) & 0xff;
    const targetChannel = (target >> shift) & 0xff;
    return Math.round(sourceChannel + (targetChannel - sourceChannel) * amount);
  };
  return (blend(16) << 16) | (blend(8) << 8) | blend(0);
}

export function interactionOutlineStyle(
  state: RenderState,
  featureId: number
): InteractionOutlineStyle | null {
  const isSelected = state.selectedIds.has(featureId);
  const isHovered = state.hoveredId === featureId;
  if (!isSelected && !isHovered) return null;

  return {
    width: isSelected ? 2 : 1.5,
    color: interactionOutlineColor(state),
    alpha: isSelected ? 0.85 : 0.55,
  };
}

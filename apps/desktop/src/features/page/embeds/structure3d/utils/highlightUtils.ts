import type { HighlightGroup, ResidueLocation } from '../types';
import { positionsToRanges } from './rangeUtils';

export const HIGHLIGHT_PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

export const SAVED_SELECTION_HIGHLIGHT_COLOR = '#22c55e' as const;

export function resolveHighlightGroupColor(group: Pick<HighlightGroup, 'id' | 'color'>): string {
  if (group.color && /^#[0-9a-f]{6}$/i.test(group.color)) {
    return group.color.toLowerCase();
  }
  let hash = 2166136261;
  for (let index = 0; index < group.id.length; index += 1) {
    hash ^= group.id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return HIGHLIGHT_PALETTE[(hash >>> 0) % HIGHLIGHT_PALETTE.length];
}

export function selectionToHighlightGroup(
  selected: ResidueLocation[],
  label: string,
  _existingGroups: HighlightGroup[] = []
): HighlightGroup | null {
  if (selected.length === 0) return null;

  const byChain = new Map<
    string,
    {
      chain: string;
      baseChain?: string;
      labelAsymId?: string;
      authAsymId?: string;
      entityId?: string;
      operator?: string;
      positions: number[];
    }
  >();
  for (const r of selected) {
    const key = JSON.stringify({
      chain: r.chain,
      baseChain: r.baseChain,
      labelAsymId: r.labelAsymId,
      authAsymId: r.authAsymId,
      entityId: r.entityId,
      operator: r.operator,
    });
    let chainSelection = byChain.get(key);
    if (!chainSelection) {
      chainSelection = {
        chain: r.chain,
        baseChain: r.baseChain,
        labelAsymId: r.labelAsymId,
        authAsymId: r.authAsymId,
        entityId: r.entityId,
        operator: r.operator,
        positions: [],
      };
      byChain.set(key, chainSelection);
    }
    chainSelection.positions.push(r.position);
  }

  const selections = [...byChain.values()].map((selection) => ({
    chain: selection.chain,
    ...(selection.baseChain ? { baseChain: selection.baseChain } : {}),
    ...(selection.labelAsymId ? { labelAsymId: selection.labelAsymId } : {}),
    ...(selection.authAsymId ? { authAsymId: selection.authAsymId } : {}),
    ...(selection.entityId ? { entityId: selection.entityId } : {}),
    ...(selection.operator ? { operator: selection.operator } : {}),
    ranges: positionsToRanges(selection.positions),
  }));

  return {
    id: `highlight-${Date.now()}`,
    label,
    selections,
    color: SAVED_SELECTION_HIGHLIGHT_COLOR,
    visible: false,
  };
}

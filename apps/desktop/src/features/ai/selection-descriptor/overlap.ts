import {
  isPositionInRange,
  type SelectionRange,
} from '../../../../../../packages/core/workspace-editor/src/selection-model';
import type { OverlapRelation } from './types';

export const OVERLAP_FEATURE_CAP = 15;

export function overlapRelation(
  feat: SelectionRange,
  sel0: SelectionRange,
  seqLen: number
): OverlapRelation {
  const featStartInSel = isPositionInRange(feat.start, sel0, seqLen);
  const featEndInSel = isPositionInRange(feat.end, sel0, seqLen);
  if (featStartInSel && featEndInSel) return 'selection-contains-feature';
  const selStartInFeat = isPositionInRange(sel0.start, feat, seqLen);
  const selEndInFeat = isPositionInRange(sel0.end, feat, seqLen);
  if (selStartInFeat && selEndInFeat) return 'feature-contains-selection';
  return 'partial-overlap';
}

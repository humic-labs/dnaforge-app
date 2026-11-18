import type { SequenceDataLayerViewSelection } from '../../canvas/public/types';

export function visibleSequenceDataLayerIds(
  selection: SequenceDataLayerViewSelection | undefined,
  defaultLayerId?: string
): readonly string[] {
  if (selection?.visibleLayerIds !== undefined) return selection.visibleLayerIds;
  if (selection?.layerId === null) return [];
  const id = selection?.layerId ?? defaultLayerId;
  return id ? [id] : [];
}

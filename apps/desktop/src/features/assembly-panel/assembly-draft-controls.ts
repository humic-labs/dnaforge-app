import type { SequenceDesign } from '../design/public/types';

export function assemblyDraftControls(design: SequenceDesign) {
  const canClear = (design.designPrimers?.length ?? 0) > 0;
  return {
    canDraft: design.regions.length >= 2 && !design.regions.some((part) => part.isPlaceholder),
    canClear,
    label: canClear ? 'Update' : 'Draft',
  };
}

import type { PickerStageProps } from '../types';
import { EntityPicker } from '../EntityPicker';

export function PagePicker({ onAdvance, onCancel }: PickerStageProps) {
  return (
    <EntityPicker
      label="pages"
      selectFirst
      filter={{ category: 'notebooks' }}
      onCancel={onCancel}
      onSelect={(entity) => onAdvance({ entity, pageId: entity.id, pageName: entity.name })}
    />
  );
}

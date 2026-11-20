import type { PickerStageProps } from '../types';
import { EntityPicker } from '../EntityPicker';

export function SequencePicker({ onAdvance, onCancel }: PickerStageProps) {
  return (
    <EntityPicker
      label="sequences"
      filter={{ category: 'sequences' }}
      onCancel={onCancel}
      onSelect={(entity) =>
        onAdvance({
          entity,
          entityId: entity.id,
          sequenceName: entity.name,
          path: entity.path,
          contentHash: entity.contentHash,
          objectUuid: entity.objectUuid,
          owningRoot: entity.projectRoot,
        })
      }
    />
  );
}

import type { PickerStageProps } from '../types';
import { EntityPicker } from '../EntityPicker';

export function PrimerPicker({ onAdvance, onCancel }: PickerStageProps) {
  return (
    <EntityPicker
      label="primers"
      filter={{ category: 'primers' }}
      onCancel={onCancel}
      onSelect={(entity) =>
        onAdvance({
          entity,
          primerId: entity.id,
          primerName: entity.name,
          path: entity.path,
          localOnly: entity.localOnly,
          owningRoot: entity.projectRoot,
        })
      }
    />
  );
}

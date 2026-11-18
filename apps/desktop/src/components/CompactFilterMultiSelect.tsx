import {
  CompactFilterMultiSelect as SharedCompactFilterMultiSelect,
  type CompactFilterMultiSelectProps,
} from '@waypoint/ui-components';
import { usePresentationOverlay } from '../presentation/PresentationSurface';

export function CompactFilterMultiSelect<T extends string>(
  props: CompactFilterMultiSelectProps<T>
) {
  const presentation = usePresentationOverlay('keyboard');
  return (
    <SharedCompactFilterMultiSelect
      {...props}
      rootRef={presentation.bindRef(props.rootRef, 'menu')}
    />
  );
}

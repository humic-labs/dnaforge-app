import {
  EntityReferenceChip,
  type EntityReferenceChipProps,
} from '../entity-reference/EntityReferenceChip';

export function ChatEntityReferenceChip(
  props: Omit<EntityReferenceChipProps, 'showKindLabel' | 'iconPlacement'>
) {
  return <EntityReferenceChip {...props} showKindLabel iconPlacement="start" />;
}

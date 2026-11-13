import {
  EntityReferenceChip,
  type EntityReferenceChipProps,
} from '../entity-reference/EntityReferenceChip';

export function ChatEntityReferenceChip(
  props: Omit<EntityReferenceChipProps, 'showKindLabel' | 'iconPlacement'>
) {
  return (
    <EntityReferenceChip
      {...props}
      attachmentPhase={props.attachmentPhase ?? 'sent'}
      showKindLabel
      iconPlacement="start"
    />
  );
}

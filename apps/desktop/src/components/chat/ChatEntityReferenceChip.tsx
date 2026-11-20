import {
  EntityReferenceChip,
  type EntityReferenceChipProps,
} from '../entity-reference/EntityReferenceChip';

export function ChatEntityReferenceChip(props: EntityReferenceChipProps) {
  return <EntityReferenceChip {...props} attachmentPhase={props.attachmentPhase ?? 'sent'} />;
}

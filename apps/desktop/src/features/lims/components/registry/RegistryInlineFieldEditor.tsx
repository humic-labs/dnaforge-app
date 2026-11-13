import type { ComponentProps } from 'react';
import { EntityMetadataFieldEditor } from '../../../../shared/components/entity-metadata/EntityMetadataFieldEditor';
import { useMetadataFieldEditing } from '../../../../shared/components/entity-metadata/MetadataEditing';
import { registryFieldIsEditable } from './registry-field-values';
import { RegistryEntityLinkField } from './RegistryEntityLinkField';

type RegistryInlineFieldEditorProps = ComponentProps<typeof EntityMetadataFieldEditor> & {
  sourceEntityId?: string;
};

export function RegistryInlineFieldEditor(props: RegistryInlineFieldEditorProps) {
  return props.field.type === 'record_relationship' ? (
    <RegistryRelationshipFieldEditor {...props} />
  ) : (
    <EntityMetadataFieldEditor {...props} />
  );
}

function RegistryRelationshipFieldEditor(props: RegistryInlineFieldEditorProps) {
  const session = useMetadataFieldEditing({
    onFinish: () => {},
    onCancel: () => {},
    onEditingChange: props.onEditingChange,
    editRequestId: props.editRequestId,
    disabled: props.disabled || !props.onCommit,
  });
  return (
    <span {...session.boundaryProps} className="block min-w-0">
      <RegistryEntityLinkField
        label={props.field.label}
        value={props.value}
        sourceEntityId={props.sourceEntityId}
        disabled={props.disabled}
        required={props.field.required}
        editing={session.editing}
        triggerRef={session.triggerRef}
        menuAttributes={{ 'data-metadata-field': session.ownerId }}
        onCommit={
          registryFieldIsEditable(props.field) && props.onCommit
            ? async (value) => {
                props.onDraftChange?.({ valid: true, value });
                await props.onCommit?.(value);
              }
            : undefined
        }
        onEditingChange={(active) => (active ? session.begin() : session.finish(true))}
      />
    </span>
  );
}

import { toOptionalUserMessage, toUserMessage } from '@waypoint/user-messages';

import { useState } from 'react';
import type {
  LimsRegistryPreview,
  LimsUpdateEntityInput,
  ScientificStrainEditAuthority,
} from '../../../../shared/lims';
import {
  MetadataSection,
  type MetadataEditAction,
} from '../../../../shared/components/MetadataSection';
import { registryMetadataEditCapability } from '../../registry-metadata-edit-capability';
import { editRegistryMetadata } from '../../edit-registry-metadata';
import {
  registryRecordEditAccess,
  type RegistryEditWorkspaceFolder,
} from '../../registry-record-edit-access';
import { RegistryRecordEditor } from './RegistryRecordEditor';
import { RegistryRecordFields } from './RegistryRecordFields';

export function RegistryMetadataSection({
  preview,
  hasOriginalSource,
  busy,
  workspaceFolders,
  saveNativeRecord,
  onDocumentOpened,
}: {
  preview: LimsRegistryPreview;
  hasOriginalSource: boolean;
  busy: boolean;
  workspaceFolders: readonly RegistryEditWorkspaceFolder[];
  saveNativeRecord?: (
    input: LimsUpdateEntityInput,
    authority?: ScientificStrainEditAuthority
  ) => Promise<void>;
  onDocumentOpened?: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capability = registryMetadataEditCapability(preview, hasOriginalSource);
  const access = registryRecordEditAccess(preview.summary, workspaceFolders);
  if (capability.kind === 'native_record' && saveNativeRecord) {
    return (
      <RegistryRecordEditor
        entity={preview.entity}
        schema={preview.nativeRecord?.schemaSnapshot ?? preview.schemaSnapshot}
        scientificAuthority={preview.nativeRecord?.scientificAuthority}
        relationshipEditing={Boolean(preview.nativeRecord)}
        onSave={saveNativeRecord}
        disabled={busy || !access.canEdit}
        readOnlyReason={toOptionalUserMessage(!access.canEdit ? access.message : undefined)}
      />
    );
  }
  const open = async () => {
    if (opening || busy || !access.canEdit || capability.kind !== 'document') return;
    setOpening(true);
    setError(null);
    try {
      await editRegistryMetadata(preview.summary, capability.editor);
      onDocumentOpened?.();
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.the-metadata-editor-could-not-be-opened'));
    } finally {
      setOpening(false);
    }
  };
  const action: MetadataEditAction = !access.canEdit
    ? { kind: 'unavailable', reason: access.message }
    : capability.kind === 'unavailable'
      ? capability
      : capability.kind === 'native_record'
        ? {
            kind: 'unavailable',
            reason: 'The metadata save service is unavailable. Reopen this record to try again.',
          }
        : { kind: 'editable', disabled: busy || opening, onEdit: () => void open() };
  return (
    <MetadataSection action={action}>
      <RegistryRecordFields
        schema={preview.schemaSnapshot}
        fields={preview.summary.fieldValues}
        name={preview.summary.name}
        registryId={preview.summary.registryId}
        registrationStatus={preview.summary.registrationStatus}
      />
      {error ? (
        <p role="alert" className="text-xs text-error">
          {toUserMessage(error, 'operation.failed')}
        </p>
      ) : null}
    </MetadataSection>
  );
}

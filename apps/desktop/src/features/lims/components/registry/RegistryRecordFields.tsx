import { persistedSchemaEntityTypeLabel } from '@waypoint/scientific-artifacts/shared/entity-types';
import type { ReactNode } from 'react';
import { RegistryRecordValue as MetadataRecordValue } from '../../../../shared/components/entity-metadata/EntityMetadataFields';
import {
  MetadataFieldList,
  MetadataFieldRow,
  MetadataValue,
} from '../../../../shared/components/entity-metadata/MetadataLayout';
import type {
  EntitySchemaFieldSnapshot,
  PortableEntitySchemaRevisionSnapshot,
} from '../../../../shared/entity-schema';
import { resolvedEntitySchemaFields } from '../../../../shared/sequence-entity-schema';
import { registrationStatusLabel, type LimsRegistrationStatus } from '../../../../shared/lims';
import { RegistryEntityLinkField } from './RegistryEntityLinkField';

export function RegistryRecordFields({
  schema,
  fields,
  name,
  registryId,
  registrationStatus,
  renderField,
}: {
  schema: PortableEntitySchemaRevisionSnapshot;
  fields: Record<string, unknown>;
  name?: string;
  registryId?: string | null;
  registrationStatus?: LimsRegistrationStatus;

  renderField?: (field: EntitySchemaFieldSnapshot, value: unknown) => ReactNode;
}) {
  const schemaFields = resolvedEntitySchemaFields(schema);
  return (
    <section data-testid="lims-registry-record-fields" aria-label="Record metadata">
      <MetadataFieldList>
        {name !== undefined ? <RecordRow label="Name">{name}</RecordRow> : null}
        {name !== undefined ? <RecordRow label="ID">{registryId || '-'}</RecordRow> : null}
        {name !== undefined ? (
          <RecordRow label="Schema">{persistedSchemaEntityTypeLabel(schema)}</RecordRow>
        ) : null}
        {name !== undefined && registrationStatus && registrationStatus !== 'tracked' ? (
          <RecordRow label="Status">{registrationStatusLabel(registrationStatus)}</RecordRow>
        ) : null}
        {schemaFields.map((field) => (
          <MetadataFieldRow
            key={field.key}
            label={field.label}
            description={field.description}
            required={field.required}
          >
            {renderField ? (
              renderField(field, fields[field.key])
            ) : (
              <MetadataValue>
                <RegistryRecordValue type={field.type} value={fields[field.key]} />
              </MetadataValue>
            )}
          </MetadataFieldRow>
        ))}
      </MetadataFieldList>
    </section>
  );
}

function RecordRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <MetadataFieldRow label={label}>
      <MetadataValue>{children}</MetadataValue>
    </MetadataFieldRow>
  );
}

export function RegistryRecordValue(props: { type: string; value: unknown }) {
  return props.type === 'record_relationship' ? (
    <RegistryEntityLinkField label="Linked entity" value={props.value} />
  ) : (
    <MetadataRecordValue {...props} />
  );
}

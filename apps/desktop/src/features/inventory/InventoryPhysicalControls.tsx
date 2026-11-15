import type { ReactNode } from 'react';
import {
  validateMetadataValues,
  type InventoryCustodyDestination,
  type InventoryMetadata,
  type InventorySourceReference,
  type MetadataFieldDefinition,
} from '@waypoint/domain-services';
import { Notice, Select, TextField } from '../../components/ui';
import { EntityMetadataFieldEditor } from '../../shared/components/entity-metadata/EntityMetadataFieldEditor';
import { MetadataEditingScope } from '../../shared/components/entity-metadata/MetadataEditing';
import type { InventoryData } from './inventory-controller';
import { destinationPositions, locationPath } from './inventory-view';

export function PhysicalField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-fg-muted">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function inventoryMetadata(
  fields: readonly MetadataFieldDefinition[],
  values: Readonly<Record<string, unknown>>
): InventoryMetadata {
  const present = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  );
  const issues = validateMetadataValues(fields, present, { rejectUnknownFields: true });
  if (issues.length)
    throw new Error(
      issues
        .map((issue) => {
          const field = fields.find((field) => issue.startsWith(`${field.key} `));
          return field ? `${field.label}${issue.slice(field.key.length)}` : issue;
        })
        .join('; ')
    );
  return present as InventoryMetadata;
}

export function InventoryMetadataFields({
  fields,
  values,
  onChange,
  onValidityChange,
  prefix = 'inventory-metadata',
}: {
  fields: readonly MetadataFieldDefinition[];
  values: Readonly<Record<string, unknown>>;
  onChange(values: Readonly<Record<string, unknown>>): void;
  onValidityChange(key: string, valid: boolean): void;
  prefix?: string;
}) {
  return (
    <MetadataEditingScope>
      <div className="space-y-3" data-testid="inventory-metadata-fields">
        {fields.map((field) => (
          <div key={field.key} className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">
              {field.label}
              {field.required ? ' *' : ''}
            </p>
            <EntityMetadataFieldEditor
              field={field}
              value={values[field.key]}
              onCommit={async (value) => {
                onChange({ ...values, [field.key]: value });
                onValidityChange(field.key, true);
              }}
              onDraftChange={(draft) => {
                onValidityChange(field.key, draft.valid);
                if (draft.valid) onChange({ ...values, [field.key]: draft.value });
              }}
              triggerLabel={`Edit ${field.label}`}
              inputTestId={`${prefix}-${field.key}`}
              inputId={`${prefix}-${field.key}`}
            />
            {field.description ? (
              <p className="text-xs text-fg-muted">{field.description}</p>
            ) : null}
          </div>
        ))}
        {!fields.length ? (
          <p className="text-xs text-fg-muted">No additional fields for this type.</p>
        ) : null}
      </div>
    </MetadataEditingScope>
  );
}

export interface InventoryDestinationDraft {
  storageId: string;
  position: string;
}

export function inventoryDestinationFromDraft(
  data: InventoryData,
  draft: InventoryDestinationDraft,
  kind: 'storage' | 'vessel'
): InventoryCustodyDestination {
  if (draft.storageId === '__choose__') throw new Error('Choose a location.');
  if (!draft.storageId) return kind === 'storage' ? { kind: 'root' } : { kind: 'unplaced' };
  if (!draft.position) throw new Error('Choose a position.');
  return data.state.storage[draft.storageId]?.layout.kind === 'stack'
    ? { kind: 'stack-top', stackId: draft.storageId }
    : { kind: 'located', storageId: draft.storageId, slotId: draft.position };
}

export function InventoryDestinationFields({
  data,
  value,
  onChange,
  kind,
  itemId,
}: {
  data: InventoryData;
  value: InventoryDestinationDraft;
  onChange(value: InventoryDestinationDraft): void;
  kind: 'storage' | 'vessel';
  itemId?: string;
}) {
  const storage = data.state.storage[value.storageId];
  const positions = storage ? destinationPositions(data.state, storage, itemId) : [];
  return (
    <>
      <PhysicalField label="Location">
        <Select
          ariaLabel="Location"
          value={value.storageId}
          options={[
            { value: '__choose__', label: 'Choose a location' },
            { value: '', label: kind === 'storage' ? 'Top level' : 'Unplaced' },
            ...Object.values(data.state.storage)
              .filter(
                (item) =>
                  item.lifecycle === 'active' &&
                  item.id !== itemId &&
                  item.layout.kind !== 'fixed-well'
              )
              .map((item) => ({ value: item.id, label: locationPath(data.state, item.id) })),
          ]}
          onValueChange={(storageId) => onChange({ storageId, position: '' })}
        />
      </PhysicalField>
      {storage ? (
        <PhysicalField label="Position">
          <Select
            ariaLabel="Position"
            value={value.position}
            options={[
              { value: '', label: 'Choose a position' },
              ...positions.map((position) => ({
                value: position,
                label: position === 'top' ? 'Top of stack' : position,
              })),
            ]}
            onValueChange={(position) => onChange({ ...value, position })}
          />
        </PhysicalField>
      ) : null}
    </>
  );
}

export function inventorySourceDraft(asOf?: number): InventorySourceReference {
  return {
    url: '',
    title: '',
    locator: '',
    readAt: asOf === undefined ? '' : new Date(asOf).toISOString().slice(0, 10),
    documentRevision: null,
    sha256: null,
  };
}

export function InventorySourceFields({
  value,
  onChange,
  prefix = 'Source',
}: {
  value: InventorySourceReference;
  onChange(value: InventorySourceReference): void;
  prefix?: string;
}) {
  return (
    <fieldset className="space-y-3 rounded border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{prefix}</legend>
      {(['title', 'url', 'locator', 'readAt'] as const).map((key) => {
        const label = {
          title: 'title',
          url: 'URL',
          locator: 'page or section',
          readAt: 'read date',
        }[key];
        return (
          <PhysicalField key={key} label={`${prefix} ${label}`}>
            <TextField
              aria-label={`${prefix} ${label}`}
              type={key === 'readAt' ? 'date' : key === 'url' ? 'url' : 'text'}
              value={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              required
            />
          </PhysicalField>
        );
      })}
      <PhysicalField label={`${prefix} document revision`}>
        <TextField
          aria-label={`${prefix} document revision`}
          value={value.documentRevision ?? ''}
          onChange={(event) => onChange({ ...value, documentRevision: event.target.value || null })}
        />
      </PhysicalField>
    </fieldset>
  );
}

export function InventorySourceDetails({ source }: { source: InventorySourceReference }) {
  return (
    <div className="space-y-1 text-xs text-fg-muted">
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        className="break-all text-accent underline"
      >
        {source.title}
      </a>
      <p>
        {source.locator} · Read {source.readAt}
        {source.documentRevision ? ` · Revision ${source.documentRevision}` : ''}
      </p>
    </div>
  );
}

export function InventoryUnknownFitNotice() {
  return (
    <Notice>
      Fit is not established by a type label or an empty position. Custom equipment remains usable
      when fit is unknown.
    </Notice>
  );
}

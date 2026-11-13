import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  beginWorkspaceEditorWrite,
  registerWorkspaceEditorBlocker,
  type WorkspaceEditorBlocker,
} from '../../../../services/workspace-editor-mutation-state';
import type {
  EntitySchemaFieldSnapshot,
  ProjectableEntitySchemaRevisionSnapshot,
} from '../../../../shared/entity-schema';
import type {
  LimsEntity,
  LimsUpdateEntityInput,
  LimsRecordRelationshipTarget,
  ScientificStrainEditAuthority,
} from '../../../../shared/lims';
import { RegistryRecordFields, RegistryRecordValue } from './RegistryRecordFields';
import { RegistryRelationshipInput } from './RegistryRelationshipInput';
import { getWorkspaceRootById } from '../../../../db/workspace-catalog';
import { Button, TextField, TextArea, UI_FIELD_CLASS } from '../../../../components/ui';
import { MetadataSection } from '../../../../shared/components/MetadataSection';
import { MetadataSaveButton } from '../../../../shared/components/MetadataSaveButton';
import { metadataValuesEqual, metadataFieldDraftValue } from '../../../../shared/metadata-values';

type Draft = {
  name: string;
  fields: Record<string, unknown>;
  eventSeq: number;
  operationId: string;
  relationships: Record<string, LimsRecordRelationshipTarget | null>;
  scientificAuthority?: ScientificStrainEditAuthority;
  savedName: string;
  savedFields: Record<string, unknown>;
};

export function RegistryRecordEditor({
  entity,
  schema,
  onSave,
  disabled = false,
  scientificAuthority,
  readOnlyReason,
  relationshipEditing = true,
}: {
  entity: LimsEntity;
  schema: ProjectableEntitySchemaRevisionSnapshot;
  onSave: (
    input: LimsUpdateEntityInput,
    authority?: ScientificStrainEditAuthority
  ) => Promise<void>;
  disabled?: boolean;
  scientificAuthority?: ScientificStrainEditAuthority;
  readOnlyReason?: string;
  relationshipEditing?: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<{
    entityId: string;
    workspaceId: number | null;
    path: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getWorkspaceRootById(entity.workspaceId)
      .then((path) => {
        if (!cancelled) setOwner({ entityId: entity.id, workspaceId: entity.workspaceId, path });
      })
      .catch(() => {
        if (!cancelled) setOwner(null);
      });
    return () => {
      cancelled = true;
    };
  }, [entity.id, entity.workspaceId]);
  const capturedAuthority = draft?.scientificAuthority ?? scientificAuthority;
  const ownerPath =
    capturedAuthority?.revision.resourceId === entity.id
      ? capturedAuthority.workspaceRoot
      : owner?.entityId === entity.id && owner.workspaceId === entity.workspaceId
        ? (owner.path ?? undefined)
        : undefined;
  const blocker = useRef<WorkspaceEditorBlocker>({ entityId: entity.id, state: 'clean' });
  const hasChanges = Boolean(
    draft &&
    (draft.name.trim() !== draft.savedName.trim() ||
      !metadataValuesEqual(draft.fields, draft.savedFields) ||
      Object.keys(draft.relationships).length > 0)
  );
  blocker.current = {
    entityId: entity.id,
    path: ownerPath,
    state: busy ? 'saving' : hasChanges ? 'dirty' : 'clean',
  };
  useEffect(() => registerWorkspaceEditorBlocker(() => blocker.current), []);
  const change = (update: Partial<Pick<Draft, 'name' | 'fields' | 'relationships'>>) => {
    setDraft(
      (previous) => previous && { ...previous, ...update, operationId: crypto.randomUUID() }
    );
    setError(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy || disabled || readOnlyReason || !hasChanges) return;
    if (!draft.name.trim()) {
      setError(userMessage('failure.enter-a-name'));
      return;
    }
    setBusy(true);
    setError(null);
    let finishWrite: (() => void) | undefined;
    try {
      finishWrite = beginWorkspaceEditorWrite({ entityId: entity.id, path: ownerPath });
      const input: LimsUpdateEntityInput = {
        id: entity.id,
        name: draft.name,
        fields: Object.fromEntries(
          Object.entries(draft.fields).filter(
            ([key]) => !Object.prototype.hasOwnProperty.call(draft.relationships, key)
          )
        ),
        ...(Object.keys(draft.relationships).length
          ? {
              relationshipTargets: Object.fromEntries(
                Object.entries(draft.relationships).map(([key, target]) => [
                  key,
                  target?.id ?? null,
                ])
              ),
            }
          : {}),
        expectedEventSeq: draft.eventSeq,
        operationId: draft.operationId,
      };
      if (draft.scientificAuthority) await onSave(input, draft.scientificAuthority);
      else await onSave(input);
      setDraft(null);
    } catch (cause) {
      setError(
        toUserMessage(cause, 'failure.the-record-could-not-be-saved-your-draft-is-still-here')
      );
    } finally {
      finishWrite?.();
      setBusy(false);
    }
  };
  if (!draft)
    return (
      <MetadataSection
        action={
          readOnlyReason || entity.tombstone || entity.eventSeq === null
            ? {
                kind: 'unavailable',
                reason:
                  readOnlyReason ??
                  (entity.tombstone
                    ? 'Restore this record before editing it.'
                    : 'Refresh this record before editing. Its saved version is missing.'),
              }
            : {
                kind: 'editable',
                disabled,
                onEdit: () => {
                  setError(null);
                  if (entity.eventSeq === null) {
                    setError(
                      userMessage(
                        'failure.refresh-this-record-before-editing-its-saved-version-is-missing'
                      )
                    );
                    return;
                  }
                  setDraft({
                    name: entity.name,
                    fields: structuredClone(entity.fields),
                    eventSeq: entity.eventSeq,
                    operationId: crypto.randomUUID(),
                    relationships: {},
                    savedName: entity.name,
                    savedFields: structuredClone(entity.fields),
                    ...(scientificAuthority
                      ? { scientificAuthority: structuredClone(scientificAuthority) }
                      : {}),
                  });
                },
              }
        }
      >
        <div className="space-y-2" data-workspace-mutation-entity-id={entity.id}>
          <RegistryRecordFields
            schema={schema}
            fields={entity.fields}
            name={entity.name}
            registryId={entity.registryId}
            registrationStatus={entity.registrationStatus}
          />
          {error && (
            <p role="alert" className="text-xs text-error">
              {toUserMessage(error, 'operation.failed')}
            </p>
          )}
        </div>
      </MetadataSection>
    );
  return (
    <MetadataSection action={{ kind: 'editing' }}>
      <form
        data-workspace-mutation-entity-id={entity.id}
        aria-label="Edit record fields"
        onSubmit={(event) => void save(event)}
        className="space-y-3"
      >
        <fieldset disabled={busy || disabled} className="space-y-3">
          <label className="block space-y-1 text-xs text-fg-muted">
            <span>Name</span>
            <TextField
              aria-label="Name"
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          </label>
          {schema.fields.map((field) => (
            <div key={field.key} className="space-y-1 text-xs">
              <div className="font-medium text-fg-muted">
                {field.label}
                {field.required ? ' *' : ''}
              </div>
              {field.type === 'record_relationship' && relationshipEditing ? (
                <RegistryRelationshipInput
                  entityId={entity.id}
                  label={field.label}
                  value={
                    Object.prototype.hasOwnProperty.call(draft.relationships, field.key)
                      ? draft.relationships[field.key] === null
                        ? null
                        : { label: draft.relationships[field.key]?.name }
                      : draft.fields[field.key]
                  }
                  onChange={(target) => {
                    const original = draft.fields[field.key];
                    const unchanged =
                      target === null
                        ? original === null || original === undefined
                        : original !== null &&
                          typeof original === 'object' &&
                          'destinationEntityId' in original &&
                          original.destinationEntityId === target.id;
                    change({
                      relationships: unchanged
                        ? Object.fromEntries(
                            Object.entries(draft.relationships).filter(([key]) => key !== field.key)
                          )
                        : { ...draft.relationships, [field.key]: target },
                    });
                  }}
                />
              ) : (
                <RecordFieldInput
                  field={field}
                  value={draft.fields[field.key]}
                  onChange={(value) =>
                    change({
                      fields: {
                        ...draft.fields,
                        [field.key]: metadataFieldDraftValue(
                          field,
                          value,
                          draft.savedFields[field.key]
                        ),
                      },
                    })
                  }
                />
              )}
              {field.description && <p className="text-fg-subtle">{field.description}</p>}
            </div>
          ))}
          {error && (
            <p role="alert" className="text-xs text-error">
              {toUserMessage(error, 'operation.failed')}
            </p>
          )}
          <div className="flex items-center gap-2">
            <MetadataSaveButton type="submit" hasChanges={hasChanges} disabled={busy || disabled}>
              {busy ? 'Saving…' : 'Save changes'}
            </MetadataSaveButton>
            <Button
              type="button"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      </form>
    </MetadataSection>
  );
}

function RecordFieldInput({
  field,
  value,
  onChange,
}: {
  field: EntitySchemaFieldSnapshot;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.readOnly) return <RegistryRecordValue type={field.type} value={value} />;
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  switch (field.type) {
    case 'text':
    case 'date':
      return (
        <TextField
          aria-label={field.label}
          value={text}
          placeholder={field.type === 'date' ? 'YYYY-MM-DD' : undefined}
          onChange={(event) =>
            onChange(field.type === 'date' && !event.target.value ? null : event.target.value)
          }
        />
      );
    case 'long_text':
      return (
        <TextArea
          aria-label={field.label}
          rows={3}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case 'number':
      return (
        <TextField
          aria-label={field.label}
          type="number"
          step="any"
          min={field.minValue}
          max={field.maxValue}
          value={text}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : event.target.valueAsNumber)
          }
        />
      );
    case 'boolean':
      return (
        <select
          aria-label={field.label}
          className={UI_FIELD_CLASS}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : event.target.value === 'true')
          }
        >
          <option value="">No value</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'enum':
      return (
        <select
          aria-label={field.label}
          className={UI_FIELD_CLASS}
          value={text}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">No value</option>
          {field.enumOptions?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'string_array':
      return (
        <>
          <TextArea
            aria-label={field.label}
            rows={3}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(event) =>
              onChange(event.target.value === '' ? [] : event.target.value.split('\n'))
            }
          />
          <p className="text-fg-subtle">One value per line</p>
        </>
      );
    default:
      return (
        <div className="text-fg">
          <RegistryRecordValue type={field.type} value={value} />
          <p className="mt-1 text-fg-subtle">Preserved unchanged</p>
        </div>
      );
  }
}

import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { Button, TextField, TextArea, UI_FIELD_CLASS } from '../../../components/ui';
import { useEffect, useMemo, useState } from 'react';
import { WorkspaceFolderPicker } from '../../../components/WorkspaceFolderPicker';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsFieldDefinition,
  type LimsSchemaDefinitionView,
  type LimsRecordRelationshipValue,
} from '../../../shared/lims';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { getLimsSchemas } from '../operations';
import { RegistryEntityLinkField } from './registry/RegistryEntityLinkField';
import type { RecordEntityArtifactInput } from '../record-entity-artifact';

interface StrainCreationFormProps {
  workspaceRoot: string;
  initialSaveDir: string;
  onSave: (input: RecordEntityArtifactInput) => Promise<void>;
  onCancel: () => void;
}

const LABEL_CLASS = 'block text-sm font-medium text-fg';

function builtinStrainSchema(): LimsSchemaDefinitionView {
  const strain = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === 'strain');
  if (!strain) throw new Error('The built-in strain schema is missing.');
  return {
    schemaId: 'builtin:strain',
    currentRevisionId: 'schema-entity-strain-v1',
    entityKind: strain.name,
    baseKind: 'strain',
    displayName: strain.displayName,
    description: strain.description,
    version: 1,
    builtin: true,
    fields: strain.fields.map((field) => ({ ...field })),
  };
}

function fieldTestId(field: LimsFieldDefinition): string {
  return `strain-field-${field.key}`;
}

type FieldValue = string | boolean | LimsRecordRelationshipValue | null;
function parseFieldValue(field: LimsFieldDefinition, value: FieldValue): unknown {
  if (field.type === 'record_relationship')
    return value === '' || value === null ? undefined : value;
  if (field.type === 'boolean') return value === true;
  const text = String(value).trim();
  if (!text) return undefined;
  if (field.type === 'number') return Number(text);
  if (field.type === 'string_array') {
    return text
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return text;
}

function SchemaField({
  field,
  value,
  onChange,
  sourceEntityId,
  disabled,
}: {
  field: LimsFieldDefinition;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  sourceEntityId: string;
  disabled: boolean;
}) {
  const id = `strain-create-${field.key}`;
  if (field.type === 'record_relationship')
    return (
      <div className="space-y-2" data-testid={fieldTestId(field)}>
        <span className={LABEL_CLASS}>
          {field.label}
          {field.required ? <span className="ml-1 text-error">*</span> : null}
        </span>
        <RegistryEntityLinkField
          label={field.label}
          value={value}
          sourceEntityId={sourceEntityId}
          required={field.required}
          disabled={disabled}
          onCommit={(next) => onChange(next)}
        />
      </div>
    );

  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm text-fg" htmlFor={id}>
        <input
          id={id}
          data-testid={fieldTestId(field)}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  }

  const label = (
    <label className={LABEL_CLASS} htmlFor={id}>
      {field.label}
      {field.required && <span className="ml-1 text-error">*</span>}
    </label>
  );
  if (field.type === 'long_text') {
    return (
      <div className="space-y-2">
        {label}
        <TextArea
          id={id}
          data-testid={fieldTestId(field)}
          required={field.required}
          rows={3}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  if (field.type === 'enum') {
    return (
      <div className="space-y-2">
        {label}
        <select
          id={id}
          data-testid={fieldTestId(field)}
          required={field.required}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className={UI_FIELD_CLASS}
        >
          <option value="">Choose…</option>
          {field.enumOptions?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {label}
      <TextField
        id={id}
        data-testid={fieldTestId(field)}
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        required={field.required}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function StrainCreationForm({
  workspaceRoot,
  initialSaveDir,
  onSave,
  onCancel,
}: StrainCreationFormProps) {
  const [schema, setSchema] = useState<LimsSchemaDefinitionView>(builtinStrainSchema);
  const [schemaStatus, setSchemaStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [name, setName] = useState('');
  const [creationId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [destinationDir, setDestinationDir] = useState(initialSaveDir);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const roots = useMemo(() => {
    const mounted = workspaceFolders.map((folder) => ({ path: folder.path, name: folder.name }));
    if (mounted.length === 0) {
      mounted.push({
        path: workspaceRoot,
        name: workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot,
      });
    }
    return mounted;
  }, [workspaceFolders, workspaceRoot]);

  useEffect(() => {
    let active = true;
    getLimsSchemas()
      .then((schemas) => {
        const live = schemas.find((candidate) => candidate.entityKind === 'strain');
        if (!active) return;
        if (live) {
          setSchema(live);
          setSchemaStatus('ready');
        } else {
          setSchemaStatus('unavailable');
          setError('The strain schema is unavailable. Reopen this form to retry.');
        }
      })
      .catch((cause) => {
        if (active) {
          setSchemaStatus('unavailable');
          setError(toUserMessage(cause, 'failure.schemas-could-not-be-loaded'));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const requiredFields = schema.fields.filter((field) => field.required);
  const optionalFields = schema.fields.filter((field) => !field.required);
  const canSave =
    schemaStatus === 'ready' &&
    name.trim().length > 0 &&
    requiredFields.every((field) => String(values[field.key] ?? '').trim().length > 0) &&
    !saving;

  const save = async () => {
    if (!canSave) return;
    const owner = findContainingPathBoundary(roots, destinationDir);
    if (!owner) {
      setError(userMessage('failure.choose-a-folder-inside-an-open-project'));
      return;
    }
    const fields = Object.fromEntries(
      schema.fields
        .map((field) => [field.key, parseFieldValue(field, values[field.key] ?? '')] as const)
        .filter(([, value]) => value !== undefined)
    );
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: creationId,
        kind: 'strain',
        schemaId: schema.schemaId,
        expectedSchemaRevisionId: schema.currentRevisionId,
        name: name.trim(),
        fields,
        workspaceRoot: owner.path,
        destinationDir,
      });
    } catch (saveError) {
      setError(toUserMessage(saveError, 'failure.could-not-create-the-strain'));
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="strain-creation-form"
      data-creation-id={creationId}
      data-schema-id={schemaStatus === 'ready' ? schema.schemaId : undefined}
      data-schema-revision-id={schemaStatus === 'ready' ? schema.currentRevisionId : undefined}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {schemaStatus === 'loading' ? <p role="status">Loading strain schema…</p> : null}
        <div className="space-y-2">
          <label className={LABEL_CLASS} htmlFor="strain-create-name">
            Name <span className="text-error">*</span>
          </label>
          <TextField
            id="strain-create-name"
            data-testid="strain-name-input"
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        {requiredFields.map((field) => (
          <SchemaField
            key={field.key}
            field={field}
            sourceEntityId={creationId}
            disabled={saving}
            value={values[field.key] ?? ''}
            onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
          />
        ))}

        {optionalFields.length > 0 && (
          <details className="border-t border-border pt-3">
            <summary className="cursor-pointer select-none text-sm font-medium text-fg">
              More details
            </summary>
            <div className="mt-3 space-y-3">
              {optionalFields.map((field) => (
                <SchemaField
                  key={field.key}
                  field={field}
                  sourceEntityId={creationId}
                  disabled={saving}
                  value={values[field.key] ?? ''}
                  onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                />
              ))}
            </div>
          </details>
        )}

        <div>
          <div className={LABEL_CLASS}>Save location</div>
          <div className="mt-1">
            <WorkspaceFolderPicker
              roots={roots}
              initialDir={initialSaveDir}
              selectedDir={destinationDir}
              onSelectFolder={setDestinationDir}
              idPrefix="strain-picker"
              containerTestId="strain-save-location-picker"
            />
          </div>
        </div>

        {error && (
          <div data-testid="strain-form-error" role="alert" className="text-sm text-error">
            {toUserMessage(error, 'operation.failed')}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave} variant="primary">
          {saving ? 'Creating…' : 'Create strain'}
        </Button>
      </div>
    </form>
  );
}

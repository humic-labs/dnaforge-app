import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { Button, TextField, TextArea } from '../../components/ui';
import { useMemo, useState } from 'react';
import { WorkspaceFolderPicker } from '../../components/WorkspaceFolderPicker';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import type { LimsFieldDefinition, LimsSchemaDefinitionView } from '../../shared/lims';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { RecordEntityArtifactInput } from '../lims/public/record-entity-artifact';
import { RegistryEntityLinkField } from '../lims/public/components/registry/RegistryEntityLinkField';

interface SchemaEntityCreationFormProps {
  schema: LimsSchemaDefinitionView;
  workspaceRoot: string;
  initialSaveDir: string;
  onBack: () => void;
  onSave: (input: RecordEntityArtifactInput) => Promise<void>;
  onCancel: () => void;
}

const SIMPLE_FIELD_TYPES = new Set<LimsFieldDefinition['type']>([
  'text',
  'long_text',
  'number',
  'boolean',
  'enum',
  'date',
  'string_array',
  'record_relationship',
]);

const LABEL_CLASS = 'block text-sm font-medium text-fg';

export function supportsGenericEntityCreation(schema: LimsSchemaDefinitionView): boolean {
  return (
    schema.baseKind !== 'sequence' &&
    schema.fields.every((field) => !field.required || SIMPLE_FIELD_TYPES.has(field.type))
  );
}

function parseFieldValue(field: LimsFieldDefinition, value: unknown): unknown {
  if (field.type === 'record_relationship') return value || undefined;
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
}: {
  field: LimsFieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `schema-entity-create-${field.key}`;
  const testId = `schema-entity-field-${field.key}`;
  if (field.type === 'record_relationship')
    return (
      <div className="space-y-2">
        <span className={LABEL_CLASS}>
          {field.label}
          {field.required ? <span className="ml-1 text-error">*</span> : null}
        </span>
        <RegistryEntityLinkField
          label={field.label}
          value={value}
          required={field.required}
          onCommit={onChange}
        />
      </div>
    );
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm text-fg" htmlFor={id}>
        <input
          id={id}
          data-testid={testId}
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
          data-testid={testId}
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
        <span className="block min-w-0 w-full">
          <MenuNativeSelect
            density="form"
            id={id}
            data-testid={testId}
            required={field.required}
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Choose…</option>
            {field.enumOptions?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </MenuNativeSelect>
        </span>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {label}
      <TextField
        id={id}
        data-testid={testId}
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        required={field.required}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function SchemaEntityCreationForm({
  schema,
  workspaceRoot,
  initialSaveDir,
  onBack,
  onSave,
  onCancel,
}: SchemaEntityCreationFormProps) {
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [destinationDir, setDestinationDir] = useState(initialSaveDir);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const roots = useMemo(() => {
    const mounted = workspaceFolders
      .filter((folder) => !folder.pinned)
      .map((folder) => ({ path: folder.path, name: folder.name }));
    if (mounted.length === 0) {
      mounted.push({
        path: workspaceRoot,
        name: workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot,
      });
    }
    return mounted;
  }, [workspaceFolders, workspaceRoot]);
  const supportedFields = schema.fields.filter((field) => SIMPLE_FIELD_TYPES.has(field.type));
  const requiredFields = supportedFields.filter((field) => field.required);
  const optionalFields = supportedFields.filter((field) => !field.required);
  const deferredFields = schema.fields.filter((field) => !SIMPLE_FIELD_TYPES.has(field.type));
  const canSave =
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
      supportedFields
        .map((field) => [field.key, parseFieldValue(field, values[field.key] ?? '')] as const)
        .filter(([, value]) => value !== undefined)
    );
    setSaving(true);
    setError(null);
    try {
      await onSave({
        kind: schema.entityKind,
        schemaId: schema.schemaId,
        expectedSchemaRevisionId: schema.currentRevisionId,
        name: name.trim(),
        fields,
        workspaceRoot: owner.path,
        destinationDir,
        resolvedSchemaFields: schema.fields,
      });
    } catch (saveError) {
      setError(toUserMessage(saveError, 'operation.failed'));
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="schema-entity-creation-form"
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="text-xs text-fg-muted">{schema.description}</div>
        <div className="space-y-2">
          <label className={LABEL_CLASS} htmlFor="schema-entity-create-name">
            Name <span className="text-error">*</span>
          </label>
          <TextField
            id="schema-entity-create-name"
            data-testid="schema-entity-name-input"
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
                  value={values[field.key] ?? ''}
                  onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                />
              ))}
            </div>
          </details>
        )}

        {deferredFields.length > 0 && (
          <div className="rounded border border-border bg-bg-muted p-3 text-xs text-fg-muted">
            Additional scientific fields can be completed in the entity editor.
          </div>
        )}

        <div>
          <div className={LABEL_CLASS}>Save location</div>
          <div className="mt-1">
            <WorkspaceFolderPicker
              roots={roots}
              initialDir={initialSaveDir}
              selectedDir={destinationDir}
              onSelectFolder={setDestinationDir}
              idPrefix="schema-entity-picker"
              containerTestId="schema-entity-save-location-picker"
            />
          </div>
        </div>

        {error && (
          <div data-testid="schema-entity-form-error" role="alert" className="text-sm text-error">
            {toUserMessage(error, 'operation.failed')}
          </div>
        )}
      </div>

      <div className="flex justify-between gap-2 border-t border-border px-4 py-3">
        <Button type="button" onClick={onBack} disabled={saving}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave} variant="primary">
            {saving ? 'Creating…' : `Create ${schema.displayName}`}
          </Button>
        </div>
      </div>
    </form>
  );
}

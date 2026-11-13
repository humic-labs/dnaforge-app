import { useMemo } from 'react';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_TEXTAREA_CLASS,
  SettingsSelect,
} from '../../../components/SettingsSubsection';
import type { LimsFieldDefinition, LimsSchemaDefinitionView } from '../../../shared/lims';
import { editablePrimerSchemaFields } from '../primer-entity-schema';

export type PrimerSchemaFieldDrafts = Record<string, string | boolean>;

interface PrimerSchemaFieldsProps {
  schemas: readonly LimsSchemaDefinitionView[];
  selectedSchemaId: string;
  values: PrimerSchemaFieldDrafts;
  onSelectSchema: (schemaId: string) => void;
  onValuesChange: (values: PrimerSchemaFieldDrafts) => void;
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: LimsFieldDefinition;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `primer-schema-field-${field.key}`;
  const label = (
    <label
      htmlFor={id}
      className={`min-w-0 break-words text-xs font-medium text-fg ${field.type === 'long_text' ? 'self-start pt-2' : ''}`}
    >
      {field.label}
      {field.required ? <span className="ml-1 text-error">*</span> : null}
    </label>
  );
  if (field.type === 'boolean') {
    return (
      <>
        {label}
        <input
          id={id}
          data-testid={`entity-schema-field-${field.key}`}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-3.5 w-3.5 shrink-0 accent-accent"
        />
      </>
    );
  }
  if (field.type === 'long_text') {
    return (
      <>
        {label}
        <textarea
          id={id}
          data-testid={`entity-schema-field-${field.key}`}
          required={field.required}
          rows={3}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className={`${SETTINGS_TEXTAREA_CLASS} min-h-[72px] resize-y`}
        />
      </>
    );
  }
  if (field.type === 'enum') {
    return (
      <>
        {label}
        <SettingsSelect
          id={id}
          ariaLabel={field.label}
          testId={`entity-schema-field-${field.key}`}
          required={field.required}
          value={String(value)}
          onValueChange={onChange}
          options={[
            { value: '', label: 'Choose…' },
            ...(field.enumOptions ?? []).map((option) => ({ value: option, label: option })),
          ]}
        />
      </>
    );
  }
  return (
    <>
      {label}
      <input
        id={id}
        data-testid={`entity-schema-field-${field.key}`}
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        required={field.required}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className={SETTINGS_FIELD_CLASS}
      />
    </>
  );
}

export function PrimerSchemaFields({
  schemas,
  selectedSchemaId,
  values,
  onSelectSchema,
  onValuesChange,
}: PrimerSchemaFieldsProps) {
  const schema = schemas.find((candidate) => candidate.schemaId === selectedSchemaId) ?? schemas[0];
  const editableFields = useMemo(
    () => (schema ? editablePrimerSchemaFields(schema) : []),
    [schema]
  );

  if (!schema) return null;
  const updateValue = (key: string, value: string | boolean) =>
    onValuesChange({ ...values, [key]: value });

  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-border pt-3"
      data-testid="primer-schema-fields"
    >
      <label htmlFor="primer-schema-select" className="text-xs font-medium text-fg">
        Schema *
      </label>
      <SettingsSelect
        id="primer-schema-select"
        ariaLabel="Schema"
        required
        testId="primer-schema-select"
        value={schema.schemaId}
        onValueChange={onSelectSchema}
        options={schemas.map((candidate) => ({
          value: candidate.schemaId,
          label: candidate.displayName,
        }))}
      />

      {editableFields.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          onChange={(value) => updateValue(field.key, value)}
        />
      ))}
    </div>
  );
}

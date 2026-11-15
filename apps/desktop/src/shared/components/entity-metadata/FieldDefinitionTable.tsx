import { Button, TextField, TextArea, Select } from '../../../components/ui';
import type { MetadataFieldDefinition } from '@waypoint/domain-services';

export interface FieldDefinitionDraft<Definition extends MetadataFieldDefinition<string>> {
  id: string;
  definition: Definition;
  autoKey: boolean;
}

export function fieldKeyFromLabel(value: string): string {
  const parts = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1)
    )
    .join('');
}

const FIELD_ROW_CLASS =
  'grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_7rem_4rem_2rem] items-center gap-2 px-3';

export function FieldDefinitionTable<Definition extends MetadataFieldDefinition<string>>({
  title,
  fields,
  testId,
  draftFields,
  onFieldsChange,
  disabled = false,
  editableTypes,
  typeLabels,
  createField,
}: {
  title: string;
  fields: readonly Definition[];
  testId: string;
  draftFields?: FieldDefinitionDraft<Definition>[];
  onFieldsChange?: (fields: FieldDefinitionDraft<Definition>[]) => void;
  disabled?: boolean;
  editableTypes: readonly { value: Definition['type']; label: string }[];
  typeLabels: Readonly<Record<string, string>>;
  createField(): FieldDefinitionDraft<Definition>;
}) {
  const rows =
    draftFields ?? fields.map((definition) => ({ id: definition.key, definition, autoKey: false }));
  const editing = draftFields !== undefined;
  const change = (
    index: number,
    update: (field: FieldDefinitionDraft<Definition>) => FieldDefinitionDraft<Definition>
  ) => {
    if (draftFields && !disabled)
      onFieldsChange?.(
        draftFields.map((field, fieldIndex) => (fieldIndex === index ? update(field) : field))
      );
  };
  return (
    <section data-testid={testId} className="mb-6">
      <div className="mb-2 flex h-9 items-center justify-between">
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        {editing ? (
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (draftFields) onFieldsChange?.([...draftFields, createField()]);
            }}
          >
            Add field
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <div role="table" aria-label={title} className="min-w-[25rem]">
          <div
            role="row"
            className={`${FIELD_ROW_CLASS} border-b border-border bg-bg-subtle py-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted`}
          >
            <span role="columnheader">Field</span>
            <span role="columnheader">Key</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Required</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {rows.map((field, index) => (
            <div
              key={field.id}
              role="row"
              data-schema-field-row={field.id}
              className={`${FIELD_ROW_CLASS} border-b border-border py-2.5 text-sm last:border-b-0`}
            >
              <div role="cell" className="min-w-0">
                {editing ? (
                  <TextField
                    aria-label={`Field ${index + 1} label`}
                    value={field.definition.label}
                    disabled={disabled}
                    onChange={(event) =>
                      change(index, (item) => ({
                        ...item,
                        definition: {
                          ...item.definition,
                          label: event.target.value,
                          key: item.autoKey
                            ? fieldKeyFromLabel(event.target.value)
                            : item.definition.key,
                        },
                      }))
                    }
                  />
                ) : (
                  <span className="flex h-10 min-w-0 items-center truncate text-fg">
                    {field.definition.label}
                  </span>
                )}
              </div>
              <div role="cell" className="min-w-0">
                {editing ? (
                  <TextField
                    monospace
                    aria-label={`Field ${index + 1} key`}
                    value={field.definition.key}
                    disabled={disabled}
                    onChange={(event) =>
                      change(index, (item) => ({
                        ...item,
                        autoKey: false,
                        definition: { ...item.definition, key: event.target.value },
                      }))
                    }
                  />
                ) : (
                  <span
                    className="flex h-10 min-w-0 items-center truncate font-mono text-[11px] text-fg-muted"
                    title={field.definition.key}
                  >
                    {field.definition.key}
                  </span>
                )}
              </div>
              <div role="cell" className="min-w-0">
                {editing ? (
                  <Select
                    value={field.definition.type}
                    ariaLabel={`Field ${index + 1} type`}
                    disabled={disabled}
                    options={
                      editableTypes.some((option) => option.value === field.definition.type)
                        ? editableTypes
                        : [
                            ...editableTypes,
                            {
                              value: field.definition.type,
                              label: typeLabels[field.definition.type],
                            },
                          ]
                    }
                    onValueChange={(value) => {
                      const type = editableTypes.find((option) => option.value === value)?.value;
                      if (type)
                        change(index, (item) => ({
                          ...item,
                          definition: {
                            ...item.definition,
                            type,
                            enumOptions:
                              type === 'enum' ? (item.definition.enumOptions ?? []) : undefined,
                          },
                        }));
                    }}
                  />
                ) : (
                  <span className="flex h-10 items-center text-xs text-fg-muted">
                    {typeLabels[field.definition.type]}
                  </span>
                )}
              </div>
              <div role="cell" className="flex h-10 items-center text-xs text-fg-muted">
                {editing ? (
                  <input
                    type="checkbox"
                    aria-label={`Field ${index + 1} required`}
                    checked={Boolean(field.definition.required)}
                    disabled={disabled}
                    onChange={(event) =>
                      change(index, (item) => ({
                        ...item,
                        definition: { ...item.definition, required: event.target.checked },
                      }))
                    }
                    className="accent-accent"
                  />
                ) : field.definition.required ? (
                  'Yes'
                ) : (
                  '—'
                )}
              </div>
              <div role="cell" className="flex h-10 items-center">
                {editing ? (
                  <Button
                    type="button"
                    aria-label={`Remove field ${index + 1}`}
                    disabled={disabled}
                    onClick={() => {
                      if (draftFields)
                        onFieldsChange?.(draftFields.filter((_, candidate) => candidate !== index));
                    }}
                  >
                    ×
                  </Button>
                ) : null}
              </div>
              {field.definition.type === 'enum' ? (
                <label className="col-span-5 flex flex-col gap-1 text-xs font-medium text-fg-muted">
                  Choices (one per line)
                  <TextArea
                    value={(field.definition.enumOptions ?? []).join('\n')}
                    readOnly={!editing}
                    disabled={disabled}
                    rows={2}
                    onChange={(event) =>
                      change(index, (item) => ({
                        ...item,
                        definition: {
                          ...item.definition,
                          enumOptions: event.target.value.split('\n'),
                        },
                      }))
                    }
                  />
                </label>
              ) : null}
            </div>
          ))}
          {rows.length === 0 ? (
            <div className="px-3 py-3 text-xs text-fg-muted">No schema fields</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

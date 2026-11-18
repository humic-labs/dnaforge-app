import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextField, TextArea, Select } from '../../../../components/ui';
import type {
  LimsFieldDefinition,
  LimsFieldType,
  LimsSchemaDefinitionView,
} from '../../../../shared/lims';
import {
  SEQUENCE_INTRINSIC_FIELD_DEFINITIONS,
  isDerivedSequencePropertyField,
} from '../../../../shared/sequence-entity-schema';
import { SchemaOriginBadge } from '../../../../shared/components/SchemaOriginBadge';
import { defineLimsSchema, refineLimsSchema } from '../../operations';
import type { RegistrySchemaSource } from './registry-schema-library-types';

interface FieldDraft {
  id: string;
  definition: LimsFieldDefinition;
  autoKey: boolean;
}

interface SchemaDraft {
  mode: 'create' | 'revise';
  sourceId: string;
  schemaId?: string;
  expectedRevisionId?: string;
  name: string;
  autoName: boolean;
  displayName: string;
  baseKind: 'sequence' | 'record';
  description: string;
  fields: FieldDraft[];
}

const EDITABLE_TYPES: { value: LimsFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'long_text', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' },
  { value: 'enum', label: 'Choice' },
  { value: 'string_array', label: 'Text list' },
  { value: 'record_relationship', label: 'Entity link' },
];

const FIELD_TYPE_LABELS: Record<LimsFieldType, string> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  boolean: 'Yes / no',
  enum: 'Choice',
  date: 'Date',
  datetime: 'Date and time',
  dna_sequence: 'DNA sequence',
  rna_sequence: 'RNA sequence',
  protein_sequence: 'Protein sequence',
  quantity: 'Quantity',
  record_relationship: 'Entity link',
  attachment_reference: 'Attachment',
  formula_result: 'Formula result',
  string_array: 'Text list',
  genetic_code: 'Genetic code',
};

function keyFromLabel(value: string): string {
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

function schemaNameFromLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function newField(): FieldDraft {
  return {
    id: `new-${++nextDraftFieldId}`,
    definition: { key: '', label: '', type: 'text', required: false },
    autoKey: true,
  };
}

let nextDraftFieldId = 0;

function schemaDraftFor(schema: LimsSchemaDefinitionView, sourceId: string): SchemaDraft {
  return {
    mode: 'revise',
    sourceId,
    schemaId: schema.schemaId,
    expectedRevisionId: schema.currentRevisionId,
    name: schema.entityKind,
    autoName: false,
    displayName: schema.displayName,
    baseKind: schema.baseKind === 'sequence' ? 'sequence' : 'record',
    description: schema.description ?? '',
    fields: schema.fields
      .filter((definition) => !isDerivedSequencePropertyField(schema, definition))
      .map((definition) => ({
        id: definition.key,
        definition: { ...definition },
        autoKey: false,
      })),
  };
}

function validateDraft(
  draft: SchemaDraft,
  schemas: LimsSchemaDefinitionView[]
): UserMessage | null {
  if (!draft.displayName.trim()) return userMessage('assembly.schemaName');
  if (draft.mode === 'create' && !/^[a-z][a-z0-9_]*$/.test(draft.name)) {
    return userMessage('registry.schema.keyFormat');
  }
  if (draft.mode === 'create' && schemas.some((schema) => schema.entityKind === draft.name)) {
    return userMessageWithValues('registry.schema.duplicateKey', {
      key: userMessageValue(draft.name),
    });
  }
  if (draft.baseKind === 'record' && draft.fields.length === 0) {
    return userMessage('registry.schema.needsField');
  }
  const keys = new Set<string>();
  const inheritedKeys = new Set<string>(
    draft.baseKind === 'sequence'
      ? SEQUENCE_INTRINSIC_FIELD_DEFINITIONS.map((field) => field.key)
      : []
  );
  for (const { definition } of draft.fields) {
    if (isDerivedSequencePropertyField(draft, definition)) {
      return userMessage('guidance.sequence-property-keys-cannot-be-schema-fields');
    }
    if (!definition.label.trim()) return userMessage('registry.schema.fieldLabelRequired');
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(definition.key)) {
      return userMessage('registry.schema.fieldKeyFormat');
    }
    if (keys.has(definition.key) || inheritedKeys.has(definition.key)) {
      return userMessage('guidance.field-keys-must-be-unique-including-inherited-fields');
    }
    keys.add(definition.key);
    if (
      definition.type === 'enum' &&
      !definition.enumOptions?.some((option) => option.trim().length > 0)
    ) {
      return userMessageWithValues('registry.schema.fieldNeedsChoice', {
        label: userMessageValue(definition.label),
      });
    }
  }
  return null;
}

function updateField(
  current: FieldDraft[],
  index: number,
  update: (field: FieldDraft) => FieldDraft
): FieldDraft[] {
  return current.map((field, fieldIndex) => (fieldIndex === index ? update(field) : field));
}

export function RegistrySchemaManager({
  schemas,
  initialKind,
  onChanged,
  onDefine = defineLimsSchema,
  onRefine = refineLimsSchema,
  readOnly = false,
  sources = [],
}: {
  schemas: LimsSchemaDefinitionView[];
  initialKind?: string;
  onChanged: () => Promise<void> | void;
  onClose?: () => void;
  onDefine?: typeof defineLimsSchema;
  onRefine?: typeof refineLimsSchema;
  readOnly?: boolean;
  sources?: RegistrySchemaSource[];
}) {
  const resolvedSources = useMemo<RegistrySchemaSource[]>(
    () => [
      { id: 'independent', label: 'Independent', schemas, readOnly, onDefine, onRefine, onChanged },
      ...sources,
    ],
    [schemas, readOnly, onDefine, onRefine, onChanged, sources]
  );
  const sourcesRef = useRef(resolvedSources);
  sourcesRef.current = resolvedSources;
  const entries = useMemo(
    () => resolvedSources.flatMap((source) => source.schemas.map((schema) => ({ schema, source }))),
    [resolvedSources]
  );
  const [selection, setSelection] = useState({
    sourceId: 'independent',
    schemaId: '',
    kind:
      initialKind ??
      (schemas.some((schema) => schema.entityKind === 'sequence')
        ? 'sequence'
        : (schemas[0]?.entityKind ?? '')),
  });
  const [draft, setDraft] = useState<SchemaDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemaSearch, setSchemaSearch] = useState('');
  const [schemaOrigin, setSchemaOrigin] = useState<'all' | 'default' | 'custom'>('all');
  const selectedEntry =
    entries.find(
      ({ schema, source }) =>
        source.id === selection.sourceId &&
        (selection.schemaId
          ? schema.schemaId === selection.schemaId
          : schema.entityKind === selection.kind)
    ) ?? entries[0];
  const selected = selectedEntry?.schema;
  const draftSource = resolvedSources.find((source) => source.id === draft?.sourceId);
  const visibleDraft = draftSource ? draft : null;
  const draftReadOnly = !draftSource || Boolean(draftSource.readOnly);
  const editableSources = resolvedSources.filter((source) => !source.readOnly);
  const sourceAccessKey = resolvedSources
    .map((source) => `${source.id}:${source.readOnly ? 'read' : 'edit'}`)
    .join('|');
  useEffect(() => {
    if (draft && !sourcesRef.current.some((source) => source.id === draft.sourceId)) {
      setDraft(null);
      setError(
        userMessage('failure.the-organization-changed-select-the-schema-again-to-continue-editing')
      );
    }
  }, [draft, sourceAccessKey]);
  const sortedEntries = useMemo(
    () =>
      entries
        .filter(
          ({ schema, source }) =>
            (schemaOrigin === 'all' || schema.builtin === (schemaOrigin === 'default')) &&
            `${schema.displayName} ${schema.entityKind} ${source.label}`
              .toLocaleLowerCase()
              .includes(schemaSearch.trim().toLocaleLowerCase())
        )
        .sort(
          (left, right) =>
            left.schema.displayName.localeCompare(right.schema.displayName) ||
            left.source.label.localeCompare(right.source.label)
        ),
    [entries, schemaOrigin, schemaSearch]
  );

  const startCreate = () => {
    const source =
      selectedEntry && !selectedEntry.source.readOnly ? selectedEntry.source : editableSources[0];
    if (!source) return;
    setSchemaSearch('');
    setSchemaOrigin('all');
    setDraft({
      mode: 'create',
      sourceId: source.id,
      name: '',
      autoName: true,
      displayName: '',
      baseKind: 'record',
      description: '',
      fields: [],
    });
    setError(null);
  };

  const save = async () => {
    if (!draft || busy) return;
    const source = sourcesRef.current.find((item) => item.id === draft.sourceId);
    if (!source || source.readOnly) return;
    if (draft.mode === 'revise') {
      const current = source.schemas.find((schema) => schema.schemaId === draft.schemaId);
      if (!current || current.currentRevisionId !== draft.expectedRevisionId) {
        setError(
          userMessage(
            'failure.this-schema-changed-cancel-and-edit-its-current-version-before-saving'
          )
        );
        return;
      }
    }
    const problem = validateDraft(draft, source.schemas);
    if (problem) {
      setError(problem);
      return;
    }
    const fields = draft.fields.map(({ definition }) => ({
      ...Object.fromEntries(Object.entries(definition).filter(([, value]) => value !== undefined)),
      type: definition.type,
      label: definition.label.trim(),
      key: definition.key.trim(),
      ...(definition.type === 'enum'
        ? {
            enumOptions: [
              ...new Set((definition.enumOptions ?? []).map((item) => item.trim()).filter(Boolean)),
            ],
          }
        : {}),
    }));
    setBusy(true);
    setError(null);
    try {
      if (draft.mode === 'create') {
        await source.onDefine({
          kind: 'entity',
          name: draft.name,
          displayName: draft.displayName.trim(),
          baseKind: draft.baseKind === 'sequence' ? 'sequence' : draft.name,
          description: draft.description.trim() || null,
          fields,
          existingPolicy: 'reject',
        });
        await source.onChanged();
        if (sourcesRef.current.some((item) => item.id === source.id)) {
          setSelection({ sourceId: source.id, schemaId: '', kind: draft.name });
        }
      } else if (draft.schemaId && draft.expectedRevisionId) {
        await source.onRefine({
          schemaId: draft.schemaId,
          expectedRevisionId: draft.expectedRevisionId,
          description: draft.description.trim() || null,
          fields,
        });
        await source.onChanged();
      }
      setDraft(null);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.schema-could-not-be-saved'));
    } finally {
      setBusy(false);
    }
  };

  const creating = visibleDraft?.mode === 'create';
  const editing = visibleDraft?.mode === 'revise';
  const changeFields = (fields: FieldDraft[]) => {
    setDraft((current) => (current ? { ...current, fields } : current));
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  const ownFields =
    selected?.fields.filter((field) => !isDerivedSequencePropertyField(selected, field)) ?? [];

  return (
    <section
      role="region"
      aria-label="Registry schemas"
      data-testid="registry-schema-manager"
      className="flex min-h-[32rem] min-w-0 flex-col bg-bg"
    >
      <header className="flex shrink-0 items-center justify-between py-3">
        <h2 className="text-base font-semibold text-fg">Schemas</h2>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Schema types"
          className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-subtle/40"
        >
          <div className="border-b border-border p-3">
            <div className="grid flex-1">
              <Button
                type="button"
                onClick={startCreate}
                aria-label="New schema"
                disabled={editableSources.length === 0 || busy}
              >
                + New schema
              </Button>
            </div>
          </div>
          <div className="space-y-2 px-3 pt-3">
            <TextField
              type="search"
              aria-label="Search schemas"
              placeholder="Find a schema…"
              value={schemaSearch}
              onChange={(event) => setSchemaSearch(event.target.value)}
            />
            <Select
              ariaLabel="Schema origin"
              value={schemaOrigin}
              onValueChange={(value) =>
                setSchemaOrigin(value === 'default' || value === 'custom' ? value : 'all')
              }
              options={[
                { value: 'all', label: 'All schemas' },
                { value: 'default', label: 'Default schemas' },
                { value: 'custom', label: 'Custom schemas' },
              ]}
            />
          </div>
          <div className="max-h-[32rem] min-h-0 overflow-y-auto p-2">
            {sortedEntries.length === 0 ? (
              <p className="px-3 py-6 text-xs text-fg-muted">No matching schemas.</p>
            ) : null}
            {sortedEntries.map(({ schema, source }) => (
              <button
                key={`${source.id}:${schema.schemaId}`}
                type="button"
                data-testid={`registry-schema-${source.id === 'independent' ? '' : source.id + '-'}${schema.entityKind}`}
                disabled={busy}
                onClick={() => {
                  setSelection({
                    sourceId: source.id,
                    schemaId: schema.schemaId,
                    kind: schema.entityKind,
                  });
                  cancel();
                }}
                aria-current={
                  !creating &&
                  selectedEntry?.source.id === source.id &&
                  selected?.schemaId === schema.schemaId
                    ? 'page'
                    : undefined
                }
                className={`mb-0.5 block w-full rounded px-3 py-2 text-left text-sm ${!creating && selectedEntry?.source.id === source.id && selected?.schemaId === schema.schemaId ? 'bg-accent/10 font-medium text-accent' : 'text-fg hover:bg-bg-muted'}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 break-words">{schema.displayName}</span>
                  <SchemaOriginBadge builtin={schema.builtin} />
                </span>
                <span className="mt-0.5 block break-words text-[11px] font-normal text-fg-muted">
                  {schema.entityKind} · v{schema.version}
                  {sources.length > 0 ? <span className="mt-0.5 block">{source.label}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3">
          {selected || creating ? (
            <div className="mx-auto max-w-3xl">
              <div className="mb-4 flex min-h-16 items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-xl font-semibold text-fg">
                    {creating ? 'New schema' : selected?.displayName}
                  </h3>
                  {!creating && selected ? (
                    <div className="mt-1 text-xs text-fg-muted">
                      <SchemaOriginBadge builtin={selected.builtin} /> · {selected.entityKind} · v
                      {selected.version} ·{' '}
                      {selected.baseKind === 'sequence' ? 'DNA sequence' : 'Independent record'}
                      {sources.length > 0 ? (
                        <span className="mt-1 block">Managed by {selectedEntry?.source.label}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex w-44 shrink-0 justify-end gap-2">
                  {visibleDraft ? (
                    <>
                      <Button type="button" onClick={cancel} disabled={busy}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        type="button"
                        onClick={() => void save()}
                        disabled={busy || draftReadOnly}
                      >
                        {creating ? 'Create schema' : 'Save changes'}
                      </Button>
                    </>
                  ) : selected ? (
                    <Button
                      type="button"
                      disabled={selectedEntry?.source.readOnly}
                      onClick={() => {
                        if (selectedEntry)
                          setDraft(schemaDraftFor(selected, selectedEntry.source.id));
                        setError(null);
                      }}
                    >
                      Edit schema
                    </Button>
                  ) : null}
                </div>
              </div>

              {creating && visibleDraft ? (
                <div className="mb-6 grid gap-4 sm:grid-cols-2">
                  {editableSources.length > 1 ? (
                    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-fg-muted sm:col-span-2">
                      Managed by
                      <Select
                        ariaLabel="Schema owner"
                        value={visibleDraft.sourceId}
                        disabled={busy}
                        options={editableSources.map((source) => ({
                          value: source.id,
                          label: source.label,
                        }))}
                        onValueChange={(sourceId) =>
                          setDraft((current) =>
                            current?.mode === 'create' ? { ...current, sourceId } : current
                          )
                        }
                      />
                    </label>
                  ) : null}
                  <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-fg-muted">
                    Schema name
                    <TextField
                      value={visibleDraft.displayName}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                displayName: event.target.value,
                                name: current.autoName
                                  ? schemaNameFromLabel(event.target.value)
                                  : current.name,
                              }
                            : current
                        )
                      }
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-fg-muted">
                    Schema key
                    <TextField
                      monospace
                      value={visibleDraft.name}
                      disabled={busy}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? { ...current, name: event.target.value, autoName: false }
                            : current
                        )
                      }
                    />
                  </label>
                  <fieldset className="sm:col-span-2" disabled={busy}>
                    <legend className="mb-2 text-xs font-medium text-fg-muted">
                      Record family
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(
                        [
                          { value: 'record', label: 'Independent record' },
                          { value: 'sequence', label: 'DNA sequence' },
                        ] as const
                      ).map((option) => (
                        <label
                          key={option.value}
                          className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm ${visibleDraft.baseKind === option.value ? 'border-accent bg-accent/5 text-accent' : 'border-border text-fg hover:border-fg-muted'}`}
                        >
                          <input
                            type="radio"
                            name="schema-base-kind"
                            value={option.value}
                            checked={visibleDraft.baseKind === option.value}
                            onChange={() =>
                              setDraft((current) =>
                                current ? { ...current, baseKind: option.value } : current
                              )
                            }
                            className="accent-accent"
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
              ) : null}

              <label className="mb-6 flex flex-col gap-1 text-xs font-medium text-fg-muted">
                Description
                <TextArea
                  aria-label="Schema description"
                  value={visibleDraft?.description ?? selected?.description ?? ''}
                  placeholder="No description"
                  readOnly={!visibleDraft}
                  disabled={
                    busy || (visibleDraft ? draftReadOnly : Boolean(selectedEntry?.source.readOnly))
                  }
                  rows={2}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, description: event.target.value } : current
                    )
                  }
                />
              </label>

              {(visibleDraft?.baseKind ?? selected?.baseKind) === 'sequence' ? (
                <FieldTable
                  title="DNA sequence fields"
                  fields={SEQUENCE_INTRINSIC_FIELD_DEFINITIONS}
                  testId="schema-inherited-fields"
                />
              ) : null}
              <FieldTable
                title="Schema fields"
                fields={ownFields}
                testId="schema-own-fields"
                draftFields={visibleDraft?.fields}
                onFieldsChange={changeFields}
                disabled={
                  busy || (visibleDraft ? draftReadOnly : Boolean(selectedEntry?.source.readOnly))
                }
              />
              {error ? (
                <p
                  role="alert"
                  className="rounded border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
                >
                  {toUserMessage(error, 'operation.failed')}
                </p>
              ) : null}
              <span className="sr-only" role="status">
                {editing ? 'Editing schema' : ''}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const FIELD_ROW_CLASS =
  'grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_7rem_4rem_2rem] items-center gap-2 px-3';

function FieldTable({
  title,
  fields,
  testId,
  draftFields,
  onFieldsChange,
  disabled = false,
}: {
  title: string;
  fields: readonly LimsFieldDefinition[];
  testId: string;
  draftFields?: FieldDraft[];
  onFieldsChange?: (fields: FieldDraft[]) => void;
  disabled?: boolean;
}) {
  const rows =
    draftFields ?? fields.map((definition) => ({ id: definition.key, definition, autoKey: false }));
  const editing = draftFields !== undefined;
  const change = (index: number, update: (field: FieldDraft) => FieldDraft) => {
    if (draftFields && !disabled) onFieldsChange?.(updateField(draftFields, index, update));
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
              if (draftFields) onFieldsChange?.([...draftFields, newField()]);
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
                            ? keyFromLabel(event.target.value)
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
                      EDITABLE_TYPES.some((option) => option.value === field.definition.type)
                        ? EDITABLE_TYPES
                        : [
                            ...EDITABLE_TYPES,
                            {
                              value: field.definition.type,
                              label: FIELD_TYPE_LABELS[field.definition.type],
                            },
                          ]
                    }
                    onValueChange={(value) => {
                      const type = EDITABLE_TYPES.find((option) => option.value === value)?.value;
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
                    {FIELD_TYPE_LABELS[field.definition.type]}
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

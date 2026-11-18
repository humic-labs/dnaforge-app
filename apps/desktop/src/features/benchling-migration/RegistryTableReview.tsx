import { MenuNativeSelect } from '@waypoint/ui-components';
import { useState } from 'react';
import {
  parseRegistryTableMappingDecision,
  type RegistryTableColumnChoice,
  type RegistryTableMappingDecision,
  type RegistryTableReviewCandidate,
} from '../../shared/benchling-registry-table-review';

const FIELD_TYPES = [
  ['text', 'Text'],
  ['long_text', 'Long text'],
  ['number', 'Number'],
  ['boolean', 'True / false'],
  ['date', 'Date'],
  ['string_array', 'Text list (JSON)'],
  ['record_relationship', 'Benchling record link'],
] as const;
type FieldType = (typeof FIELD_TYPES)[number][0];
type ColumnDraft = {
  role: '' | 'name' | 'provider_id' | 'source_only' | FieldType;
  label: string;
  reason: string;
};
type Draft = {
  kind: '' | 'records' | 'source_only';
  reason: string;
  columns: readonly ColumnDraft[];
};
const inputClass = 'min-w-0 rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg';

export function RegistryTableReview({
  candidate,
  pending,
  onChange,
}: {
  candidate: RegistryTableReviewCandidate;
  pending: boolean;
  onChange(decision: RegistryTableMappingDecision | null): void;
}) {
  const [draft, setDraft] = useState<Draft>({
    kind: '',
    reason: '',
    columns:
      candidate.status === 'ready'
        ? candidate.headers.map((label) => ({ role: '', label, reason: '' }))
        : [],
  });
  const [visibleCount, setVisibleCount] = useState(20);
  function update(next: Draft) {
    setDraft(next);
    onChange(decisionForDraft(candidate, next));
  }
  function updateColumn(index: number, change: Partial<ColumnDraft>) {
    update({
      ...draft,
      columns: draft.columns.map((column, ordinal) =>
        ordinal === index ? { ...column, ...change } : column
      ),
    });
  }
  return (
    <fieldset
      disabled={pending}
      className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-subtle p-3"
    >
      <legend className="max-w-full break-all px-1 text-sm font-semibold text-fg">
        {candidate.entryPath}
      </legend>
      {candidate.status === 'ready' ? (
        <p className="text-xs text-fg-muted">
          {candidate.rowCount.toLocaleString()} rows · {candidate.headers.length} columns. Choose
          each column’s purpose. Original cells stay unchanged in the ZIP.
        </p>
      ) : (
        <p className="text-sm text-fg-muted">{candidate.reason}</p>
      )}
      <label className="flex flex-wrap items-center gap-2 text-sm text-fg">
        Import as
        <span className="inline-block min-w-0">
          <MenuNativeSelect
            density="form"
            aria-label={`How to import ${candidate.entryPath}`}
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value;
              if (kind === '' || kind === 'records' || kind === 'source_only')
                update({ ...draft, kind });
            }}
          >
            <option value="">Choose…</option>
            {candidate.status === 'ready' ? (
              <option value="records">Registry records</option>
            ) : null}
            <option value="source_only">Keep in original ZIP only</option>
          </MenuNativeSelect>
        </span>
      </label>
      {draft.kind === 'source_only' ? (
        <label className="grid gap-1 text-xs text-fg-muted">
          Reason
          <input
            aria-label={`Reason for keeping ${candidate.entryPath} in the original ZIP`}
            className={inputClass}
            maxLength={512}
            value={draft.reason}
            onChange={(event) => update({ ...draft, reason: event.target.value })}
          />
        </label>
      ) : null}
      {draft.kind === 'records' && candidate.status === 'ready' ? (
        <>
          <p className="text-xs text-fg-muted">
            Choose exactly one Name column. Choose a Benchling ID only if the export contains
            genuine record IDs.
          </p>
          <div className="max-h-80 space-y-2 overflow-auto">
            {draft.columns.slice(0, visibleCount).map((column, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-2"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-fg">
                    {index + 1}. {candidate.headers[index] || '(empty header)'}
                  </p>
                  <p className="break-words text-xs text-fg-muted">
                    {candidate.previewRows
                      .map((row) => (row[index] === '' ? '(empty)' : row[index]))
                      .join(' · ') || 'No rows'}
                  </p>
                </div>
                <div className="grid gap-1">
                  <span className="inline-block min-w-0">
                    <MenuNativeSelect
                      density="form"
                      aria-label={`Column ${index + 1} role`}
                      value={column.role}
                      onChange={(event) => {
                        const role = event.target.value;
                        if (isColumnRole(role)) updateColumn(index, { role });
                      }}
                    >
                      <option value="">Choose a purpose…</option>
                      <option value="name">Record name</option>
                      <option value="provider_id">Benchling ID</option>
                      {FIELD_TYPES.map(([type, label]) => (
                        <option key={type} value={type}>
                          {label}
                        </option>
                      ))}
                      <option value="source_only">Keep in original ZIP only</option>
                    </MenuNativeSelect>
                  </span>
                  {isFieldType(column.role) ? (
                    <input
                      aria-label={`Column ${index + 1} field name`}
                      className={inputClass}
                      maxLength={512}
                      value={column.label}
                      onChange={(event) => updateColumn(index, { label: event.target.value })}
                    />
                  ) : null}
                  {column.role === 'source_only' ? (
                    <input
                      aria-label={`Column ${index + 1} reason`}
                      placeholder="Reason"
                      className={inputClass}
                      maxLength={512}
                      value={column.reason}
                      onChange={(event) => updateColumn(index, { reason: event.target.value })}
                    />
                  ) : null}
                </div>
              </div>
            ))}
            {visibleCount < draft.columns.length ? (
              <button
                type="button"
                className="text-sm text-accent"
                onClick={() => setVisibleCount((count) => count + 20)}
              >
                Show more columns ({draft.columns.length - visibleCount} remaining)
              </button>
            ) : null}
          </div>
          {!decisionForDraft(candidate, draft) ? (
            <p role="status" className="text-xs text-fg-muted">
              Choose one Name column and a purpose for every column. Fields need a name; source-only
              columns need a reason.
            </p>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}

function isFieldType(value: string): value is FieldType {
  return FIELD_TYPES.some(([type]) => type === value);
}
function isColumnRole(value: string): value is ColumnDraft['role'] {
  return (
    value === '' ||
    value === 'name' ||
    value === 'provider_id' ||
    value === 'source_only' ||
    isFieldType(value)
  );
}
function decisionForDraft(
  candidate: RegistryTableReviewCandidate,
  draft: Draft
): RegistryTableMappingDecision | null {
  const { archiveSha256, entryPath, entrySha256, entrySizeBytes } = candidate;
  const source = { archiveSha256, entryPath, entrySha256, entrySizeBytes };
  try {
    if (draft.kind === 'source_only')
      return parseRegistryTableMappingDecision({
        kind: 'registry_table_mapping',
        version: 1,
        source,
        outcome: { kind: 'source_only', reason: draft.reason },
      });
    if (
      draft.kind !== 'records' ||
      candidate.status !== 'ready' ||
      draft.columns.some((column) => !column.role)
    )
      return null;
    const columns = draft.columns.map((column): RegistryTableColumnChoice => {
      if (column.role === 'name' || column.role === 'provider_id') return { kind: column.role };
      if (column.role === 'source_only') return { kind: 'source_only', reason: column.reason };
      if (isFieldType(column.role))
        return { kind: 'field', label: column.label, type: column.role };
      throw new Error('A column needs a purpose.');
    });
    return parseRegistryTableMappingDecision({
      kind: 'registry_table_mapping',
      version: 1,
      source,
      outcome: {
        kind: 'records',
        headersSha256: candidate.headersSha256,
        rowCount: candidate.rowCount,
        columns,
      },
    });
  } catch {
    return null;
  }
}

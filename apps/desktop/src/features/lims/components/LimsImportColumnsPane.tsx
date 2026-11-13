import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { hasPlatformCommandModifier } from '@waypoint/ui-components/keyboard';
import type {
  LimsImportColumnMappingOverride,
  LimsImportPlan,
  LimsImportPlanColumn,
  LimsImportPlanRecord,
} from '../../../shared/lims';
import { FieldMappingPicker, type FieldMappingOption } from './FieldMappingPicker';
import type { ImportPlanView } from './import-plan-view';
import { singularKindLabel } from './registry-presenters';

type RowSelectModifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

export function LimsImportColumnsPane({
  plan,
  view,
  onColumnMappingsChange,
  onRecordAcceptedChange,
  onRecordsAcceptedChange,
}: {
  plan: LimsImportPlan;
  view: ImportPlanView;
  onColumnMappingsChange(mappings: LimsImportColumnMappingOverride[]): void;
  onRecordAcceptedChange(recordId: string, accepted: boolean): void;
  onRecordsAcceptedChange?(recordIds: string[], accepted: boolean): void;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const recordIds = useMemo(() => plan.records.map((record) => record.id), [plan.records]);

  const selectRow = (recordId: string, mods: RowSelectModifiers) => {
    if (mods.shiftKey && anchorId && recordIds.includes(anchorId)) {
      const a = recordIds.indexOf(anchorId);
      const b = recordIds.indexOf(recordId);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      setSelectedIds(new Set(recordIds.slice(lo, hi + 1)));
    } else if (hasPlatformCommandModifier(mods)) {
      const next = new Set(selectedIds);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      setSelectedIds(next);
      setAnchorId(recordId);
    } else {
      setSelectedIds(new Set([recordId]));
      setAnchorId(recordId);
    }
  };

  const acceptRecord = (recordId: string, accepted: boolean) => {
    if (onRecordsAcceptedChange && selectedIds.size > 1 && selectedIds.has(recordId)) {
      onRecordsAcceptedChange([...selectedIds], accepted);
    } else {
      onRecordAcceptedChange(recordId, accepted);
    }
  };
  const {
    fieldOptions,
    columnsByField,
    duplicatedFields,
    hasDuplicateMapping,
    sequenceFiles,
    orderedColumns,
    showRegistryId,
    idPreview,
    requiredFieldsUnmet,
  } = view;

  const columnSetKey = useMemo(
    () => [...plan.columns.map((column) => column.sourceColumn)].sort().join('\u0000'),
    [plan.columns]
  );
  const frozenOrder = useMemo(
    () => orderedColumns.map((column) => column.sourceColumn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnSetKey]
  );
  const displayColumns = useMemo(() => {
    const byName = new Map(plan.columns.map((column) => [column.sourceColumn, column]));
    return frozenOrder
      .map((name) => byName.get(name))
      .filter((column): column is LimsImportPlanColumn => Boolean(column));
  }, [frozenOrder, plan.columns]);
  const dataColumns = frozenOrder;

  const includedCount = plan.records.filter((record) => record.accepted).length;
  const allAccepted = plan.records.length > 0 && includedCount === plan.records.length;
  const setAllAccepted = (accepted: boolean) => {
    if (onRecordsAcceptedChange) onRecordsAcceptedChange(recordIds, accepted);
    else for (const id of recordIds) onRecordAcceptedChange(id, accepted);
  };
  const clearSelection = () => {
    setSelectedIds(new Set());
    setAnchorId(null);
  };

  const remapColumn = (sourceColumn: string, mappedField: string | null) => {
    onColumnMappingsChange([
      mappedField
        ? { sourceColumn, mappedField, mappingMode: 'mapped', confidence: 'user_overridden' }
        : { sourceColumn, mappingMode: 'source_only', confidence: 'user_overridden' },
    ]);
  };
  const ignoreColumn = (sourceColumn: string) => {
    onColumnMappingsChange([
      { sourceColumn, mappingMode: 'ignored', confidence: 'user_overridden' },
    ]);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {hasDuplicateMapping && (
        <div
          data-testid="lims-import-duplicate-banner"
          className="border-b border-error/40 bg-error/5 px-4 py-1.5 text-[11px] font-medium text-error"
        >
          Two columns are mapped to the same field — fix the highlighted columns to continue.
        </div>
      )}
      {requiredFieldsUnmet.length > 0 && (
        <div
          data-testid="lims-import-required-banner"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-error/40 bg-error/5 px-4 py-1.5 text-[11px] font-medium text-error"
        >
          <span>
            Map a column to{' '}
            {requiredFieldsUnmet.length === 1 ? 'this required field' : 'these required fields'} to
            continue:
          </span>
          {requiredFieldsUnmet.map((field) => (
            <span
              key={field.value}
              data-testid={`lims-import-required-unmet-${field.value}`}
              className="rounded border border-error/50 bg-error/10 px-1.5 py-0.5"
            >
              {field.label}
            </span>
          ))}
        </div>
      )}

      {}
      <div
        data-testid="lims-import-table"
        onClick={clearSelection}
        className="min-h-0 flex-1 overflow-auto"
      >
        {plan.records.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-fg-muted">No importable records</div>
        ) : (
          <table className="w-full border-collapse text-xs">
            {}
            <thead
              className="sticky top-0 z-10 bg-bg-muted"
              onClick={(event) => event.stopPropagation()}
            >
              <tr className="border-b-2 border-border">
                {}
                <th className="w-8 border-r border-border px-3 pb-2.5 align-bottom">
                  <SelectAllCheckbox
                    allAccepted={allAccepted}
                    someAccepted={includedCount > 0}
                    onToggle={() => setAllAccepted(!allAccepted)}
                  />
                </th>
                {showRegistryId && (
                  <th
                    data-testid="lims-import-band-labels"
                    className="px-3 py-2 text-right align-top"
                  >
                    {}
                    <div className="mb-1.5 flex h-4 items-center justify-end whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-fg-subtle">
                      File headers
                    </div>
                    <div className="flex h-7 items-center justify-end whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider text-fg-subtle">
                      Registry columns
                    </div>
                  </th>
                )}
                {sequenceFiles ? (
                  <>
                    <ImportColHead>Name</ImportColHead>
                    <ImportColHead>Type</ImportColHead>
                  </>
                ) : fieldOptions.length > 0 ? (
                  displayColumns.map((column) => (
                    <MappingColumnHead
                      key={column.sourceColumn}
                      column={column}
                      fieldOptions={fieldOptions}
                      columnsByField={columnsByField}
                      isDuplicate={
                        column.mappingMode === 'mapped' &&
                        column.mappedField != null &&
                        duplicatedFields.has(column.mappedField)
                      }
                      onRemap={remapColumn}
                      onIgnore={ignoreColumn}
                    />
                  ))
                ) : (
                  dataColumns.map((column) => <ImportColHead key={column}>{column}</ImportColHead>)
                )}
              </tr>
            </thead>
            <tbody>
              {plan.records.map((record, index) => {
                const selected = selectedIds.has(record.id);
                const prevSelected = index > 0 && selectedIds.has(plan.records[index - 1].id);
                const nextSelected =
                  index < plan.records.length - 1 && selectedIds.has(plan.records[index + 1].id);
                return (
                  <ImportRow
                    key={record.id}
                    record={record}
                    dataColumns={dataColumns}
                    sequenceFile={sequenceFiles}
                    showRegistryId={showRegistryId}
                    registryId={idPreview.get(record.id)}
                    selected={selected}
                    selectionEdgeTop={selected && !prevSelected}
                    selectionEdgeBottom={selected && !nextSelected}
                    onSelect={(mods) => selectRow(record.id, mods)}
                    onAcceptedChange={(accepted) => acceptRecord(record.id, accepted)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MappingColumnHead({
  column,
  fieldOptions,
  columnsByField,
  isDuplicate,
  onRemap,
  onIgnore,
}: {
  column: LimsImportPlanColumn;
  fieldOptions: FieldMappingOption[];
  columnsByField: Map<string, string[]>;
  isDuplicate: boolean;
  onRemap: (sourceColumn: string, mappedField: string | null) => void;
  onIgnore: (sourceColumn: string) => void;
}) {
  const current = column.mappingMode === 'mapped' && column.mappedField ? column.mappedField : '';
  return (
    <th className="min-w-[176px] px-3 py-2 text-left align-top">
      {}
      <div
        data-testid={`lims-import-srccol-${column.sourceColumn}`}
        title={column.sourceColumn}
        className="mb-1.5 flex h-4 items-center truncate text-[13px] font-semibold text-fg"
      >
        {column.sourceColumn}
      </div>
      <FieldMappingPicker
        columnName={column.sourceColumn}
        value={current}
        mappingMode={column.mappingMode}
        options={fieldOptions}
        columnsByField={columnsByField}
        isDuplicate={isDuplicate}
        onChange={(next) => onRemap(column.sourceColumn, next)}
        onIgnore={() => onIgnore(column.sourceColumn)}
      />
      {isDuplicate && (
        <div
          data-testid="lims-import-colmap-duplicate"
          className="mt-0.5 text-[10px] font-medium text-error"
        >
          Two columns map here — pick another field.
        </div>
      )}
    </th>
  );
}

function SelectAllCheckbox({
  allAccepted,
  someAccepted,
  onToggle,
}: {
  allAccepted: boolean;
  someAccepted: boolean;
  onToggle(): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someAccepted && !allAccepted;
  }, [someAccepted, allAccepted]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={allAccepted ? 'Exclude all rows' : 'Include all rows'}
      data-testid="lims-import-select-all"
      checked={allAccepted}
      onClick={(event) => event.stopPropagation()}
      onChange={onToggle}
    />
  );
}

function ImportColHead({ children }: { children: ReactNode }) {
  return (
    <th className="whitespace-nowrap px-3 pb-3 align-bottom text-left text-[10px] font-bold uppercase tracking-wider text-fg-muted">
      {children}
    </th>
  );
}

function ImportRow({
  record,
  dataColumns,
  sequenceFile,
  showRegistryId,
  registryId,
  selected,
  selectionEdgeTop = false,
  selectionEdgeBottom = false,
  onSelect,
  onAcceptedChange,
}: {
  record: LimsImportPlanRecord;
  dataColumns: string[];
  sequenceFile: boolean;
  showRegistryId: boolean;
  registryId: string | undefined;
  selected: boolean;
  selectionEdgeTop?: boolean;
  selectionEdgeBottom?: boolean;
  onSelect(mods: RowSelectModifiers): void;
  onAcceptedChange(accepted: boolean): void;
}) {
  const reason = rowReason(record);
  const accent =
    reason?.tone === 'error'
      ? 'border-l-2 border-l-error'
      : reason?.tone === 'warning'
        ? 'border-l-2 border-l-warning'
        : '';
  const strokeColor = 'hsl(var(--color-accent))';
  const selectionShadow = selected
    ? [
        `inset 2px 0 0 0 ${strokeColor}`,
        `inset -2px 0 0 0 ${strokeColor}`,
        selectionEdgeTop ? `inset 0 2px 0 0 ${strokeColor}` : '',
        selectionEdgeBottom ? `inset 0 -2px 0 0 ${strokeColor}` : '',
      ]
        .filter(Boolean)
        .join(', ')
    : undefined;
  return (
    <tr
      data-testid={`lims-import-record-${record.id}`}
      data-selected={selected ? 'true' : undefined}
      title={reason?.text}
      onClick={(event) => {
        event.stopPropagation();
        onSelect({
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
      }}
      style={selectionShadow ? { boxShadow: selectionShadow } : undefined}
      className={`cursor-pointer select-none border-b border-border ${accent} ${
        selected ? 'bg-accent/10' : 'hover:bg-fg/[0.04]'
      } ${record.accepted ? '' : 'opacity-50'}`}
    >
      <td className="px-3 py-1.5 align-top">
        <input
          type="checkbox"
          aria-label={`Include ${record.entityDraft.name}`}
          data-testid={`lims-import-record-${record.id}-accepted`}
          checked={record.accepted}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onAcceptedChange(event.target.checked)}
        />
      </td>
      {showRegistryId && (
        <td
          data-testid={`lims-import-record-${record.id}-registry-id`}
          className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-[11px] text-fg-muted"
        >
          {registryId ?? '—'}
        </td>
      )}
      {sequenceFile ? (
        <>
          <td className="px-3 py-1.5 align-top font-medium text-fg">
            {record.entityDraft.name}
            <RowReason reason={reason} recordId={record.id} />
          </td>
          <td className="px-3 py-1.5 align-top">
            {record.errors.length > 0 ? (
              <span className="text-fg-subtle" title="Re-import this file via the Sequences door">
                —
              </span>
            ) : (
              <>
                <span data-testid={`lims-import-record-${record.id}-kind`}>
                  {singularKindLabel(record.entityDraft.kind)}
                </span>
              </>
            )}
          </td>
        </>
      ) : (
        dataColumns.map((column, columnIndex) => {
          const value = record.source[column];
          const text = value === null || typeof value === 'undefined' ? '' : String(value);
          return (
            <td key={column} title={text} className="max-w-[320px] px-3 py-1.5 align-top text-fg">
              <div className="truncate">{text}</div>
              {columnIndex === 0 && <RowReason reason={reason} recordId={record.id} />}
            </td>
          );
        })
      )}
    </tr>
  );
}

type RowReasonTone = 'error' | 'warning' | 'muted';
interface RowReasonInfo {
  text: string;
  tone: RowReasonTone;
}

function rowReason(record: LimsImportPlanRecord): RowReasonInfo | null {
  if (record.errors[0]) return { text: record.errors[0], tone: 'error' };
  const dup = record.duplicateCandidates[0]?.reason;
  if (dup) return { text: dup, tone: 'warning' };
  if (record.warnings[0]) return { text: record.warnings[0], tone: 'warning' };
  if (record.requiresRegistrationKind) return { text: 'Pick a type for this file.', tone: 'muted' };
  return null;
}

function RowReason({ reason, recordId }: { reason: RowReasonInfo | null; recordId: string }) {
  if (!reason) return null;
  const color =
    reason.tone === 'error'
      ? 'text-error'
      : reason.tone === 'warning'
        ? 'text-warning'
        : 'text-fg-muted';
  return (
    <div
      data-testid={`lims-import-record-${recordId}-reason`}
      className={`mt-0.5 whitespace-normal text-[11px] font-normal ${color}`}
    >
      {reason.text}
    </div>
  );
}

import { MenuNativeSelect } from '@waypoint/ui-components';
import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { GoogleSheetChooser } from './GoogleSheetChooser';
import { googleWorksheetImportInput } from '../google-sync-source';
import type { GoogleWorksheetSnapshot } from '../../../shared/google-sheets';
import type { GoogleSyncSource } from '../sheet-sync-connection';
import { loadSheetSyncConnection } from '../sheet-sync-connection';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Notice } from '../../../components/ui';
import { platform } from '../../../platform';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { writableProjectRoots } from '../../../shared/project-root-selection';
import { isDesktopRuntime } from '../../../utils/environment';
import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type LimsEntityKind,
  type LimsImportColumnMappingOverride,
  type LimsImportPlan,
  type LimsImportPlanColumn,
} from '../../../shared/lims';
import { PRIMER_MANAGED_SCHEMA_FIELD_KEYS } from '../../primers/public/primer-schema-contract';
import { createLimsImportPlan, inspectLimsSource } from '../ingress';
import { sheetSyncRowsFromImportPlan } from '../sheet-sync-import';
import {
  createExcelSheetSyncConnection,
  createGoogleSheetSyncConnection,
  setSheetSyncEnabled,
  prepareSheetSyncConnection,
} from '../sheet-sync-runtime';
import {
  authorizeLocalSheetSync,
  authorizeGoogleSheetSync,
  localSheetSyncAuthorization,
} from '../sheet-sync-local-state';
import {
  refreshSheetSyncProject,
  requestSheetSyncPull,
  retainSheetSyncProject,
  useSheetSyncViews,
  type SheetSyncView,
} from '../sheet-sync-projects';

type Workbook = { path: string; sheets: string[] } & (
  | { provider: 'local-excel'; bytes: ArrayBuffer }
  | { provider: 'google-sheets'; grantId: string; snapshot: GoogleWorksheetSnapshot }
);
type Preview =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; plan: LimsImportPlan; preparedId: string }
  | { kind: 'error'; message: string };
const KIND_OPTIONS: Array<{ value: LimsEntityKind; label: string }> = [
  { value: 'oligo', label: 'DNA oligos' },
  { value: 'rna_oligo', label: 'RNA oligos' },
  { value: 'strain', label: 'Strains' },
  { value: 'protein', label: 'Proteins' },
  { value: 'plasmid', label: 'Plasmids' },
];
function fileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}
function fieldOptions(kind: LimsEntityKind) {
  const fields = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === kind)?.fields ?? [];
  return fields
    .filter(
      (field) =>
        field.key !== 'artifact' &&
        field.key !== 'sourceMetadata' &&
        field.type !== 'record_relationship' &&
        (!(kind === 'oligo' || kind === 'rna_oligo') ||
          field.key === 'sequence' ||
          !PRIMER_MANAGED_SCHEMA_FIELD_KEYS.has(field.key))
    )
    .map((field) => ({ value: `fields.${field.key}`, label: field.label }));
}
function initialMappings(
  columns: LimsImportPlanColumn[],
  kind: LimsEntityKind
): LimsImportColumnMappingOverride[] {
  const allowed = new Set(['entity.name', ...fieldOptions(kind).map((field) => field.value)]);
  const name = columns.find((column) =>
    /^(?:name|primer[ _-]?name|oligo[ _-]?name|record[ _-]?name)$/i.test(column.sourceColumn)
  );
  return columns.map((column) => {
    if (name && column.sourceColumn === name.sourceColumn)
      return {
        sourceColumn: column.sourceColumn,
        mappingMode: 'mapped',
        mappedField: 'entity.name',
        confidence: 'user_overridden',
      };
    if (name && column.sourceColumn !== name.sourceColumn && column.mappedField === 'entity.name')
      return {
        sourceColumn: column.sourceColumn,
        mappingMode: 'source_only',
        confidence: 'user_overridden',
      };
    return {
      sourceColumn: column.sourceColumn,
      mappingMode: column.mappedField && allowed.has(column.mappedField) ? 'mapped' : 'source_only',
      ...(column.mappedField && allowed.has(column.mappedField)
        ? { mappedField: column.mappedField }
        : {}),
      confidence: 'user_overridden',
    };
  });
}
function summaryLabel(view: SheetSyncView): UserMessage {
  if (view.kind === 'syncing') return userMessage('sheetSync.syncing');
  if (view.kind === 'paused') return userMessage('sheetSync.paused');
  if (view.kind === 'authorization-required') return userMessage('sheetSync.authorizeWorkbook');
  if (view.kind === 'error' || view.kind === 'invalid')
    return toUserMessage(view.message, 'account.failed');
  const result = view.summary;
  return userMessageWithValues('sheetSync.summary', {
    created: userMessageValue(result.created),
    updated: userMessageValue(result.updated),
    unchanged: userMessageValue(result.unchanged),
    conflicts: userMessageValue(
      result.conflicts.length
        ? userMessageWithValues('sheetSync.conflicts', {
            count: userMessageValue(result.conflicts.length),
          })
        : ''
    ),
    localEdits: userMessageValue(
      result.localEdits.length
        ? userMessageWithValues('sheetSync.localEdits', {
            count: userMessageValue(result.localEdits.length),
          })
        : ''
    ),
    missingRows: userMessageValue(
      result.missingRows.length
        ? userMessageWithValues('sheetSync.missingRows', {
            count: userMessageValue(result.missingRows.length),
          })
        : ''
    ),
  });
}

export function SheetSyncManagerButton() {
  const presentationOverlay = usePresentationOverlay('modal');

  const [open, setOpen] = useState(false);
  const folders = useWorkspaceStore((state) => state.folders);
  const roots = useMemo(() => writableProjectRoots(folders), [folders]);
  const [root, setRoot] = useState('');
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [sheet, setSheet] = useState('');
  const [kind, setKind] = useState<LimsEntityKind>('oligo');
  const [keyColumn, setKeyColumn] = useState('');
  const [mappings, setMappings] = useState<LimsImportColumnMappingOverride[]>([]);
  const [inspected, setInspected] = useState<LimsImportPlan | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' });
  const [reauthorize, setReauthorize] = useState<{ id: string; source: GoogleSyncSource } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const views = useSheetSyncViews().filter((view) => view.workspaceRoot === root);
  useEffect(() => {
    if (open)
      setRoot((current) =>
        roots.some((project) => project.path === current) ? current : (roots[0]?.path ?? '')
      );
  }, [open, roots]);
  useEffect(() => {
    if (!open || !root || !isDesktopRuntime()) return;
    return retainSheetSyncProject(root);
  }, [open, root]);
  useEffect(() => {
    if (!open) return;
    safeFocus(dialog.current);
    return () => {
      safeFocus(opener.current);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !workbook || !sheet) return;
    let cancelled = false;
    setPreview({ kind: 'loading' });
    void createLimsImportPlan({
      ...(workbook.provider === 'local-excel'
        ? { fileName: fileName(workbook.path), arrayBuffer: workbook.bytes, sheetName: sheet }
        : googleWorksheetImportInput(workbook.snapshot)),
      forcedKind: kind,
      columnMappings: mappings,
      ...(keyColumn ? { externalRowKeyColumn: keyColumn } : {}),
    })
      .then(async (plan) => {
        if (cancelled) return;
        setInspected(plan);
        if (!mappings.length && plan.columns.length) {
          const key =
            keyColumn ||
            plan.columns.find((column) => /^(?:id|.*[ _-]id|uuid|key)$/i.test(column.sourceColumn))
              ?.sourceColumn ||
            '';
          setKeyColumn(key);
          setMappings(initialMappings(plan.columns, kind));
          return;
        }
        if (!keyColumn) {
          setPreview({ kind: 'error', message: 'Choose a permanent unique ID column.' });
          return;
        }
        const sourceMapping = { keyColumn, forcedKind: kind, columnMappings: mappings };
        const prepared = await prepareSheetSyncConnection({
          workspaceRoot: root,
          source:
            workbook.provider === 'local-excel'
              ? { ...sourceMapping, path: workbook.path, sheetName: sheet }
              : {
                  ...sourceMapping,
                  provider: 'google-sheets',
                  spreadsheetId: workbook.snapshot.spreadsheetId,
                  sheetId: workbook.snapshot.sheetId,
                },
          ...(workbook.provider === 'google-sheets' ? { grantId: workbook.grantId } : {}),
          destinationRelativePath: 'spreadsheets',
        });
        if (cancelled) return;
        sheetSyncRowsFromImportPlan(prepared.plan, keyColumn);
        setInspected(prepared.plan);
        setPreview({ kind: 'ready', plan: prepared.plan, preparedId: prepared.preparedId });
      })
      .catch((reason) => {
        if (!cancelled)
          setPreview({
            kind: 'error',
            message: toUserMessage(reason, 'operation.failed'),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [open, root, workbook, sheet, kind, keyColumn, mappings]);

  async function chooseWorkbook() {
    setError(null);
    try {
      const selected = await platform().dialog.open({
        title: 'Choose a master Excel workbook',
        multiple: false,
        filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xls', 'xlsm'] }],
      });
      if (typeof selected !== 'string') return;
      const bytes = Uint8Array.from(await platform().fs.readFile(selected)).buffer;
      const info = inspectLimsSource({ fileName: fileName(selected), arrayBuffer: bytes });
      const sheets =
        info.sheetDispositions?.map((disposition) => disposition.sheetName) ??
        (info.selectedSheet ? [info.selectedSheet] : []);
      if (!sheets.length) throw new Error('This workbook has no worksheet to connect.');
      setWorkbook({ provider: 'local-excel', path: selected, bytes, sheets });
      setSheet(sheets[0]);
      setKeyColumn('');
      setMappings([]);
      setInspected(null);
      setPreview({ kind: 'idle' });
    } catch (reason) {
      setError(toUserMessage(reason, 'operation.failed'));
    }
  }
  async function connect() {
    if (!root || !workbook || preview.kind !== 'ready' || !keyColumn || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sourceMapping = { keyColumn, forcedKind: kind, columnMappings: mappings };
      const stored =
        workbook.provider === 'local-excel'
          ? await createExcelSheetSyncConnection({
              workspaceRoot: root,
              source: { ...sourceMapping, path: workbook.path, sheetName: sheet },
              destinationRelativePath: 'spreadsheets',
              preparedId: preview.preparedId,
            })
          : await createGoogleSheetSyncConnection({
              workspaceRoot: root,
              grantId: workbook.grantId,
              source: {
                ...sourceMapping,
                provider: 'google-sheets',
                spreadsheetId: workbook.snapshot.spreadsheetId,
                sheetId: workbook.snapshot.sheetId,
              },
              destinationRelativePath: 'spreadsheets',
              preparedId: preview.preparedId,
            });
      setWorkbook(null);
      setInspected(null);
      setPreview({ kind: 'idle' });
      setMappings([]);
      setKeyColumn('');
      await refreshSheetSyncProject(root);
      await requestSheetSyncPull(root, stored.connection.id);
    } catch (reason) {
      setError(toUserMessage(reason, 'operation.failed'));
    } finally {
      setBusy(false);
    }
  }
  async function action(
    view: Exclude<SheetSyncView, { kind: 'invalid' }>,
    mode: 'sync' | 'pause' | 'resume'
  ) {
    setError(null);
    try {
      if (mode === 'pause') await setSheetSyncEnabled(root, view.connectionId, false);
      if (mode === 'resume') {
        const stored = await loadSheetSyncConnection(root, view.connectionId);
        if ((await localSheetSyncAuthorization(root, stored.connection)) === 'required') {
          if ('provider' in stored.connection.source) {
            setReauthorize({ id: stored.connection.id, source: stored.connection.source });
            return;
          }
          const selected = await platform().dialog.open({
            title: 'Choose the recorded master workbook',
            multiple: false,
            filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xls', 'xlsm'] }],
          });
          if (typeof selected !== 'string') return;
          await authorizeLocalSheetSync(root, stored.connection, selected);
        }
        await setSheetSyncEnabled(root, view.connectionId, true);
      }
      await refreshSheetSyncProject(root);
      if (mode !== 'pause') await requestSheetSyncPull(root, view.connectionId);
    } catch (reason) {
      setError(toUserMessage(reason, 'operation.failed'));
    }
  }
  if (!isDesktopRuntime()) return null;
  const fields = fieldOptions(kind);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        data-testid="sheet-sync-open"
        onClick={(event) => {
          opener.current = event.currentTarget;
          setError(null);
          setOpen(true);
        }}
        className="h-7 rounded-md border border-border bg-bg px-2 text-xs text-fg-muted wp-interactive "
      >
        Spreadsheet sync…
      </button>
      {open ? (
        <div
          ref={presentationOverlay.bindRef(undefined, '0')}
          className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/40"
          onMouseDown={() => setOpen(false)}
        >
          <PresentationScopeContext.Provider value={presentationOverlay.scope}>
            <section
              ref={dialog}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-labelledby="sheet-sync-title"
              data-testid="sheet-sync-dialog"
              className="mx-4 flex max-h-[calc(100vh-48px)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-bg-subtle text-fg shadow-xl outline-none"
              onMouseDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }
                if (event.key === 'Tab') {
                  const controls = [
                    ...(dialog.current?.querySelectorAll<HTMLElement>(
                      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
                    ) ?? []),
                  ];
                  const first = controls[0],
                    last = controls[controls.length - 1];
                  if (
                    event.shiftKey &&
                    (document.activeElement === first || document.activeElement === dialog.current)
                  ) {
                    event.preventDefault();
                    safeFocus(last);
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    safeFocus(first);
                  }
                }
              }}
            >
              <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div>
                  <h2 id="sheet-sync-title" className="text-base font-semibold">
                    Spreadsheet sync
                  </h2>
                  <p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">
                    Keep using your master spreadsheet. Rows become Registry records and update
                    while the project is open. Your source stays unchanged.
                  </p>
                </div>
                <Button aria-label="Close spreadsheet sync" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </header>
              <div className="min-h-0 space-y-5 overflow-y-auto p-5">
                {error ? (
                  <Notice tone="error" testId="sheet-sync-error">
                    {toUserMessage(error, 'operation.failed')}
                  </Notice>
                ) : null}
                <label className="block text-xs font-medium">
                  Project
                  <span className="block min-w-0 w-full mt-1.5">
                    <MenuNativeSelect
                      density="form"
                      aria-label="Spreadsheet project"
                      value={root}
                      onChange={(event) => {
                        setRoot(event.target.value);
                        setReauthorize(null);
                        setError(null);
                      }}
                      disabled={busy}
                    >
                      <option value="" disabled>
                        Open a writable project
                      </option>
                      {roots.map((project) => (
                        <option key={project.path} value={project.path}>
                          {project.name}
                        </option>
                      ))}
                    </MenuNativeSelect>
                  </span>
                </label>
                {reauthorize ? (
                  <GoogleSheetChooser
                    key={reauthorize.id}
                    disabled={busy}
                    source={reauthorize.source}
                    onSelected={async ({ grantId }) => {
                      const stored = await loadSheetSyncConnection(root, reauthorize.id);
                      await authorizeGoogleSheetSync(root, stored.connection, grantId);
                      await setSheetSyncEnabled(root, reauthorize.id, true);
                      await refreshSheetSyncProject(root);
                      await requestSheetSyncPull(root, reauthorize.id);
                      setReauthorize(null);
                    }}
                  />
                ) : null}
                {views.length ? (
                  <div
                    className="divide-y divide-border rounded-md border border-border bg-bg"
                    data-testid="sheet-sync-connections"
                  >
                    {views.map((view) => (
                      <div
                        key={view.kind === 'invalid' ? view.name : view.connectionId}
                        className="px-3 py-3"
                        data-testid={
                          view.kind === 'invalid' ? 'sheet-sync-invalid' : 'sheet-sync-connection'
                        }
                      >
                        {view.kind === 'invalid' ? (
                          <Notice tone="error">
                            {view.name}: {toUserMessage(view.message, 'account.failed')}
                          </Notice>
                        ) : (
                          <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="text-xs font-medium" title={view.sourcePath}>
                                  {fileName(view.sourcePath)} / {view.sheetName}
                                </p>
                                <p
                                  className={`mt-1 text-xs leading-5 ${view.kind === 'error' ? 'text-error' : 'text-fg-muted'}`}
                                  data-testid="sheet-sync-connection-status"
                                >
                                  {summaryLabel(view)}
                                </p>
                              </div>
                              <div className="flex gap-2">
                                {view.kind === 'paused' ||
                                view.kind === 'authorization-required' ? (
                                  <Button onClick={() => void action(view, 'resume')}>
                                    {view.kind === 'authorization-required'
                                      ? view.provider === 'google-sheets'
                                        ? 'Authorize Google sheet'
                                        : 'Choose workbook'
                                      : 'Resume'}
                                  </Button>
                                ) : (
                                  <>
                                    <Button
                                      disabled={view.kind === 'syncing'}
                                      onClick={() => void action(view, 'sync')}
                                    >
                                      {view.kind === 'error' ? 'Retry' : 'Sync now'}
                                    </Button>
                                    <Button onClick={() => void action(view, 'pause')}>
                                      Pause
                                    </Button>
                                  </>
                                )}
                              </div>
                            </div>
                            {view.kind === 'ready' && view.summary.conflicts.length ? (
                              <p className="mt-2 text-xs text-warning">
                                Rows{' '}
                                {view.summary.conflicts.map((conflict) => conflict.key).join(', ')}{' '}
                                changed in both places. Review those rows; neither version was
                                overwritten.
                              </p>
                            ) : null}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                <GoogleSheetChooser
                  disabled={!root || busy}
                  onSelected={async ({ grantId, spreadsheet, snapshot }) => {
                    setWorkbook({
                      provider: 'google-sheets',
                      grantId,
                      snapshot,
                      path: spreadsheet.title,
                      sheets: [snapshot.sheetTitle],
                    });
                    setSheet(snapshot.sheetTitle);
                    setMappings([]);
                    setKeyColumn('');
                    setInspected(null);
                    setPreview({ kind: 'idle' });
                  }}
                />
                <section className="border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">Connect a workbook</h3>
                    <Button
                      disabled={!root || busy}
                      onClick={() => void chooseWorkbook()}
                      data-testid="sheet-sync-choose-file"
                    >
                      Choose Excel workbook
                    </Button>
                  </div>
                  {workbook ? (
                    <>
                      <p className="mt-2 truncate text-xs text-fg-muted" title={workbook.path}>
                        {fileName(workbook.path)}
                      </p>
                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="text-xs font-medium">
                          Worksheet
                          <span className="block min-w-0 w-full mt-1.5">
                            <MenuNativeSelect
                              density="form"
                              aria-label="Spreadsheet worksheet"
                              value={sheet}
                              onChange={(event) => {
                                setSheet(event.target.value);
                                setMappings([]);
                                setKeyColumn('');
                              }}
                              disabled={busy}
                            >
                              {workbook.sheets.map((name) => (
                                <option key={name} value={name}>
                                  {name}
                                </option>
                              ))}
                            </MenuNativeSelect>
                          </span>
                        </label>
                        <label className="text-xs font-medium">
                          Record type
                          <span className="block min-w-0 w-full mt-1.5">
                            <MenuNativeSelect
                              density="form"
                              aria-label="Spreadsheet record type"
                              value={kind}
                              onChange={(event) => {
                                const option = KIND_OPTIONS.find(
                                  (candidate) => candidate.value === event.target.value
                                );
                                if (option) {
                                  setKind(option.value);
                                  setMappings([]);
                                }
                              }}
                              disabled={busy}
                            >
                              {KIND_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </MenuNativeSelect>
                          </span>
                        </label>
                      </div>
                      <label className="mt-4 block text-xs font-medium">
                        Permanent unique ID column
                        <span className="block min-w-0 w-full mt-1.5">
                          <MenuNativeSelect
                            density="form"
                            aria-label="Spreadsheet unique ID column"
                            value={keyColumn}
                            onChange={(event) => {
                              const value = event.target.value;
                              setKeyColumn(value);
                              setMappings((current) =>
                                current.map((mapping) =>
                                  mapping.sourceColumn === value &&
                                  mapping.mappingMode === 'ignored'
                                    ? { ...mapping, mappingMode: 'source_only' }
                                    : mapping
                                )
                              );
                            }}
                            disabled={busy}
                          >
                            <option value="">Choose an ID column</option>
                            {inspected?.columns.map((column) => (
                              <option key={column.sourceColumn} value={column.sourceColumn}>
                                {column.sourceColumn}
                              </option>
                            ))}
                          </MenuNativeSelect>
                        </span>
                      </label>
                      <p className="mt-1 text-[11px] leading-4 text-fg-subtle">
                        Use an ID that survives sorting and renaming. Changing the ID creates a new
                        record.
                      </p>
                      {inspected ? (
                        <div className="mt-4 overflow-hidden rounded-md border border-border">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-bg-muted text-fg-muted">
                              <tr>
                                <th className="px-3 py-2 font-medium">Workbook column</th>
                                <th className="px-3 py-2 font-medium">Registry field</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border bg-bg">
                              {inspected.columns.map((column) => {
                                const mapping = mappings.find(
                                  (item) => item.sourceColumn === column.sourceColumn
                                );
                                const value =
                                  mapping?.mappingMode === 'mapped'
                                    ? mapping.mappedField
                                    : mapping?.mappingMode === 'ignored'
                                      ? '__ignore'
                                      : '__source';
                                return (
                                  <tr key={column.sourceColumn}>
                                    <td className="px-3 py-2">{column.sourceColumn}</td>
                                    <td className="px-3 py-2">
                                      <span className="block min-w-0 w-full">
                                        <MenuNativeSelect
                                          density="form"
                                          aria-label={`Map ${column.sourceColumn}`}
                                          value={value ?? '__source'}
                                          disabled={busy}
                                          onChange={(event) => {
                                            const next = event.target.value;
                                            setMappings((current) =>
                                              current.map((item) =>
                                                item.sourceColumn !== column.sourceColumn
                                                  ? item
                                                  : next === '__ignore'
                                                    ? {
                                                        sourceColumn: item.sourceColumn,
                                                        mappingMode: 'ignored',
                                                      }
                                                    : next === '__source'
                                                      ? {
                                                          sourceColumn: item.sourceColumn,
                                                          mappingMode: 'source_only',
                                                        }
                                                      : {
                                                          sourceColumn: item.sourceColumn,
                                                          mappingMode: 'mapped',
                                                          mappedField: next,
                                                          confidence: 'user_overridden',
                                                        }
                                              )
                                            );
                                          }}
                                        >
                                          <option value="__source">Keep source value</option>
                                          <option
                                            value="__ignore"
                                            disabled={column.sourceColumn === keyColumn}
                                          >
                                            Ignore column
                                          </option>
                                          <option value="entity.name">Record name</option>
                                          {fields.map((field) => (
                                            <option key={field.value} value={field.value}>
                                              {field.label}
                                            </option>
                                          ))}
                                        </MenuNativeSelect>
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                      <div className="mt-4" aria-live="polite">
                        {preview.kind === 'loading' ? (
                          <p className="text-xs text-fg-muted">Checking workbook…</p>
                        ) : preview.kind === 'error' ? (
                          <Notice tone="error">
                            {toUserMessage(preview.message, 'account.failed')}
                          </Notice>
                        ) : preview.kind === 'ready' ? (
                          <>
                            <p className="text-xs font-medium">
                              {preview.plan.records.length} records ready
                            </p>
                            <div className="mt-2 overflow-hidden rounded-md border border-border">
                              <table className="w-full text-left text-xs">
                                <thead className="bg-bg-muted text-fg-muted">
                                  <tr>
                                    <th className="px-3 py-2 font-medium">ID</th>
                                    <th className="px-3 py-2 font-medium">Record name</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border bg-bg">
                                  {preview.plan.records.slice(0, 5).map((record) => (
                                    <tr key={record.externalRowId ?? record.id}>
                                      <td className="px-3 py-2">{record.externalRowId}</td>
                                      <td className="px-3 py-2">{record.entityDraft.name}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {preview.plan.records.length > 5 ? (
                              <p className="mt-1 text-[11px] text-fg-subtle">
                                Showing the first five records.
                              </p>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                      <p className="mt-4 text-xs leading-5 text-fg-muted">
                        Registry edits are retained. Rows changed in both places are marked for
                        review. Rows removed from the workbook stay in Registry.
                      </p>
                      <div className="mt-4 flex justify-end">
                        <Button
                          variant="primary"
                          disabled={busy || !root || preview.kind !== 'ready'}
                          onClick={() => void connect()}
                          data-testid="sheet-sync-connect"
                        >
                          {busy ? 'Connecting…' : 'Connect and sync'}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-xs leading-5 text-fg-muted">
                      Choose the worksheet and its column mappings before enabling automatic pulls.
                    </p>
                  )}
                </section>
              </div>
            </section>
          </PresentationScopeContext.Provider>
        </div>
      ) : null}
    </>
  );
}

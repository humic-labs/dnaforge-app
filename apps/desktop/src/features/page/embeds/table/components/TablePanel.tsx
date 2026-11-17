import { useDocumentLifecycle } from '../../../../../shared/use-document-lifecycle';
import { reportSaveFailure } from '../../../../../lib/report-save-failure';
import { isElectron } from '../../../../../utils/environment';
import {
  tableDocumentKey,
  tableDocumentReferenceFromKey,
  tableDocumentReferenceSchema,
  type TableDocumentReference,
} from '../../../../../shared/table-document-reference';
import { useNativeNotebookTableDocument } from '../../../hooks/useNativeNotebookTableDocument';
import { useNativeNotebookTable } from '../../../hooks/useNativeNotebookTable';
import { useNativeRichTableDocument } from '../../../hooks/useNativeRichTableDocument';
('use client');

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTableStore } from '../store/tableStore';
import { useCanvasStore } from '../../../../canvas/public/store';
import { TableGrid } from './TableGrid';
import { TableToolbar } from './TableToolbar';
import { useTableData } from '../hooks/useTableData';
import { useTableEditorControl } from '../table-editor-control';
import {
  TELEMETRY_BLOCKED_ATTRIBUTES,
  TELEMETRY_BLOCKED_CLASS,
} from '../../../../../components/TelemetryBlockedSurface';
import { usePageStore } from '../../../store';
import type { TableOperationObservation } from '../../../../../shared/table-notebook-observation';
import { useCommandHandler } from '../../../../../commands/useCommandHandler';
import { useCommandScope } from '../../../../../commands/useCommandScope';
import { COMMAND_IDS, COMMAND_SCOPES } from '../../../../../commands/types';
import { InsertTableReferenceButton } from './InsertTableReferenceButton';
import { PromoteTableButton } from './PromoteTableButton';
import { TablePromotionRecoveryButton } from './TablePromotionRecoveryButton';

interface TablePanelProps {
  tableId: string;
  tableDocument?: TableDocumentReference;
  canvasTabId?: string;
  embedded?: boolean;
}

export function TablePanel({
  tableId,
  tableDocument,
  canvasTabId,
  embedded = false,
}: TablePanelProps) {
  const root = useRef<HTMLDivElement>(null);
  const [recoveredReference, setRecoveredReference] = useState<TableDocumentReference | null>(null);
  const legacyTable = useTableStore((state) => state.expandedTables[tableId]);
  const resolved = useMemo(() => {
    const source = recoveredReference ?? tableDocument ?? tableDocumentReferenceFromKey(tableId);
    if (!source) return { reference: null, error: null };
    const parsed = tableDocumentReferenceSchema.safeParse(source);
    if (!parsed.success)
      return {
        reference: null,
        error: 'The saved table reference is invalid. Its original data is preserved.',
      };
    try {
      if (tableDocumentKey(parsed.data) !== tableId)
        throw new Error(
          'The table reference does not match this tab. Its original data is preserved.'
        );
      return { reference: parsed.data, error: null };
    } catch (failure) {
      return {
        reference: null,
        error: failure instanceof Error ? failure.message : String(failure),
      };
    }
  }, [tableDocument, tableId, recoveredReference]);
  const native = useNativeNotebookTableDocument(resolved.reference);
  const rich = useNativeRichTableDocument(resolved.reference, tableId);
  const notebook =
    resolved.reference?.backing.kind === 'notebook-inline' ? resolved.reference.backing : null;
  const nativeData = rich.active ? rich.data : native.data;
  const nativeError = rich.active ? rich.error : native.error;
  const nativeLoading = rich.active ? rich.loading : native.loading;
  const nativeWritable = rich.active ? rich.writable : native.writable;
  const nativeDocument = Boolean(resolved.reference || rich.active);
  const table = nativeDocument
    ? nativeData
      ? {
          id: tableId,
          data: nativeData,
          label: nativeData.name ?? rich.title ?? 'Table',
          sourcePageId: notebook?.notebookDocumentId,
          referenceWorkspaceRoot:
            rich.resolved?.owner.kind === 'file'
              ? rich.resolved.owner.workspaceRoot
              : native.client?.snapshot?.workspaceRoot,
          sourceGeneration: undefined,
          onUpdate: undefined,
        }
      : undefined
    : legacyTable;
  const updateTableData = useTableStore((state) => state.updateTableData);
  const panels = useCanvasStore((state) => state.panels);
  const updateTab = useCanvasStore((state) => state.updateTab);
  const retargetTab = useCanvasStore((state) => state.retargetTab);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [updateFailed, setUpdateFailed] = useState(false);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const hasWriter = nativeDocument
    ? nativeWritable
    : !isElectron() && typeof table?.onUpdate === 'function';
  const legacyDirty = usePageStore((state) =>
    table?.sourcePageId ? state.dirtyIds.has(table.sourcePageId) : false
  );

  const sourceDirty = rich.active
    ? rich.client?.dirty
    : resolved.reference
      ? native.client?.dirty
      : legacyDirty;
  const saveNative = useCallback(async () => {
    if (rich.active) {
      if (!rich.client || !rich.writable) return false;
      try {
        setSaveFailure(null);
        await rich.client.save();
        return true;
      } catch (error) {
        setSaveFailure(error instanceof Error ? error.message : String(error));
        reportSaveFailure(
          '[TablePanel] Table document save failed:',
          {
            documentId: rich.client.snapshot?.documentId,
            tableId: rich.resolved?.tableId,
            tabId: canvasTabId,
          },
          error
        );
        return false;
      }
    }
    const client = native.client;
    if (!client || !notebook || !native.writable) return false;
    const saved = await client.save();
    if (!saved && client.lastCommandError)
      reportSaveFailure(
        '[TablePanel] Notebook-backed table save failed:',
        { documentId: notebook.notebookDocumentId, tableId: notebook.blockId, tabId: canvasTabId },
        client.lastCommandError
      );
    return saved;
  }, [
    native.client,
    native.writable,
    notebook,
    canvasTabId,
    rich.active,
    rich.client,
    rich.writable,
    rich.resolved?.tableId,
  ]);
  const embeddedScope = useCommandScope(COMMAND_SCOPES.embedGrid, { enabled: embedded });
  useCommandHandler(
    COMMAND_IDS.fileSave,
    () => {
      if (!embedded || !rich.writable || !root.current?.contains(document.activeElement))
        return false;
      void saveNative();
      return true;
    },
    {
      scope: COMMAND_SCOPES.embedGrid,
      active: embedded,
      enabled: () => Boolean(rich.writable && root.current?.contains(document.activeElement)),
    }
  );
  useDocumentLifecycle(
    native.client &&
      notebook &&
      canvasTabId &&
      resolved.reference?.binding.kind === 'current' &&
      native.data &&
      !resolved.error
      ? {
          target: { kind: 'page', pageId: notebook.notebookDocumentId },
          tabId: canvasTabId,
          isDirty: () => native.client!.dirty,
          save: saveNative,
          discard: () => native.client!.discard(),
        }
      : null
  );
  useDocumentLifecycle(
    rich.active &&
      rich.client &&
      rich.resolved?.owner.kind === 'file' &&
      rich.data &&
      rich.resolved.reference.binding.kind === 'current' &&
      canvasTabId &&
      !resolved.error
      ? {
          target: { kind: 'file', filePath: rich.resolved.owner.path },
          tabId: canvasTabId,
          isDirty: () => rich.client!.dirty,
          save: saveNative,
          discard: () => rich.client!.discard(),
        }
      : null
  );
  useEffect(() => {
    if (!canvasTabId || !rich.resolved || !rich.data) return;
    const reference = rich.resolved.reference;
    const key = tableDocumentKey(reference);
    for (const [panelId, panel] of Object.entries(panels)) {
      const tab = panel.tabs.find((candidate) => candidate.id === canvasTabId);
      if (
        tab &&
        (tab.entityId !== key || JSON.stringify(tab.tableDocument) !== JSON.stringify(reference))
      ) {
        retargetTab(
          panelId,
          canvasTabId,
          { type: 'table', entityId: key },
          {
            tableDocument: reference,
            label: rich.data.name ?? rich.title ?? 'Table',
          }
        );
        return;
      }
    }
  }, [canvasTabId, rich.resolved, rich.data, rich.title, panels, retargetTab]);

  const tabInfo = useMemo(() => {
    for (const [panelId, panel] of Object.entries(panels)) {
      const tab = panel.tabs.find((t) => t.type === 'table' && t.entityId === tableId);
      if (tab) return { panelId, tabId: tab.id };
    }
    return null;
  }, [panels, tableId]);

  const handleUpdateAttrs = useCallback(
    (attrs: Record<string, unknown>, observation?: TableOperationObservation) => {
      try {
        if (rich.active) {
          rich.update(attrs);
          setUpdateFailed(false);
          return;
        }
        if (notebook && native.client) {
          if (!native.writable)
            throw new Error(native.error ?? 'The native table is not available for editing.');
          native.client.updateTable(notebook.blockId, attrs);
          setUpdateFailed(false);
          return;
        }
        if (isElectron() || !useTableStore.getState().getTable(tableId)?.onUpdate) {
          throw new Error('Reopen the source notebook before editing this table.');
        }
        updateTableData(tableId, attrs as Parameters<typeof updateTableData>[1], observation);
        setUpdateFailed(false);
      } catch (error) {
        setUpdateFailed(true);
        throw error;
      }
    },
    [
      tableId,
      updateTableData,
      notebook,
      native.client,
      native.writable,
      native.error,
      rich.active,
      rich.update,
    ]
  );

  const nativeTable = useNativeNotebookTable(
    table?.sourcePageId,
    notebook?.blockId ?? tableId,
    table?.data ?? {}
  );
  const tableCommands = useTableData({
    ...nativeTable,
    ...(rich.active ? rich.controls : {}),
    data: table?.data || { cells: [] },
    onUpdateAttrs: handleUpdateAttrs,
    historyEpoch: table?.sourceGeneration,
    observationSurface: 'expanded',
  });
  useTableEditorControl({
    pageId: table?.sourcePageId,
    tableId: notebook?.blockId ?? tableId,
    view: 'panel',
    commands: tableCommands,
    data: table?.data || { cells: [] },
  });
  const {
    name,
    setName,
    displayCells,
    cells,
    visibleRowIndices,
    rows,
    cols,
    sort,
    filters,
    updateCell,
    expandAndSetCell,
    fillRange,
    deleteRange,
    copyCells,
    cutCells,
    pasteCells,
    cutRange,
    clearCut,
    addRow,
    removeRow,
    addColumn,
    removeColumn,
    setSort,
    setFilter,
    clearFilters,
    pasteCSV,
    pasteHTMLTable,
    replaceTableFromClipboard,
    exportCSV,
    copyToClipboard,
    undo,
    redo,
    columnWidths,
    rowHeights,
    columnLabels,
    setColumnWidth,
    setRowHeight,
    setColumnLabel,
    setCellFormat,
  } = tableCommands;
  const displayName = rich.active ? (rich.data?.name ?? rich.title ?? name) : name;

  const handleNameClick = useCallback(() => {
    if (!hasWriter) return;
    setEditedName(displayName);
    setIsEditingName(true);
  }, [displayName, hasWriter]);

  const handleNameBlur = useCallback(() => {
    if (!hasWriter) return;
    const trimmedName = editedName.trim();
    if (trimmedName && trimmedName !== displayName) {
      try {
        setName(trimmedName);
      } catch {
        return;
      }
      if (tabInfo) {
        updateTab(tabInfo.panelId, tabInfo.tabId, { label: trimmedName });
      }
    }
    setIsEditingName(false);
  }, [editedName, displayName, setName, tabInfo, updateTab, hasWriter]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleNameBlur();
      } else if (e.key === 'Escape') {
        setIsEditingName(false);
        setEditedName(displayName);
      }
    },
    [handleNameBlur, displayName]
  );

  const unavailable = resolved.error ?? (nativeData ? null : nativeError);
  const recovery = resolved.reference ? (
    <TablePromotionRecoveryButton
      reference={resolved.reference}
      workspaceRoot={
        rich.resolved?.owner.kind === 'file'
          ? rich.resolved.owner.workspaceRoot
          : native.client?.snapshot?.workspaceRoot
      }
      onRecovered={(reference) => {
        if (canvasTabId) {
          for (const [panelId, panel] of Object.entries(panels)) {
            if (panel.tabs.some((tab) => tab.id === canvasTabId)) {
              retargetTab(
                panelId,
                canvasTabId,
                { type: 'table', entityId: tableDocumentKey(reference) },
                { tableDocument: reference }
              );
              return;
            }
          }
        }
        setRecoveredReference(reference);
      }}
    />
  ) : null;
  if (!table || unavailable) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-fg-muted">
        <div className="text-center">
          <div className="text-lg mb-2">
            {nativeLoading ? 'Loading table…' : 'Table unavailable'}
          </div>
          <div role="status" className="text-sm">
            {unavailable ??
              (nativeLoading
                ? 'Opening the saved table.'
                : 'The table may have been removed or is no longer available.')}
          </div>
          <div className="mt-3">{recovery}</div>
        </div>
      </div>
    );
  }

  const hasFilters = Object.keys(filters).length > 0;

  return (
    <div
      ref={root}
      {...(embedded ? embeddedScope.eventHandlers : {})}
      {...TELEMETRY_BLOCKED_ATTRIBUTES}
      data-ph-mask="true"
      className={`${TELEMETRY_BLOCKED_CLASS} h-full flex flex-col bg-bg`}
    >
      {}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-subtle">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg-muted uppercase tracking-wide">Table</span>
          <span className="text-fg-muted/30">·</span>
          {isEditingName ? (
            <input
              type="text"
              value={editedName}
              readOnly={!hasWriter}
              onChange={(e) => setEditedName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              className="text-sm font-medium bg-transparent border-b border-accent outline-none px-0.5 -mx-0.5"
              autoFocus
            />
          ) : (
            <button
              onClick={handleNameClick}
              disabled={!hasWriter}
              className="text-sm font-medium hover:text-accent transition-colors"
              title="Click to rename"
            >
              {displayName}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          {!embedded && rich.resolved && rich.data && (
            <InsertTableReferenceButton
              reference={rich.resolved.reference}
              client={rich.client}
              title={rich.data.name ?? rich.title ?? 'Table'}
            />
          )}
          {!embedded && notebook && resolved.reference && nativeWritable && (
            <PromoteTableButton
              reference={resolved.reference}
              title={displayName}
              onPromoted={(reference) => {
                if (canvasTabId && tabInfo)
                  retargetTab(
                    tabInfo.panelId,
                    canvasTabId,
                    {
                      type: 'table',
                      entityId: tableDocumentKey(reference),
                    },
                    { tableDocument: reference, label: displayName }
                  );
              }}
            />
          )}
          {hasFilters && visibleRowIndices.length !== rows ? (
            <span>
              {visibleRowIndices.length}/{rows} rows
            </span>
          ) : (
            <span>{rows} rows</span>
          )}
          <span className="text-fg-muted/50">x</span>
          <span>{cols} cols</span>
          {(notebook || rich.client) && (
            <button
              type="button"
              data-testid="table-save"
              disabled={
                !nativeWritable ||
                (rich.active
                  ? rich.client?.saving || !rich.client?.dirty
                  : native.client?.saving || !native.client?.dirty)
              }
              onClick={() => void saveNative()}
              className="rounded border border-border px-2 py-1 disabled:opacity-50"
            >
              {(rich.active ? rich.client?.saving : native.client?.saving)
                ? 'Saving…'
                : embedded
                  ? 'Save table'
                  : 'Save'}
            </button>
          )}
        </div>
      </div>

      {recovery && <div className="px-4 py-2">{recovery}</div>}

      {!hasWriter && (
        <p role="status" className="px-4 py-2 text-xs text-fg-muted">
          {notebook
            ? native.client?.snapshot?.recovery
              ? 'Resolve the notebook recovery before editing this table.'
              : 'This table is read-only. Your current data is retained.'
            : rich.active
              ? rich.resolved?.owner.kind === 'saved-version'
                ? 'Saved version. Changes to the current table do not change this view.'
                : 'This table is read-only. Your current data is retained.'
              : 'Source notebook is not available. Reopen it to edit this table.'}
        </p>
      )}
      {notebook && native.client?.snapshot && (
        <p role="status" className="px-4 py-2 text-xs text-fg-muted">
          Saving this table also saves changes in {native.client.snapshot.title}.
        </p>
      )}
      {nativeError && nativeData && (
        <p role="alert" className="px-4 py-2 text-xs">
          {nativeError}
        </p>
      )}
      {saveFailure && (
        <p role="alert" className="px-4 py-2 text-xs">
          {saveFailure}
        </p>
      )}
      {native.client?.lastCommandError != null && (
        <p role="alert" className="px-4 py-2 text-xs">
          {native.client.lastCommandError instanceof Error
            ? native.client.lastCommandError.message
            : String(native.client.lastCommandError)}
        </p>
      )}
      {sourceDirty && (
        <p role="status" className="px-4 py-2 text-xs text-fg-muted">
          {rich.active ? 'Table has unsaved changes.' : 'Source notebook has unsaved changes.'}
        </p>
      )}
      {hasWriter && updateFailed && (
        <p role="alert" className="px-4 py-2 text-xs">
          The source did not accept this change. Keep your input and retry.
        </p>
      )}

      {}
      <div className="flex-1 overflow-auto">
        <TableGrid
          key={table.sourceGeneration ?? 0}
          readOnly={!hasWriter}
          displayCells={displayCells}
          cells={cells}
          visibleRowIndices={visibleRowIndices}
          sort={sort}
          filters={filters}
          onCellChange={updateCell}
          onExpandAndSetCell={expandAndSetCell}
          onFillRange={fillRange}
          onDeleteRange={deleteRange}
          onCopyCells={copyCells}
          onCutCells={cutCells}
          onPasteCells={pasteCells}
          cutRange={cutRange}
          onClearCut={clearCut}
          onSort={setSort}
          onFilter={setFilter}
          onPaste={pasteCSV}
          onPasteHTML={pasteHTMLTable}
          onUndo={undo}
          onRedo={redo}
          columnWidths={columnWidths}
          rowHeights={rowHeights}
          columnLabels={columnLabels}
          showColumnLabels={columnLabels.length > 0}
          referenceWorkspaceRoot={table.referenceWorkspaceRoot}
          onColumnResize={hasWriter ? setColumnWidth : undefined}
          onRowResize={hasWriter ? setRowHeight : undefined}
          onColumnLabelChange={hasWriter ? setColumnLabel : undefined}
          showGhostRows={true}
          showGhostCols={true}
          onCellFormat={hasWriter ? setCellFormat : undefined}
        />
      </div>

      {}
      <div className="border-t border-border">
        <TableToolbar
          rows={rows}
          cols={cols}
          hasFilters={hasFilters}
          readOnly={!hasWriter}
          onAddRow={addRow}
          onRemoveRow={() => removeRow(rows - 1)}
          onAddColumn={addColumn}
          onRemoveColumn={() => removeColumn(cols - 1)}
          onClearFilters={clearFilters}
          onExportCSV={exportCSV}
          onCopyToClipboard={copyToClipboard}
          onReplaceTable={replaceTableFromClipboard}
        />
      </div>
    </div>
  );
}

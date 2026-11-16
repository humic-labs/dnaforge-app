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
('use client');

import { useState, useCallback, useMemo } from 'react';
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

interface TablePanelProps {
  tableId: string;
  tableDocument?: TableDocumentReference;
  canvasTabId?: string;
}

export function TablePanel({ tableId, tableDocument, canvasTabId }: TablePanelProps) {
  const legacyTable = useTableStore((state) => state.expandedTables[tableId]);
  const resolved = useMemo(() => {
    const source = tableDocument ?? tableDocumentReferenceFromKey(tableId);
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
  }, [tableDocument, tableId]);
  const native = useNativeNotebookTableDocument(resolved.reference);
  const notebook =
    resolved.reference?.backing.kind === 'notebook-inline' ? resolved.reference.backing : null;
  const table = resolved.reference
    ? native.data
      ? {
          id: tableId,
          data: native.data,
          label: native.data.name ?? 'Table',
          sourcePageId: notebook?.notebookDocumentId,
          referenceWorkspaceRoot: native.client?.snapshot?.workspaceRoot,
          sourceGeneration: undefined,
          onUpdate: undefined,
        }
      : undefined
    : legacyTable;
  const updateTableData = useTableStore((state) => state.updateTableData);
  const panels = useCanvasStore((state) => state.panels);
  const updateTab = useCanvasStore((state) => state.updateTab);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [updateFailed, setUpdateFailed] = useState(false);
  const hasWriter = resolved.reference
    ? native.writable
    : !isElectron() && typeof table?.onUpdate === 'function';
  const legacyDirty = usePageStore((state) =>
    table?.sourcePageId ? state.dirtyIds.has(table.sourcePageId) : false
  );

  const sourceDirty = resolved.reference ? native.client?.dirty : legacyDirty;
  const saveNative = useCallback(async () => {
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
  }, [native.client, native.writable, notebook, canvasTabId]);
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
    [tableId, updateTableData, notebook, native.client, native.writable, native.error]
  );

  const nativeTable = useNativeNotebookTable(
    table?.sourcePageId,
    notebook?.blockId ?? tableId,
    table?.data ?? {}
  );
  const tableCommands = useTableData({
    ...nativeTable,
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

  const handleNameClick = useCallback(() => {
    if (!hasWriter) return;
    setEditedName(name);
    setIsEditingName(true);
  }, [name, hasWriter]);

  const handleNameBlur = useCallback(() => {
    if (!hasWriter) return;
    const trimmedName = editedName.trim();
    if (trimmedName && trimmedName !== name) {
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
  }, [editedName, name, setName, tabInfo, updateTab, hasWriter]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleNameBlur();
      } else if (e.key === 'Escape') {
        setIsEditingName(false);
        setEditedName(name);
      }
    },
    [handleNameBlur, name]
  );

  const unavailable = resolved.error ?? (native.data ? null : native.error);
  if (!table || unavailable) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-fg-muted">
        <div className="text-center">
          <div className="text-lg mb-2">
            {native.loading ? 'Loading table…' : 'Table unavailable'}
          </div>
          <div role="status" className="text-sm">
            {unavailable ??
              (native.loading
                ? 'Opening the saved notebook table.'
                : 'The table may have been removed or is no longer available.')}
          </div>
        </div>
      </div>
    );
  }

  const hasFilters = Object.keys(filters).length > 0;

  return (
    <div
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
              {name}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          {hasFilters && visibleRowIndices.length !== rows ? (
            <span>
              {visibleRowIndices.length}/{rows} rows
            </span>
          ) : (
            <span>{rows} rows</span>
          )}
          <span className="text-fg-muted/50">x</span>
          <span>{cols} cols</span>
          {notebook && (
            <button
              type="button"
              data-testid="table-save"
              disabled={!native.writable || native.client?.saving || !native.client?.dirty}
              onClick={() => void saveNative()}
              className="rounded border border-border px-2 py-1 disabled:opacity-50"
            >
              {native.client?.saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {!hasWriter && (
        <p role="status" className="px-4 py-2 text-xs text-fg-muted">
          {notebook
            ? native.client?.snapshot?.recovery
              ? 'Resolve the notebook recovery before editing this table.'
              : 'This table is read-only. Your current data is retained.'
            : 'Source notebook is not available. Reopen it to edit this table.'}
        </p>
      )}
      {notebook && native.client?.snapshot && (
        <p role="status" className="px-4 py-2 text-xs text-fg-muted">
          Saving this table also saves changes in {native.client.snapshot.title}.
        </p>
      )}
      {native.error && native.data && (
        <p role="alert" className="px-4 py-2 text-xs">
          {native.error}
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
          Source notebook has unsaved changes.
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

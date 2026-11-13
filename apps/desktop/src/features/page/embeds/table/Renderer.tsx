import { useNativeNotebookTable } from '../../hooks/useNativeNotebookTable';
('use client');

import { configureTableData } from './configuration';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmbedRendererProps } from '../types';
import { EmbedWrapper } from '../components/EmbedWrapper';
import { TableGrid } from './components/TableGrid';
import { TableToolbar } from './components/TableToolbar';
import { InlineConfig } from './components/InlineConfig';
import { useTableData } from './hooks/useTableData';
import { useTableEditorControl } from './table-editor-control';
import { useTableStore } from './store/tableStore';
import { useCanvasStore } from '../../../canvas/public/store';
import { useOptionalReferenceContext } from '../../entity-ref/reference-context';
import type { TableData } from './types';
import { TelemetryBlockedSurface } from '../../../../components/TelemetryBlockedSurface';
import type { TableOperationObservation } from '../../../../shared/table-notebook-observation';
import { tableOperationObservation } from './utils/operation-observation';

function isConfigured(data: TableData): boolean {
  return (
    typeof data.rows === 'number' && data.rows > 0 && typeof data.cols === 'number' && data.cols > 0
  );
}

function useStableCallback<Args extends unknown[], R>(
  callback: ((...args: Args) => R) | undefined
): ((...args: Args) => R) | undefined {
  const ref = useRef(callback);
  ref.current = callback;
  return useMemo(() => {
    if (!callback) return undefined;
    return (...args: Args) => ref.current!(...args);
  }, [!!callback]);
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ConfiguredTable({
  data,
  refId,
  selected,
  onRemove,
  onUpdateAttrs,
  onSelect,
  onOpenTable,
}: {
  data: TableData;
  refId: string;
  selected: boolean;
  onRemove: () => void;
  onUpdateAttrs?: (attrs: Record<string, unknown>, observation?: TableOperationObservation) => void;
  onSelect?: () => void;
  onOpenTable?: (open: () => boolean) => void;
}) {
  const referenceContext = useOptionalReferenceContext();
  const sourcePageId = referenceContext?.pageId;
  const referenceWorkspaceRoot = referenceContext?.owningRoot;
  const isDocumentPresentation = data.presentation === 'document';
  const hasWriter = typeof onUpdateAttrs === 'function';

  const stableOnUpdateAttrs = useStableCallback(onUpdateAttrs);

  const tableId = data.id ?? refId;

  const registerTable = useTableStore((state) => state.registerTable);
  const unbindSource = useTableStore((state) => state.unbindSource);
  const openWithSmartPlacement = useCanvasStore((state) => state.openWithSmartPlacement);
  const panels = useCanvasStore((state) => state.panels);

  const hasTabForTable = useMemo(() => {
    return Object.values(panels).some((panel) =>
      panel.tabs.some((tab) => tab.type === 'table' && tab.entityId === tableId)
    );
  }, [panels, tableId]);

  const isOpenInPanel = hasTabForTable;

  useEffect(() => {
    if (hasTabForTable) {
      registerTable(tableId, data, `Table`, {
        sourcePageId,
        referenceWorkspaceRoot,
        onUpdate: stableOnUpdateAttrs,
      });
    }
  }, [
    hasTabForTable,
    tableId,
    data,
    registerTable,
    sourcePageId,
    referenceWorkspaceRoot,
    stableOnUpdateAttrs,
  ]);

  useEffect(
    () => () => {
      if (stableOnUpdateAttrs) unbindSource(tableId, stableOnUpdateAttrs);
    },
    [tableId, stableOnUpdateAttrs, unbindSource]
  );

  const nativeTable = useNativeNotebookTable(sourcePageId, tableId, data);
  const tableCommands = useTableData({
    data,
    onUpdateAttrs,
    observationSurface: 'inline',
    ...nativeTable,
  });
  useTableEditorControl({
    pageId: sourcePageId,
    tableId,
    view: 'embed',
    commands: tableCommands,
    data,
  });
  const {
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
    clearFilters: _clearFilters,
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
    name,
    setName,
    setCellFormat,
  } = tableCommands;

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(name);

  useEffect(() => {
    if (!isEditingName) {
      setEditedName(name);
    }
  }, [name, isEditingName]);

  const handleNameClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!hasWriter) return;
      setEditedName(name);
      setIsEditingName(true);
    },
    [name, hasWriter]
  );

  const handleNameBlur = useCallback(() => {
    setIsEditingName(false);
    const trimmedName = editedName.trim();
    if (hasWriter && trimmedName && trimmedName !== name) {
      setName(trimmedName);
    }
  }, [editedName, name, setName, hasWriter]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.currentTarget.blur();
      } else if (e.key === 'Escape') {
        setEditedName(name);
        setIsEditingName(false);
      }
    },
    [name]
  );

  const label = isOpenInPanel ? (
    <span className="text-sm font-medium truncate text-fg-muted">{name}</span>
  ) : isEditingName ? (
    <input
      type="text"
      value={editedName}
      readOnly={!hasWriter}
      onChange={(e) => setEditedName(e.target.value)}
      onBlur={handleNameBlur}
      onKeyDown={handleNameKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="text-sm font-medium bg-transparent border-b border-accent outline-none px-0.5 -mx-0.5 min-w-[100px]"
      autoFocus
    />
  ) : (
    <button
      data-testid="table-title"
      onClick={handleNameClick}
      disabled={!hasWriter}
      className="text-sm font-medium hover:text-accent transition-colors truncate"
      title="Click to rename"
    >
      {name}
    </button>
  );

  const handleExpand = useCallback(() => {
    const open = () => {
      registerTable(tableId, data, name, {
        sourcePageId,
        referenceWorkspaceRoot,
        onUpdate: stableOnUpdateAttrs,
      });
      const tabId = openWithSmartPlacement('table', tableId, name);
      const accepted = Object.values(useCanvasStore.getState().panels).some(
        (panel) =>
          panel.activeTabId === tabId &&
          panel.tabs.some(
            (tab) => tab.id === tabId && tab.type === 'table' && tab.entityId === tableId
          )
      );
      const source = useTableStore.getState().getTable(tableId);
      return accepted && source?.data === data && source.onUpdate === stableOnUpdateAttrs;
    };
    if (onOpenTable) onOpenTable(open);
    else open();
  }, [
    tableId,
    data,
    name,
    registerTable,
    openWithSmartPlacement,
    sourcePageId,
    referenceWorkspaceRoot,
    stableOnUpdateAttrs,
    onOpenTable,
  ]);

  const handleFocusPanel = useCallback(() => {
    if (isOpenInPanel) {
      handleExpand();
    }
  }, [isOpenInPanel, handleExpand]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.stopPropagation();
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.stopPropagation();
    }
  }, []);

  const handleTableMouseDown = useCallback(() => {
    if (!selected && onSelect) {
      onSelect();
    }
  }, [selected, onSelect]);

  return (
    <EmbedWrapper
      type="table"
      label={
        <TelemetryBlockedSurface as="span" data-ph-mask="true">
          {label}
        </TelemetryBlockedSurface>
      }
      selected={selected}
      onRemove={onRemove}
      onExpand={handleExpand}
    >
      <div
        className="border-t border-border relative"
        onKeyDown={handleKeyDown}
        onMouseDown={handleTableMouseDown}
      >
        {}
        {isOpenInPanel && (
          <div
            className="absolute inset-0 z-20 bg-bg/50 flex items-center justify-center cursor-pointer"
            onClick={handleFocusPanel}
            title="Click to focus the panel"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-subtle border border-border rounded-md shadow-sm">
              <LockIcon className="w-4 h-4 text-fg-muted" />
              <span className="text-sm text-fg-muted">Editing in panel</span>
            </div>
          </div>
        )}
        <div className={isOpenInPanel ? 'opacity-50 pointer-events-none' : ''}>
          <TableGrid
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
            showCoordinateHeaders={!isDocumentPresentation || hasWriter}
            showFormulaBar={!isDocumentPresentation}
            referenceWorkspaceRoot={referenceWorkspaceRoot}
            onColumnResize={hasWriter ? setColumnWidth : undefined}
            onRowResize={hasWriter ? setRowHeight : undefined}
            onColumnLabelChange={hasWriter ? setColumnLabel : undefined}
            onCellFormat={hasWriter ? setCellFormat : undefined}
            showGhostCols={!isDocumentPresentation}
          />
        </div>
        {(!isDocumentPresentation || selected) && (
          <TableToolbar
            readOnly={!hasWriter}
            rows={rows}
            cols={cols}
            onAddRow={addRow}
            onRemoveRow={() => removeRow(rows - 1)}
            onAddColumn={addColumn}
            onRemoveColumn={() => removeColumn(cols - 1)}
            onExportCSV={exportCSV}
            onCopyToClipboard={copyToClipboard}
            onReplaceTable={replaceTableFromClipboard}
          />
        )}
      </div>
    </EmbedWrapper>
  );
}

export function TableRenderer({
  refId,
  attrs,
  selected,
  onRemove,
  onUpdateAttrs,
  onSelect,
  onBlurToEditor,
  onOpenTable,
}: EmbedRendererProps) {
  const data = attrs as TableData;
  const configured = isConfigured(data);

  const handleConfigure = useCallback(
    (rows: number, cols: number) => {
      const next = configureTableData(data, { rows, columns: cols });
      const observation = tableOperationObservation('configure', 'inline', [], {
        result: 'none',
        evaluatedCount: 0,
        errorCount: 0,
        savedCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      });
      if (observation) onUpdateAttrs?.(next, { ...observation, rows, columns: cols });
      else onUpdateAttrs?.(next);
    },
    [data, onUpdateAttrs]
  );

  const handleClearFresh = useCallback(() => {
    if (data._fresh) {
      onUpdateAttrs?.({ ...data, _fresh: undefined });
    }
  }, [data, onUpdateAttrs]);

  if (!configured) {
    return (
      <EmbedWrapper type="table" label="New Table" selected={selected} onRemove={onRemove}>
        <div className="px-3">
          <InlineConfig
            onConfigure={handleConfigure}
            autoFocus={!!data._fresh}
            onClearFresh={handleClearFresh}
            onBlurToEditor={onBlurToEditor}
          />
        </div>
      </EmbedWrapper>
    );
  }

  return (
    <ConfiguredTable
      data={data}
      refId={refId}
      selected={selected}
      onRemove={onRemove}
      onUpdateAttrs={onUpdateAttrs}
      onSelect={onSelect}
      onOpenTable={onOpenTable}
    />
  );
}

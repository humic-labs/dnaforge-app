import { useDocumentLifecycle } from '../shared/use-document-lifecycle';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { captureWorkspaceSessionIntent } from '../features/workspace-session/public/electron-session';
import { isHostedBrowserRuntime } from '../utils/environment';
import { useToastStore } from '../stores/toast-store';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { platform } from '../platform';
import { useCanvasStore } from '../features/canvas/store';
import { TableGrid } from '../features/page/embeds/table/components/TableGrid';
import { useTableData } from '../features/page/embeds/table/hooks/useTableData';
import type { Cell, TableData } from '../shared/table-document-types';
import { getExtension, getFilename } from '../utils/fileTypes';
import { resolveFilePathWithFallback } from '../hooks/resolveFilePath';
import { isMissingFileError } from '../features/canvas/oversize-scan';
import {
  parseTabularPreview,
  parseXlsxPreview,
  serializeDelimitedRows,
  type TabularDelimiter,
  type TabularPreview,
} from './tabularFileParser';
import {
  beginReadableContentOwner,
  commitReadableContent,
  failReadableContent,
  type ReadableContentOwner,
} from '../lib/readable-content-telemetry';
import { fingerprintText, useUnsavedDraftRecovery } from '../shared/unsaved-draft-recovery';
import {
  FileDocumentDraft,
  waitForFileDocumentSaves,
} from '../features/workspace/public/file-document-draft';
import {
  FileDocumentClient,
  getFileDocumentClient,
} from '../features/workspace/public/file-document-client';
import { isBrowserOnly } from '../utils/environment';

const MAX_TABULAR_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TABULAR_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 1000;
const EMPTY_TABLE_DATA: TableData = { cells: [] };
const TABULAR_TOOLBAR_BUTTON_CLASS =
  'h-6 px-2 rounded-[5px] border border-border/60 bg-bg text-[11px] font-medium text-fg-muted leading-none transition-colors hover:border-border hover:bg-bg-muted hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:border-border/60 disabled:hover:bg-bg disabled:hover:text-fg-muted';

type LoadState = (
  | { status: 'loading' }
  | {
      status: 'ready';
      table: TabularPreview;
      sizeBytes: number;
      formatLabel: string;
      slicedPreview: boolean;
      previewBytesRead: number;
    }
  | { status: 'fallback'; reason: string; sizeBytes: number | null; formatLabel: string }
  | { status: 'error'; message: string }
) & { readableOwner?: ReadableContentOwner | null };

interface TabularFileViewerTabProps {
  canvasTabId?: string;
  filePath: string;
  sourceFileName?: string;
  readOnly?: boolean;
}

export function TabularFileViewerTab({
  canvasTabId,
  filePath,
  sourceFileName,
  readOnly = false,
}: TabularFileViewerTabProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const [tableData, setTableData] = useState<TableData>(EMPTY_TABLE_DATA);
  const [baselineText, setBaselineText] = useState('');
  const [firstRowAsHeader, setFirstRowAsHeader] = useState(false);
  const [headerRowValues, setHeaderRowValues] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastSaveError = useRef<string | null>(null);
  const document = useMemo(
    () =>
      isBrowserOnly() || (readOnly && Boolean(sourceFileName))
        ? new FileDocumentDraft(resolveFilePathWithFallback(filePath))
        : getFileDocumentClient(resolveFilePathWithFallback(filePath)),
    [filePath, readOnly, sourceFileName]
  );
  useEffect(() => {
    if (!(document instanceof FileDocumentClient)) return;
    return document.subscribe(() => {
      if (document.pendingChanges === 0 && document.snapshot?.tableData) {
        setTableData(document.snapshot.tableData);
        setFirstRowAsHeader(Boolean(document.snapshot.firstRowAsHeader));
        setHeaderRowValues(document.snapshot.headerRowValues ?? []);
      }
      setBaselineText(document.diskContent ?? '');
      setDirty(document.dirty);
      const recoveryId = document.snapshot?.recoveryId;
      if (recoveryId && offeredNativeRecovery.current !== recoveryId) {
        offeredNativeRecovery.current = recoveryId;
        useToastStore.getState().addRichToast({
          definition: 'unsaved-draft-recovery-available',
          message: userMessage(
            'notice.this-file-has-an-unsaved-native-working-copy-from-a-previous-session'
          ),
          actions: [
            {
              label: 'Restore',
              onClick: async () => {
                await document.execute({ kind: 'restore-recovery', recoveryId });
              },
            },
            { label: 'Discard', onClick: () => document.execute({ kind: 'discard' }) },
          ],
        });
      }
      if (document.error) {
        setSaveError(toUserMessage(document.error, 'document.openFailed'));
        setSaveState('error');
      }
    });
  }, [document]);
  const currentDocument = useRef(document);
  currentDocument.current = document;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const offeredNativeRecovery = useRef<string | null>(null);
  const filename = useMemo(
    () => getFilename(sourceFileName ?? filePath),
    [filePath, sourceFileName]
  );
  const openInFocusedPanel = useCanvasStore((s) => s.openInFocusedPanel);
  const updateTabByEntityId = useCanvasStore((s) => s.updateTabByEntityId);

  const delimiterInfo = useMemo(
    () => delimiterForPath(sourceFileName ?? filePath),
    [filePath, sourceFileName]
  );
  const handleTableDataUpdate = useCallback(
    (attrs: Record<string, unknown>) => {
      if (readOnly) return;
      const next = { ...tableData, ...attrs };
      setTableData(next);
      if (document instanceof FileDocumentClient)
        document.changeTable(
          {
            ...next,
            columnLabels: firstRowAsHeader
              ? Array.isArray(attrs.columnLabels)
                ? (attrs.columnLabels as string[])
                : headerRowValues
              : undefined,
          },
          firstRowAsHeader
        );
      if (firstRowAsHeader && 'columnLabels' in attrs)
        setHeaderRowValues(
          Array.isArray(attrs.columnLabels) ? (attrs.columnLabels as string[]) : []
        );
      setDirty(true);
      setSaveState('idle');
      setSaveError(null);
    },
    [document, tableData, firstRowAsHeader, headerRowValues, readOnly]
  );
  const tableModel = useTableData({
    data: { ...tableData, columnLabels: firstRowAsHeader ? headerRowValues : undefined },
    onUpdateAttrs: handleTableDataUpdate,
    historyEpoch,
    externalHistory:
      document instanceof FileDocumentClient
        ? {
            canUndo: Boolean(document.snapshot?.canUndo),
            canRedo: Boolean(document.snapshot?.canRedo),
            undo: () => {
              void document.execute({ kind: 'undo' }).catch(() => {});
              return null;
            },
            redo: () => {
              void document.execute({ kind: 'redo' }).catch(() => {});
              return null;
            },
          }
        : undefined,
    onViewChange:
      document instanceof FileDocumentClient
        ? ({ sort, filters }) => {
            setTableData((previous) => ({ ...previous, sort: sort ?? undefined, filters }));
            document.changeTableView(sort, filters);
          }
        : undefined,
  });

  useLayoutEffect(() => {
    if (state.status !== 'ready' || !delimiterInfo.delimiter || state.table.truncated) return;
    document.change(
      serializeDelimitedRows(
        getPhysicalRows({ bodyCells: tableModel.cells, firstRowAsHeader, headerRowValues }),
        delimiterInfo.delimiter,
        document.diskContent ?? undefined
      )
    );
    setDirty(document.dirty);
  }, [
    document,
    state.status,
    state.status === 'ready' && state.table.truncated,
    delimiterInfo.delimiter,
    firstRowAsHeader,
    headerRowValues,
    tableModel.cells,
    baselineText,
  ]);

  useEffect(() => {
    let cancelled = false;
    const readableOwner = beginReadableContentOwner({ tabId: canvasTabId, contentKey: filePath });
    setState({ status: 'loading' });
    setTableData(EMPTY_TABLE_DATA);
    setBaselineText('');
    setFirstRowAsHeader(false);
    setHeaderRowValues([]);
    setDirty(false);
    setSaveState('idle');
    setSaveError(null);
    setHistoryEpoch((epoch) => epoch + 1);

    (async () => {
      const formatLabel = delimiterInfo.label;
      try {
        if (delimiterInfo.isXlsx) {
          const resolvedXlsx = resolveFilePathWithFallback(filePath);
          const xlsxStat = await platform().fs.stat(resolvedXlsx);
          if (cancelled) return;
          const bytes = await platform().fs.readFile(resolvedXlsx);
          if (cancelled) return;
          const parsedXlsx = parseXlsxPreview(bytes, { maxRows: MAX_PREVIEW_ROWS });
          if (!parsedXlsx.ok) {
            setTableData(EMPTY_TABLE_DATA);
            setState({
              status: 'fallback',
              readableOwner,
              reason: `${formatLabel} could not be read: ${parsedXlsx.error}`,
              sizeBytes: xlsxStat.size,
              formatLabel,
            });
            return;
          }
          const projX = tabularPreviewToGridProjection(parsedXlsx, parsedXlsx.hasHeader);
          setTableData({
            cells: rowsToGridCells(projX.bodyRows),
            rows: projX.bodyRows.length,
            cols: projX.totalColumns,
            name: filename,
          });
          setFirstRowAsHeader(parsedXlsx.hasHeader);
          setHeaderRowValues(projX.headerRowValues);
          setBaselineText('');
          setDirty(false);
          setState({
            status: 'ready',
            readableOwner,
            table: parsedXlsx,
            sizeBytes: xlsxStat.size,
            formatLabel,
            slicedPreview: parsedXlsx.truncated,
            previewBytesRead: xlsxStat.size,
          });
          commitReadableContent(filePath);
          return;
        }

        if (!delimiterInfo.delimiter) {
          setState({
            status: 'fallback',
            readableOwner,
            reason: 'Unsupported table file extension.',
            sizeBytes: null,
            formatLabel,
          });
          return;
        }

        const resolved = resolveFilePathWithFallback(filePath);
        await waitForFileDocumentSaves(resolved);
        if (cancelled) return;
        const stat = await platform().fs.stat(resolved);
        if (cancelled) return;

        const slicedPreview = stat.size > MAX_TABULAR_FILE_BYTES;
        const readResult = slicedPreview
          ? await platform().fs.readTextFileSlice(resolved, MAX_TABULAR_PREVIEW_BYTES)
          : { text: await platform().fs.readTextFile(resolved), bytesRead: stat.size };
        if (cancelled) return;

        const parsed = parseTabularPreview(readResult.text, {
          delimiter: delimiterInfo.delimiter,
          maxRows: MAX_PREVIEW_ROWS,
          inputTruncated: slicedPreview,
        });

        if (!parsed.ok) {
          setTableData(EMPTY_TABLE_DATA);
          setState({
            status: 'fallback',
            readableOwner,
            reason: `${formatLabel} could not be parsed as a ${formatLabel} table: ${parsed.error}`,
            sizeBytes: stat.size,
            formatLabel,
          });
          return;
        }

        const initialProjection = tabularPreviewToGridProjection(parsed, parsed.hasHeader);
        if (document instanceof FileDocumentClient) await document.load();
        else
          document.load(
            serializeDelimitedRows(parsed.sourceRows, delimiterInfo.delimiter, readResult.text),
            readResult.text
          );
        if (cancelled || currentDocument.current !== document) return;
        const nativeSnapshot = document instanceof FileDocumentClient ? document.snapshot : null;
        setTableData(
          nativeSnapshot?.tableData ?? {
            cells: rowsToGridCells(initialProjection.bodyRows),
            rows: initialProjection.bodyRows.length,
            cols: initialProjection.totalColumns,
            name: filename,
          }
        );
        setFirstRowAsHeader(nativeSnapshot?.firstRowAsHeader ?? parsed.hasHeader);
        setHeaderRowValues(nativeSnapshot?.headerRowValues ?? initialProjection.headerRowValues);
        setBaselineText(document.diskContent ?? readResult.text);
        setDirty(document.dirty);
        setState({
          status: 'ready',
          readableOwner,
          table: parsed,
          sizeBytes: stat.size,
          formatLabel,
          slicedPreview,
          previewBytesRead: readResult.bytesRead,
        });
        commitReadableContent(filePath);
      } catch (err) {
        if (cancelled) return;
        readableOwner?.fail();
        failReadableContent(filePath);
        if (isMissingFileError(err)) {
          updateTabByEntityId(filePath, {
            loadStatus: 'missing',
            fileSizeBytes: undefined,
          });
          return;
        }
        console.error('[TabularFileViewerTab] Failed to load table file:', err);
        setState({
          status: 'error',
          readableOwner,
          message: toUserMessage(err, 'failure.failed-to-load-table-file'),
        });
      }
    })();

    return () => {
      cancelled = true;
      readableOwner?.release();
    };
  }, [canvasTabId, delimiterInfo, document, filePath, filename, updateTabByEntityId]);

  useEffect(() => {
    if (state.status === 'ready') state.readableOwner?.readable();
    else if (state.status === 'fallback' || state.status === 'error') state.readableOwner?.fail();
  }, [state]);

  const recoveryBaseline = useMemo(
    () => (state.status === 'ready' && baselineText ? fingerprintText(baselineText) : null),
    [baselineText, state.status]
  );
  const recoveryPayload = useMemo(
    () => ({ tableData, firstRowAsHeader, headerRowValues }),
    [firstRowAsHeader, headerRowValues, tableData]
  );
  const currentRecoveryPayload = useRef(recoveryPayload);
  currentRecoveryPayload.current = recoveryPayload;
  const { flushDraft } = useUnsavedDraftRecovery({
    key: readOnly || document instanceof FileDocumentClient ? null : `table:${filePath}`,
    name: filename,
    baseline: recoveryBaseline,
    dirty,
    payload: recoveryPayload,
    onRestore: (recovered) => {
      setTableData(recovered.tableData);
      setFirstRowAsHeader(recovered.firstRowAsHeader);
      setHeaderRowValues(recovered.headerRowValues);
      setDirty(true);
      setSaveState('idle');
    },
    discardTarget: { kind: 'file', filePath },
  });

  const openAsText = useCallback(() => {
    if (sourceFileName || readOnly) {
      openInFocusedPanel('text', filePath, filename, {
        ...(sourceFileName ? { sourceFileName } : {}),
        readOnly,
      });
      return;
    }
    openInFocusedPanel('text', filePath, filename);
  }, [filePath, filename, openInFocusedPanel, readOnly, sourceFileName]);

  const copyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[TabularFileViewerTab] Failed to copy path:', err);
    }
  }, [filePath]);

  const revealInFinder = useCallback(() => {
    void platform().shell.revealItemInDir(filePath);
  }, [filePath]);

  const setFirstRowHeaderMode = useCallback(
    (enabled: boolean) => {
      if (enabled === firstRowAsHeader) return;

      const physicalRows = getPhysicalRows({
        bodyCells: tableModel.cells,
        firstRowAsHeader,
        headerRowValues,
      });
      const totalColumns = Math.max(
        state.status === 'ready' ? state.table.totalColumns : 0,
        ...physicalRows.map((row) => row.length)
      );

      if (enabled) {
        if (physicalRows.length < 2) return;
        const nextHeaderRow = padStringRow(physicalRows[0], totalColumns);
        const nextBodyRows = physicalRows.slice(1).map((row) => padStringRow(row, totalColumns));

        setFirstRowAsHeader(true);
        setHeaderRowValues(nextHeaderRow);
        const nextData = {
          cells: rowsToGridCells(nextBodyRows),
          rows: nextBodyRows.length,
          cols: totalColumns,
          name: filename,
        };
        setTableData(nextData);
        if (document instanceof FileDocumentClient)
          document.changeTable({ ...nextData, columnLabels: nextHeaderRow }, true);
        setSaveError(null);
        return;
      }

      const nextRows = physicalRows.map((row) => padStringRow(row, totalColumns));
      setFirstRowAsHeader(false);
      setHeaderRowValues([]);
      const nextData = {
        cells: rowsToGridCells(nextRows),
        rows: nextRows.length,
        cols: totalColumns,
        name: filename,
      };
      setTableData(nextData);
      if (document instanceof FileDocumentClient) document.changeTable(nextData, false);
      setSaveError(null);
    },
    [document, filename, firstRowAsHeader, headerRowValues, state, tableModel.cells]
  );

  const saveChanges = useCallback(async (): Promise<boolean> => {
    if (readOnly) return true;
    if (state.status !== 'ready' || !delimiterInfo.delimiter || state.table.truncated) return false;

    setSaveState('saving');
    setSaveError(null);
    lastSaveError.current = null;

    try {
      const assertSessionCurrent = isHostedBrowserRuntime()
        ? captureWorkspaceSessionIntent()
        : () => {};
      await document.save(
        async (input) => {
          assertSessionCurrent();
          await platform().fs.writeTextFileAtomic(input);
          assertSessionCurrent();
        },
        () => {
          if (!mounted.current || currentDocument.current !== document)
            throw new Error('That table editor has closed.');
        },
        async () => {
          if (!mounted.current || currentDocument.current !== document) return;
          setBaselineText(document.diskContent!);
          const savedSize = new TextEncoder().encode(document.diskContent!).byteLength;
          setState((current) =>
            current.status === 'ready'
              ? { ...current, sizeBytes: savedSize, previewBytesRead: savedSize }
              : current
          );
          setDirty(document.dirty);
          await flushDraft(
            document.dirty
              ? {
                  baseline: fingerprintText(document.diskContent!),
                  payload: currentRecoveryPayload.current,
                }
              : null
          );
        }
      );
      if (!mounted.current || currentDocument.current !== document) return true;
      setSaveState(document.saving ? 'saving' : document.dirty ? 'idle' : 'saved');
      return true;
    } catch (err) {
      lastSaveError.current = err instanceof Error ? err.message : 'Failed to save table file';
      if (!mounted.current || currentDocument.current !== document) return false;
      setSaveState('error');
      setSaveError(toUserMessage(err, 'failure.failed-to-save-table-file'));
      return false;
    }
  }, [delimiterInfo, document, flushDraft, readOnly, state]);

  useDocumentLifecycle({
    target: { kind: 'file', filePath },
    tabId: canvasTabId,
    isDirty: () => !readOnly && document.dirty,
    save: async () => {
      let success: boolean;
      do {
        success = await saveChanges();
        if (!mounted.current || currentDocument.current !== document) return false;
      } while (success && !readOnly && document.dirty);
      return success;
    },
    discard: () => {
      if (document instanceof FileDocumentClient) document.discard();
      else document.change(document.persistedContent);
    },
  });

  const revertChanges = useCallback(() => {
    if (state.status !== 'ready' || !delimiterInfo.delimiter) return;
    const reparsed = parseTabularPreview(baselineText, {
      delimiter: delimiterInfo.delimiter,
      maxRows: MAX_PREVIEW_ROWS,
    });
    if (!reparsed.ok) return;
    if (document instanceof FileDocumentClient) document.discard();
    else document.change(document.persistedContent);
    setHistoryEpoch((epoch) => epoch + 1);

    const revertedProjection = tabularPreviewToGridProjection(reparsed, firstRowAsHeader);
    setTableData({
      cells: rowsToGridCells(revertedProjection.bodyRows),
      rows: revertedProjection.bodyRows.length,
      cols: revertedProjection.totalColumns,
      name: filename,
    });
    setHeaderRowValues(revertedProjection.headerRowValues);
    setState((prev) =>
      prev.status === 'ready'
        ? {
            ...prev,
            table: reparsed,
            sizeBytes: new TextEncoder().encode(baselineText).byteLength,
            slicedPreview: false,
            previewBytesRead: new TextEncoder().encode(baselineText).byteLength,
          }
        : prev
    );
    setDirty(false);
    setSaveState('idle');
    setSaveError(null);
  }, [baselineText, delimiterInfo, document, filename, firstRowAsHeader, state.status]);

  const updateColumnLabel = useCallback(
    (column: number, label: string) => {
      if (!firstRowAsHeader || state.status !== 'ready' || state.table.truncated) return;

      tableModel.setColumnLabel(column, label);
    },
    [firstRowAsHeader, state, tableModel]
  );

  if (state.status === 'loading') {
    return (
      <div className="h-full flex items-center justify-center bg-bg">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full mx-auto mb-2" />
          <p className="text-sm text-fg-muted">Loading table...</p>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="h-full flex items-center justify-center bg-bg p-4">
        <div className="text-center max-w-md">
          <div className="text-lg font-medium text-fg mb-2">Failed to open table</div>
          <div className="text-sm text-fg-muted">
            {toUserMessage(state.message, 'operation.failed')}
          </div>
          <ActionRow
            copied={copied}
            onCopyPath={copyPath}
            onOpenAsText={openAsText}
            onReveal={revealInFinder}
          />
        </div>
      </div>
    );
  }

  if (state.status === 'fallback') {
    return (
      <div
        data-testid="tabular-file-fallback"
        className="h-full flex items-center justify-center bg-bg p-4"
      >
        <div className="text-center max-w-lg">
          <div className="text-xs font-medium text-fg-muted uppercase mb-2">
            {state.formatLabel} fallback
          </div>
          <div className="text-lg font-medium text-fg mb-2">Open as raw text</div>
          <div className="text-sm text-fg-muted">
            {state.reason}
            {state.sizeBytes !== null ? ` File size: ${formatBytes(state.sizeBytes)}.` : ''}
          </div>
          <ActionRow
            copied={copied}
            onCopyPath={copyPath}
            onOpenAsText={openAsText}
            onReveal={revealInFinder}
          />
        </div>
      </div>
    );
  }

  const { table } = state;
  const visibleRowCount = table.truncated
    ? Math.max(0, table.totalSourceRows - (firstRowAsHeader ? 1 : 0))
    : tableModel.rows;
  const rowLabel = firstRowAsHeader
    ? `${visibleRowCount.toLocaleString()} ${visibleRowCount === 1 ? 'data row' : 'data rows'}`
    : `${visibleRowCount.toLocaleString()} ${visibleRowCount === 1 ? 'row' : 'rows'}`;
  const visibleColumnCount = Math.max(
    table.truncated ? table.totalColumns : 0,
    tableModel.cols,
    headerRowValues.length
  );
  const isEditable = Boolean(delimiterInfo.delimiter) && !table.truncated && !readOnly;
  const canToggleHeaderMode = firstRowAsHeader || tableModel.rows >= 2;
  const columnLabels = firstRowAsHeader ? headerRowValues : undefined;
  const previewDetail = state.slicedPreview
    ? ` · showing first ${tableModel.rows.toLocaleString()} rows from ${formatBytes(
        state.previewBytesRead
      )} of file`
    : table.truncated
      ? ` · showing first ${table.rows.length.toLocaleString()} rows`
      : '';
  const summaryText = state.slicedPreview
    ? `${tableModel.rows.toLocaleString()} preview ${tableModel.rows === 1 ? 'row' : 'rows'} x ${visibleColumnCount.toLocaleString()} cols · ${formatBytes(
        state.sizeBytes
      )}${previewDetail}`
    : `${rowLabel} x ${visibleColumnCount.toLocaleString()} cols · ${formatBytes(
        state.sizeBytes
      )}${previewDetail}`;

  return (
    <div data-testid="tabular-file-viewer" className="h-full flex flex-col bg-bg">
      <div data-testid="tabular-file-toolbar" className="px-3 py-1.5 border-b border-border bg-bg">
        <div
          data-testid="tabular-file-toolbar-primary"
          className="flex min-h-6 items-center justify-between gap-3"
        >
          <div data-testid="tabular-file-title-row" className="flex min-w-0 items-center gap-2">
            <span className="font-medium text-sm text-fg truncate" title={filePath}>
              {filename}
            </span>
            <span className="text-xs text-fg-muted uppercase">{state.formatLabel}</span>
            {!isEditable && <span className="text-xs text-fg-muted">preview only</span>}
            {dirty && <span className="text-xs text-accent">unsaved</span>}
            {saveState === 'saved' && !dirty && (
              <span className="text-xs text-fg-muted">saved</span>
            )}
          </div>
          <div
            data-testid="tabular-file-actions"
            className="flex h-6 flex-shrink-0 items-center gap-1"
          >
            {isEditable && (
              <>
                <button
                  type="button"
                  onClick={saveChanges}
                  disabled={!dirty || saveState === 'saving'}
                  className={TABULAR_TOOLBAR_BUTTON_CLASS}
                  title="Save cell values back to this CSV/TSV file"
                >
                  {saveState === 'saving' ? 'Saving' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={revertChanges}
                  disabled={!dirty || saveState === 'saving'}
                  className={TABULAR_TOOLBAR_BUTTON_CLASS}
                >
                  Revert
                </button>
              </>
            )}
            <button type="button" onClick={openAsText} className={TABULAR_TOOLBAR_BUTTON_CLASS}>
              Open as text
            </button>
            <button
              type="button"
              onClick={copyPath}
              className={TABULAR_TOOLBAR_BUTTON_CLASS}
              title={filePath}
            >
              {copied ? 'Copied' : 'Copy Path'}
            </button>
          </div>
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
          <span>
            {summaryText}
            {saveState === 'error' && saveError
              ? toUserMessage(saveError, 'document.saveFailed')
              : ''}
          </span>
          <span className="flex items-center gap-1.5 flex-shrink-0">
            <span>First row labels</span>
            <button
              type="button"
              role="switch"
              aria-checked={firstRowAsHeader}
              aria-label="Show first row as column labels"
              data-testid="tabular-first-row-labels-toggle"
              disabled={!canToggleHeaderMode}
              onClick={() => setFirstRowHeaderMode(!firstRowAsHeader)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-40 ${
                firstRowAsHeader
                  ? 'border-accent bg-accent'
                  : 'border-border bg-bg-muted hover:bg-bg-subtle'
              }`}
              title={
                canToggleHeaderMode
                  ? 'Show or hide the first file row as column labels'
                  : 'At least two rows are needed to show the first row as labels'
              }
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                  firstRowAsHeader ? 'translate-x-[18px]' : 'translate-x-[2px]'
                }`}
              />
            </button>
          </span>
        </div>
      </div>

      <div data-testid="tabular-file-grid" className="flex-1 min-h-0 overflow-auto bg-bg">
        <TableGrid
          displayCells={tableModel.displayCells}
          cells={tableModel.cells}
          visibleRowIndices={tableModel.visibleRowIndices}
          sort={tableModel.sort}
          filters={tableModel.filters}
          onCellChange={tableModel.updateCell}
          onExpandAndSetCell={tableModel.expandAndSetCell}
          onFillRange={tableModel.fillRange}
          onDeleteRange={tableModel.deleteRange}
          onCopyCells={tableModel.copyCells}
          onCutCells={tableModel.cutCells}
          onPasteCells={tableModel.pasteCells}
          cutRange={tableModel.cutRange}
          onClearCut={tableModel.clearCut}
          onSort={tableModel.setSort}
          onFilter={tableModel.setFilter}
          onPaste={tableModel.importCSV}
          onUndo={tableModel.undo}
          onRedo={tableModel.redo}
          columnWidths={tableModel.columnWidths}
          columnLabels={columnLabels}
          showColumnLabels={firstRowAsHeader}
          onColumnLabelChange={isEditable ? updateColumnLabel : undefined}
          onColumnResize={isEditable ? tableModel.setColumnWidth : undefined}
          readOnly={!isEditable}
          showFormulaBar={false}
          showGhostRows={isEditable}
          showGhostCols={isEditable}
        />
      </div>
    </div>
  );
}

function tabularPreviewToGridProjection(
  table: TabularPreview,
  firstRowAsHeader: boolean
): {
  headerRowValues: string[];
  bodyRows: string[][];
  totalColumns: number;
} {
  if (!firstRowAsHeader) {
    return {
      headerRowValues: [],
      bodyRows: table.sourceRows,
      totalColumns: table.totalColumns,
    };
  }

  const headerRowValues =
    table.sourceRows[0] ??
    Array.from({ length: table.totalColumns }, (_, index) => columnLabel(index));

  return {
    headerRowValues: padStringRow(headerRowValues, table.totalColumns),
    bodyRows: table.sourceRows.slice(1),
    totalColumns: table.totalColumns,
  };
}

function rowsToGridCells(rows: string[][]): Cell[][] {
  return rows.map((row) =>
    row.map((value) => ({
      value,
      type: 'text' as const,
    }))
  );
}

function getPhysicalRows({
  bodyCells,
  firstRowAsHeader,
  headerRowValues,
}: {
  bodyCells: Cell[][];
  firstRowAsHeader: boolean;
  headerRowValues: string[];
}): string[][] {
  const bodyRows = bodyCells.map((row) => row.map((cell) => cell.value));
  return firstRowAsHeader ? [headerRowValues, ...bodyRows] : bodyRows;
}

function padStringRow(row: string[], totalColumns: number): string[] {
  if (row.length >= totalColumns) return row;
  return [...row, ...Array.from({ length: totalColumns - row.length }, () => '')];
}

function columnLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function delimiterForPath(path: string): {
  delimiter: TabularDelimiter | null;
  label: string;
  isXlsx?: boolean;
} {
  const ext = getExtension(path);
  if (ext === 'csv') return { delimiter: ',', label: 'CSV' };
  if (ext === 'tsv') return { delimiter: '\t', label: 'TSV' };

  if (ext === 'xlsx' || ext === 'xls') return { delimiter: null, label: 'Excel', isXlsx: true };
  return { delimiter: null, label: (ext ?? 'table').toUpperCase() };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}

function ActionRow({
  copied,
  onCopyPath,
  onOpenAsText,
  onReveal,
}: {
  copied: boolean;
  onCopyPath: () => void;
  onOpenAsText: () => void;
  onReveal: () => void;
}) {
  return (
    <div className="mt-4 flex items-center justify-center gap-2">
      <button
        type="button"
        onClick={onOpenAsText}
        className="px-3 py-1.5 text-sm bg-accent text-white hover:bg-accent/90 rounded transition-colors"
      >
        Open as text
      </button>
      <button
        type="button"
        onClick={onCopyPath}
        className="px-3 py-1.5 text-sm bg-bg-muted hover:bg-bg-subtle rounded transition-colors"
      >
        {copied ? 'Copied' : 'Copy Path'}
      </button>
      <button
        type="button"
        onClick={onReveal}
        className="px-3 py-1.5 text-sm bg-bg-muted hover:bg-bg-subtle rounded transition-colors"
      >
        Reveal
      </button>
    </div>
  );
}

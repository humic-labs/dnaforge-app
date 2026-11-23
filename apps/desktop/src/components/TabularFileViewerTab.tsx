import { reportSaveFailure } from '../lib/report-save-failure';
import { INTERACTION_CLASS } from '@waypoint/ui-components';
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
import type { FileDocumentSnapshot } from '../shared/file-document';
import { getFilename } from '../utils/fileTypes';
import { resolveFilePathWithFallback } from '../hooks/resolveFilePath';
import { isMissingFileError } from '../features/canvas/oversize-scan';
import {
  parseTabularPreview,
  serializeDelimitedRows,
  type TabularPreview,
} from './tabularFileParser';
import {
  delimiterForPath,
  MAX_PREVIEW_ROWS,
  readDelimitedTablePreview,
  readWorkbookPreview,
} from '../features/document-opening/tabular-file-read';
import { useInitialLiteralOpenSnapshot } from '../features/document-opening/literal-open-snapshot';
import {
  beginReadableContentOwner,
  commitReadableContent,
  failReadableContent,
  type ReadableContentOwner,
} from '../lib/readable-content-telemetry';
import { fingerprintText, useUnsavedDraftRecovery } from '../shared/unsaved-draft-recovery';
import {
  FileDocumentDraft,
  saveCurrentFileEdits,
} from '../features/workspace/public/file-document-draft';
import {
  FileDocumentClient,
  getFileDocumentClient,
} from '../features/workspace/public/file-document-client';
import { isBrowserOnly } from '../utils/environment';

const EMPTY_TABLE_DATA: TableData = { cells: [] };
const TABULAR_TOOLBAR_BUTTON_CLASS = `${INTERACTION_CLASS} h-6 px-2 rounded-[5px] border border-border/60 bg-bg text-[11px] font-medium text-fg-muted leading-none`;

type LoadState = (
  | { status: 'loading' }
  | {
      status: 'ready';
      table: TabularPreview;
      sizeBytes: number;
      formatLabel: string;
      slicedPreview: boolean;
      previewBytesRead: number;
      snapshotOnly?: boolean;
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
  const readInitialSnapshot = useInitialLiteralOpenSnapshot(filePath, 'table');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const snapshotOnly = state.status === 'ready' && state.snapshotOnly === true;
  const viewReadOnly = readOnly || snapshotOnly;
  const ignoreNativeUpdates = useRef(false);
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
      if (ignoreNativeUpdates.current) return;
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
      if (viewReadOnly) return;
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
    [document, tableData, firstRowAsHeader, headerRowValues, viewReadOnly]
  );
  const tableModel = useTableData({
    data: { ...tableData, columnLabels: firstRowAsHeader ? headerRowValues : undefined },
    onUpdateAttrs: handleTableDataUpdate,
    historyEpoch,
    externalHistory:
      document instanceof FileDocumentClient && !snapshotOnly
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
      document instanceof FileDocumentClient && !snapshotOnly
        ? ({ sort, filters }) => {
            setTableData((previous) => ({ ...previous, sort: sort ?? undefined, filters }));
            document.changeTableView(sort, filters);
          }
        : undefined,
  });

  useLayoutEffect(() => {
    if (
      state.status !== 'ready' ||
      !delimiterInfo.delimiter ||
      state.table.truncated ||
      snapshotOnly
    )
      return;
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
    snapshotOnly,
    tableModel.cells,
    baselineText,
  ]);

  useEffect(() => {
    let cancelled = false;
    const readableOwner = beginReadableContentOwner({ tabId: canvasTabId, contentKey: filePath });
    ignoreNativeUpdates.current = false;
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
        const opening = readInitialSnapshot();
        if (delimiterInfo.isXlsx) {
          const resolvedXlsx = resolveFilePathWithFallback(filePath);
          const preview = await (opening?.format === 'workbook'
            ? opening.preview
            : readWorkbookPreview(resolvedXlsx, () => !cancelled));
          if (!preview || cancelled) return;
          const { parsed: parsedXlsx, size } = preview;
          if (!parsedXlsx.ok) {
            setTableData(EMPTY_TABLE_DATA);
            setState({
              status: 'fallback',
              readableOwner,
              reason: `${formatLabel} could not be read: ${parsedXlsx.error}`,
              sizeBytes: size,
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
            sizeBytes: size,
            formatLabel,
            slicedPreview: parsedXlsx.truncated,
            previewBytesRead: size,
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
        const admitted =
          opening?.format === 'delimited' && opening.delimiter === delimiterInfo.delimiter;
        const preview = await (admitted
          ? opening.preview
          : readDelimitedTablePreview(resolved, delimiterInfo.delimiter, () => !cancelled));
        if (!preview || cancelled) return;
        const { parsed, size, slicedPreview, text, bytesRead } = preview;

        if (!parsed.ok) {
          setTableData(EMPTY_TABLE_DATA);
          setState({
            status: 'fallback',
            readableOwner,
            reason: `${formatLabel} could not be parsed as a ${formatLabel} table: ${parsed.error}`,
            sizeBytes: size,
            formatLabel,
          });
          return;
        }

        const initialProjection = tabularPreviewToGridProjection(parsed, parsed.hasHeader);
        let nativeSnapshot: FileDocumentSnapshot | null = null;
        let isolatedPreview = false;
        if (document instanceof FileDocumentClient) {
          let nativeLoadSucceeded = false;
          try {
            await document.load();
            nativeLoadSucceeded = true;
          } catch (error) {
            if (!admitted) throw error;
          }
          if (cancelled || currentDocument.current !== document) return;
          const native = document.snapshot;
          const hasDraft = document.dirty || native?.dirty || Boolean(native?.recoveryId);
          // A native draft still owns its edits. A different clean source cannot own this preview.
          isolatedPreview =
            admitted && !hasDraft && (!nativeLoadSucceeded || document.diskContent !== text);
          ignoreNativeUpdates.current = isolatedPreview;
          if (!isolatedPreview) nativeSnapshot = native;
        } else
          document.load(
            serializeDelimitedRows(parsed.sourceRows, delimiterInfo.delimiter, text),
            text
          );
        if (cancelled || currentDocument.current !== document) return;
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
        setBaselineText(isolatedPreview ? text : (document.diskContent ?? text));
        setDirty(!isolatedPreview && document.dirty);
        setState({
          status: 'ready',
          readableOwner,
          table: parsed,
          sizeBytes: size,
          formatLabel,
          slicedPreview,
          previewBytesRead: bytesRead,
          snapshotOnly: isolatedPreview,
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
  }, [
    canvasTabId,
    delimiterInfo,
    document,
    filePath,
    filename,
    readInitialSnapshot,
    updateTabByEntityId,
  ]);

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
    if (viewReadOnly) return true;
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
      reportSaveFailure(
        '[TabularFileViewerTab] Save failed:',
        {
          filePath,
          tabId: canvasTabId,
          ...(document instanceof FileDocumentClient
            ? { documentId: document.snapshot?.documentId }
            : {}),
        },
        err
      );
      lastSaveError.current = err instanceof Error ? err.message : 'Failed to save table file';
      if (!mounted.current || currentDocument.current !== document) return false;
      setSaveState('error');
      setSaveError(toUserMessage(err, 'failure.failed-to-save-table-file'));
      return false;
    }
  }, [canvasTabId, delimiterInfo, document, filePath, flushDraft, viewReadOnly, state]);

  useDocumentLifecycle({
    target: { kind: 'file', filePath },
    tabId: canvasTabId,
    readRevision: () => document.revision,
    isDirty: () => !viewReadOnly && document.dirty,
    save: () =>
      viewReadOnly
        ? Promise.resolve(true)
        : saveCurrentFileEdits(
            document,
            saveChanges,
            () => mounted.current && currentDocument.current === document
          ),
    discard: () => {
      if (snapshotOnly) return;
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
  const isEditable = Boolean(delimiterInfo.delimiter) && !table.truncated && !viewReadOnly;
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
                  data-interaction-border="true"
                  title="Save cell values back to this CSV/TSV file"
                >
                  {saveState === 'saving' ? 'Saving' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={revertChanges}
                  disabled={!dirty || saveState === 'saving'}
                  className={TABULAR_TOOLBAR_BUTTON_CLASS}
                  data-interaction-border="true"
                >
                  Revert
                </button>
              </>
            )}
            <button
              type="button"
              onClick={openAsText}
              className={TABULAR_TOOLBAR_BUTTON_CLASS}
              data-interaction-border="true"
            >
              Open as text
            </button>
            <button
              type="button"
              onClick={copyPath}
              className={TABULAR_TOOLBAR_BUTTON_CLASS}
              data-interaction-border="true"
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
              className={`${firstRowAsHeader ? '' : INTERACTION_CLASS} relative inline-flex h-5 w-9 items-center rounded-full border transition-colors disabled:opacity-40 ${
                firstRowAsHeader ? 'border-accent bg-accent' : 'border-border bg-bg-muted '
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
        className={`${INTERACTION_CLASS} px-3 py-1.5 text-sm bg-bg-muted rounded transition-colors`}
      >
        {copied ? 'Copied' : 'Copy Path'}
      </button>
      <button
        type="button"
        onClick={onReveal}
        className={`${INTERACTION_CLASS} px-3 py-1.5 text-sm bg-bg-muted rounded transition-colors`}
      >
        Reveal
      </button>
    </div>
  );
}

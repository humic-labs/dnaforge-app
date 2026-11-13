import { useMemo, useReducer, useRef } from 'react';
import { createTableDataMemory, tableDataModel } from '../table-data-model';
import type { ColumnSort, SelectionRange, TableData } from '../types';
import type {
  TableOperationObservation,
  TableSurface,
} from '../../../../../shared/table-notebook-observation';
import {
  captureAnalyticsOptionalOrigin,
  isAnalyticsCaptureReady,
} from '../../../../../lib/analytics';
import { downloadCSV, parseHTMLTable } from '../utils/csv';

interface UseTableDataProps {
  data: TableData;
  onUpdateAttrs?: (attrs: Record<string, unknown>, observation?: TableOperationObservation) => void;
  observationSurface?: TableSurface;
  historyEpoch?: unknown;
  externalView?: { sort: ColumnSort | null; filters: Record<number, string> };
  externalHistory?: {
    undo(): SelectionRange | null;
    redo(): SelectionRange | null;
    canUndo: boolean;
    canRedo: boolean;
  };
  onViewChange?: (view: { sort: ColumnSort | null; filters: Record<number, string> }) => void;
}
export function useTableData({
  data,
  onUpdateAttrs,
  observationSurface,
  historyEpoch,
  externalHistory,
  externalView,
  onViewChange,
}: UseTableDataProps) {
  const memory = useRef(createTableDataMemory(data, historyEpoch));
  if (externalView) {
    memory.current.sort = externalView.sort;
    memory.current.filters = externalView.filters;
  }
  const [epoch, changed] = useReducer((value: number) => value + 1, 0);
  const model = useMemo(
    () =>
      tableDataModel({
        data,
        onUpdateAttrs,
        observationSurface,
        historyEpoch,
        memory: memory.current,
        changed: () => {
          changed();
          onViewChange?.({ sort: memory.current.sort, filters: memory.current.filters });
        },
        canObserve: () => isAnalyticsCaptureReady() && Boolean(captureAnalyticsOptionalOrigin()),
        browserActions: {
          download: (cells, filename) => downloadCSV(cells, filename),
          parseHTML: (html) => parseHTMLTable(html),
          copy: async (text) => {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable');
            await navigator.clipboard.writeText(text);
          },
        },
      }),
    [data, onUpdateAttrs, observationSurface, historyEpoch, epoch, onViewChange, externalView]
  );
  return externalHistory ? { ...model, ...externalHistory } : model;
}

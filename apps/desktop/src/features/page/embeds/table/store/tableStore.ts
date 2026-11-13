import { create } from 'zustand';
import type { TableData } from '../types';
import { mergeTableDataPatch } from '../utils/merge-table-data';
import type { TableOperationObservation } from '../../../../../shared/table-notebook-observation';

interface ExpandedTable {
  id: string;
  data: TableData;
  label: string;

  sourcePageId?: string;

  referenceWorkspaceRoot?: string;
  onUpdate?: (data: TableData, observation?: TableOperationObservation) => void;
  sourceGeneration?: number;
}

interface TableStoreState {
  expandedTables: Record<string, ExpandedTable>;
}

interface TableStoreActions {
  registerTable: (
    id: string,
    data: TableData,
    label: string,
    options?: {
      sourcePageId?: string;
      referenceWorkspaceRoot?: string;
      onUpdate?: (data: TableData, observation?: TableOperationObservation) => void;
    }
  ) => void;

  unregisterTable: (id: string) => void;
  unbindSource: (id: string, onUpdate: NonNullable<ExpandedTable['onUpdate']>) => void;

  updateTableData: (
    id: string,
    data: TableData | Record<string, unknown>,
    observation?: TableOperationObservation
  ) => void;

  getTable: (id: string) => ExpandedTable | undefined;
}

export const useTableStore = create<TableStoreState & TableStoreActions>((set, get) => ({
  expandedTables: {},

  registerTable: (id, data, label, options) => {
    set((state) => ({
      expandedTables: {
        ...state.expandedTables,
        [id]: {
          id,
          data,
          label,
          sourcePageId: options?.sourcePageId,
          referenceWorkspaceRoot: options?.referenceWorkspaceRoot,
          onUpdate: options?.onUpdate,
          sourceGeneration:
            (state.expandedTables[id]?.sourceGeneration ?? 0) +
            (options?.onUpdate &&
            (options.onUpdate !== state.expandedTables[id]?.onUpdate ||
              options.sourcePageId !== state.expandedTables[id]?.sourcePageId ||
              options.referenceWorkspaceRoot !== state.expandedTables[id]?.referenceWorkspaceRoot)
              ? 1
              : 0),
        },
      },
    }));
  },

  unregisterTable: (id) => {
    set((state) => {
      const { [id]: _, ...rest } = state.expandedTables;
      return { expandedTables: rest };
    });
  },

  unbindSource: (id, onUpdate) => {
    const table = get().expandedTables[id];
    if (!table || table.onUpdate !== onUpdate) return;
    set((state) => ({
      expandedTables: { ...state.expandedTables, [id]: { ...table, onUpdate: undefined } },
    }));
  },

  updateTableData: (id, patch, observation) => {
    const table = get().expandedTables[id];
    if (!table) return;
    if (!table.onUpdate) throw new Error('Reopen the source notebook before editing this table.');

    const data = mergeTableDataPatch(table.data, patch as Record<string, unknown>);
    const acceptance: unknown = observation
      ? table.onUpdate(data, observation)
      : table.onUpdate(data);
    if (
      acceptance !== null &&
      (typeof acceptance === 'object' || typeof acceptance === 'function') &&
      'then' in acceptance &&
      typeof acceptance.then === 'function'
    ) {
      get().unbindSource(id, table.onUpdate);
      void Promise.resolve(acceptance).catch(() => undefined);
      throw new Error(
        'Table edits require synchronous source acceptance. Reopen the source notebook.'
      );
    }
    if (get().expandedTables[id] !== table) {
      throw new Error(
        'The table source changed during this edit. Retry against the current source.'
      );
    }

    set((state) => ({
      expandedTables: {
        ...state.expandedTables,
        [id]: { ...table, data },
      },
    }));
  },

  getTable: (id) => {
    return get().expandedTables[id];
  },
}));

import { toUserMessage } from '@waypoint/user-messages';
import { canonicalNotebookJson } from '../../../db/notebook-markdown-codec';
import { useToastStore } from '../../../stores/toast-store';
import { useCallback, useSyncExternalStore } from 'react';
import { isElectron } from '../../../utils/environment';
import { getNativeNotebookDocumentClient } from '../notebook-document-client';
import type { ColumnSort, TableData } from '../embeds/table/types';

export function useNativeNotebookTable(
  pageId: string | undefined,
  tableId: string,
  data: TableData
) {
  const client = pageId && isElectron() ? getNativeNotebookDocumentClient(pageId) : null;
  useSyncExternalStore(
    client?.subscribe ?? (() => () => {}),
    () => client?.snapshot?.revision ?? 'browser',
    () => client?.snapshot?.revision ?? 'browser'
  );
  const onViewChange = useCallback(
    (view: { sort: ColumnSort | null; filters: Record<number, string> }) => {
      const previous = client?.snapshot?.tableViews?.[tableId] ?? {
        sort: data.sort ?? null,
        filters: data.filters ?? {},
      };
      if (client?.ready && canonicalNotebookJson(previous) !== canonicalNotebookJson(view))
        void client.command({ kind: 'table-view', tableId, ...view }).catch((error) =>
          useToastStore
            .getState()
            .addToast(toUserMessage(error, 'failure.the-notebook-table-view-could-not-update'), {
              definition: 'native-notebook-table-view-failed',
            })
        );
    },
    [client, tableId, data.sort, data.filters]
  );
  if (!client?.ready) return {};
  return {
    externalHistory: {
      undo: () => {
        client.history('undo');
        return null;
      },
      redo: () => {
        client.history('redo');
        return null;
      },
      canUndo: Boolean(client.snapshot?.canUndo),
      canRedo: Boolean(client.snapshot?.canRedo),
    },
    externalView: client.snapshot?.tableViews?.[tableId] ?? {
      sort: data.sort ?? null,
      filters: data.filters ?? {},
    },
    onViewChange,
  };
}

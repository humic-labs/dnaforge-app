import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { isElectron } from '../../../utils/environment';
import { getNativeNotebookDocumentClient } from '../notebook-document-client';
import {
  notebookTableData,
  tableDocumentKey,
  type TableDocumentReference,
} from '../../../shared/table-document-reference';
import type { TableData } from '../../../shared/table-document-types';

const noSubscribe = () => () => {};
export function useNativeNotebookTableDocument(reference: TableDocumentReference | null) {
  const documentId =
    reference?.backing.kind === 'notebook-inline'
      ? reference.backing.notebookDocumentId
      : undefined;
  const client = useMemo(
    () => (isElectron() && documentId ? getNativeNotebookDocumentClient(documentId) : null),
    [documentId]
  );
  useSyncExternalStore(
    client?.subscribe ?? noSubscribe,
    () => client?.viewRevision ?? 'unavailable',
    () => 'unavailable'
  );
  useEffect(() => {
    if (client) void client.initialize().catch(() => {});
  }, [client]);
  let data: TableData | null = null;
  let error = client?.error ?? null;
  if (reference) {
    try {
      tableDocumentKey(reference);
      if (reference.binding.kind !== 'current')
        throw new Error(
          'Saved table versions cannot be opened by this version. The reference is preserved.'
        );
      if (reference.backing.kind !== 'notebook-inline')
        throw new Error(
          'This table backing is not supported by this version. The reference is preserved.'
        );
      if (client?.content) data = notebookTableData(client.content, reference.backing.blockId);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  return {
    client,
    data,
    error,
    loading: Boolean(reference && client && !client.ready && !error),
    writable: Boolean(
      client?.ready && data && !client.snapshot?.readOnly && !client.snapshot?.recovery && !error
    ),
  };
}

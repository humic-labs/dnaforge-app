import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { platform } from '../../../platform';
import { isElectron } from '../../../utils/environment';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import { isForgePackageMetaPath } from '../../../shared/forge-package-path';
import { parseTablePackageHead } from '../../../shared/table-package';
import {
  richTableReference,
  tableDocumentKey,
  type TableDocumentReference,
} from '../../../shared/table-document-reference';
import type { ResolvedTableDocument } from '../../../shared/table-document-command';
import type { ColumnSort, TableData } from '../../../shared/table-document-types';
import { getFileDocumentClient } from '../../workspace/public/file-document-client';

export function useNativeRichTableDocument(reference: TableDocumentReference | null, path: string) {
  const folders = useWorkspaceStore((state) => state.folders);
  const filePath = !reference && isForgePackageMetaPath(path, 'table.json') ? path : null;
  const workspaceRoot = filePath ? findWorkspaceRootForPath(folders, filePath) : null;
  const active = isElectron() && Boolean(filePath || reference?.backing.kind === 'rich-file');
  const key = reference?.backing.kind === 'rich-file' ? tableDocumentKey(reference) : filePath;
  const [resolved, setResolved] = useState<ResolvedTableDocument | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setResolved(null);
    setFailure(null);
    if (!active) return;
    setLoading(true);
    const request =
      reference?.backing.kind === 'rich-file'
        ? platform().fs.tableDocument({ kind: 'resolve', reference })
        : workspaceRoot && filePath
          ? platform().fs.tableDocument({
              kind: 'open',
              location: {
                workspaceRoot,
                packageRoot: filePath.replace(/[\\/]\.forge[\\/]table\.json$/i, ''),
              },
            })
          : Promise.reject(new Error('Open this table from its registered project.'));
    void request
      .then((result) => {
        if (result.kind !== 'resolved')
          throw new Error('The native table owner did not resolve this table.');
        if (current) {
          const table = result.table;
          setResolved(
            table.owner.kind === 'file' && table.reference.backing.kind === 'rich-file'
              ? {
                  ...table,
                  reference: richTableReference(
                    table.reference.backing.projectId,
                    table.tableId,
                    table.reference.binding,
                    { fileDocumentId: table.owner.documentId, pathHint: table.owner.path }
                  ),
                }
              : table
          );
        }
      })
      .catch((error) => {
        if (current) setFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [active, key, reference, workspaceRoot, filePath]);
  const client = useMemo(
    () => (resolved?.owner.kind === 'file' ? getFileDocumentClient(resolved.owner.path) : null),
    [resolved]
  );
  const subscribe = useCallback(
    (listener: () => void) => client?.subscribe(listener) ?? (() => {}),
    [client]
  );
  useSyncExternalStore(
    subscribe,
    () => client?.viewRevision ?? 0,
    () => 0
  );
  useEffect(() => {
    let current = true;
    if (client)
      void client.load().catch((error) => {
        if (current) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      current = false;
    };
  }, [client]);
  const projection = useMemo(() => {
    if (resolved?.owner.kind === 'saved-version')
      return {
        data: resolved.owner.snapshot.data,
        title: resolved.owner.snapshot.title,
        error: null,
      };
    if (!client?.content) return { data: null, title: null, error: null };
    try {
      const head = parseTablePackageHead(client.content);
      if (head.id !== resolved?.tableId || head.status !== 'active')
        throw new Error('The table identity is unavailable or awaiting migration recovery.');
      return { data: head.snapshot.data, title: head.snapshot.title, error: null };
    } catch (error) {
      return {
        data: null,
        title: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [resolved, client?.content]);
  const synchronized = !client?.error || client.content === client.snapshot?.content;
  const writable = Boolean(
    active &&
    resolved &&
    !resolved.readOnly &&
    client?.snapshot?.ready &&
    !client.snapshot.readOnly &&
    !client.snapshot.recoveryId &&
    projection.data &&
    synchronized &&
    !failure &&
    !projection.error
  );
  const update = useCallback(
    (attrs: Record<string, unknown>) => {
      if (!writable || !client) throw new Error('This native table is not available for editing.');
      const head = parseTablePackageHead(client.content ?? '');
      client.changeTable({ ...head.snapshot.data, ...attrs } as TableData, false);
    },
    [client, writable]
  );
  const onViewChange = useCallback(
    (view: { sort: ColumnSort | null; filters: Record<number, string> }) => {
      if (client?.snapshot?.ready) client.changeTableView(view.sort, view.filters);
    },
    [client]
  );
  const controls = client?.snapshot?.ready
    ? {
        externalHistory: {
          undo: () => {
            void client.execute({ kind: 'undo' }).catch(() => {});
            return null;
          },
          redo: () => {
            void client.execute({ kind: 'redo' }).catch(() => {});
            return null;
          },
          canUndo: Boolean(client.snapshot.canUndo),
          canRedo: Boolean(client.snapshot.canRedo),
        },
        externalView: {
          sort: (client.snapshot.table?.sort ?? null) as ColumnSort | null,
          filters: (client.snapshot.table?.filters ?? {}) as Record<number, string>,
        },
        onViewChange,
      }
    : {};
  return {
    active,
    resolved,
    client,
    data: projection.data,
    title: projection.title,
    update,
    controls,
    writable,
    loading:
      loading ||
      Boolean(active && resolved?.owner.kind === 'file' && !client?.snapshot && !failure),
    error:
      failure ??
      projection.error ??
      client?.error ??
      (client?.snapshot && !client.snapshot.ready
        ? (client.snapshot.reason ?? 'The table is unavailable.')
        : null),
  };
}

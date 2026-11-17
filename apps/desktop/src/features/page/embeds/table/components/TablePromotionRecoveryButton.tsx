import { useEffect, useMemo, useState } from 'react';
import { platform } from '../../../../../platform';
import { reportSaveFailure } from '../../../../../lib/report-save-failure';
import { findWorkspaceRootForPath } from '../../../../../db/workspace-catalog';
import { useWorkspaceStore } from '../../../../../stores/workspaceStore';
import { stripWorkspaceScope } from '../../../../../shared/workspace-scoped-identity';
import {
  tableDocumentKey,
  type TableDocumentReference,
} from '../../../../../shared/table-document-reference';
import { getNativeNotebookDocumentClient } from '../../../notebook-document-client';

interface PendingPromotion {
  promotionId: string;
  tableId: string;
  sourceReference: TableDocumentReference;
  sourcePath: string;
  destinationPath: string;
  title: string;
  state: 'pending' | 'blocked';
  reason?: string;
  workspaceRoot: string;
}

export function TablePromotionRecoveryButton({
  reference,
  workspaceRoot,
  onRecovered,
}: {
  reference: TableDocumentReference;
  workspaceRoot?: string | null;
  onRecovered?: (reference: TableDocumentReference) => void;
}) {
  const folders = useWorkspaceStore((state) => state.folders);
  const key = tableDocumentKey(reference);
  const roots = useMemo(() => {
    if (workspaceRoot) return [workspaceRoot];
    const hint = reference.backing.kind === 'rich-file' ? reference.backing.pathHint : undefined;
    const hintedRoot = hint ? findWorkspaceRootForPath(folders, hint) : null;
    return hintedRoot ? [hintedRoot] : [...new Set(folders.map((folder) => folder.path))];
  }, [workspaceRoot, reference, folders]);
  const [pending, setPending] = useState<PendingPromotion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setPending([]);
    setError(null);
    void Promise.all(
      roots.map(async (root) => {
        const result = await platform().fs.tableDocument({
          kind: 'list-promotions',
          workspaceRoot: root,
        });
        if (result.kind !== 'promotions')
          throw new Error('Table recovery discovery did not return its saved transitions.');
        return result.promotions
          .filter((item) => {
            if (reference.backing.kind === 'rich-file')
              return item.tableId === reference.backing.tableId;
            const source = item.sourceReference.backing;
            return (
              reference.backing.kind === 'notebook-inline' &&
              source.kind === 'notebook-inline' &&
              source.blockId === reference.backing.blockId &&
              stripWorkspaceScope(source.notebookDocumentId) ===
                stripWorkspaceScope(reference.backing.notebookDocumentId)
            );
          })
          .map((item) => ({ ...item, workspaceRoot: root }));
      })
    )
      .then((groups) => {
        if (active) setPending(groups.flat());
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
        reportSaveFailure(
          '[Table] Saved table recovery could not be checked:',
          { tableId: reference.documentId },
          failure
        );
      });
    return () => {
      active = false;
    };
  }, [key, roots, reference]);
  const recover = async (item: PendingPromotion) => {
    if (busy) return;
    setBusy(item.promotionId);
    setError(null);
    try {
      const result = await platform().fs.tableDocument({
        kind: 'recover-promotion',
        requestId: crypto.randomUUID(),
        workspaceRoot: item.workspaceRoot,
        promotionId: item.promotionId,
      });
      if (result.kind !== 'promoted')
        throw new Error(
          result.kind === 'promotion-pending'
            ? result.reason
            : 'The saved table transition is still awaiting recovery.'
        );
      if (reference.backing.kind === 'notebook-inline') {
        const client = getNativeNotebookDocumentClient(reference.backing.notebookDocumentId);
        await client.initialize();
        await client.command({ kind: 'inspect-copy' });
      }
      onRecovered?.(result.table.reference);
      setPending((current) =>
        current.filter((candidate) => candidate.promotionId !== item.promotionId)
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      reportSaveFailure(
        '[Table] Saved table recovery failed:',
        {
          tableId: item.tableId,
          promotionId: item.promotionId,
        },
        failure
      );
    } finally {
      setBusy(null);
    }
  };
  if (!pending.length && !error) return null;
  return (
    <div className="space-y-2 rounded border border-border bg-bg-subtle p-2 text-xs">
      {pending.map((item) => (
        <div
          key={`${item.workspaceRoot}:${item.promotionId}`}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="min-w-0 flex-1 text-fg-muted">
            {item.reason ?? 'Saving this table was interrupted. The original source is preserved.'}
          </span>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void recover(item)}
            className="rounded border border-border px-2 py-1 text-fg disabled:opacity-50"
          >
            {busy === item.promotionId ? 'Finishing…' : 'Finish saving table'}
          </button>
        </div>
      ))}
      {error && (
        <div>
          <p role="alert" className="text-error">
            The table could not be saved. Your data is preserved.
          </p>
          <details className="mt-2 text-fg-muted">
            <summary className="cursor-pointer">Show details</summary>
            <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
          </details>
        </div>
      )}
    </div>
  );
}

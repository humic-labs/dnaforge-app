import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui';
import { platform } from '../../../platform';
import { useNotebookConflictStore } from '../notebook-conflict-store';
import type {
  NotebookConflictComparison,
  NotebookConflictResolution,
} from '../../../shared/notebook-conflict';
import { toUserMessage, userMessage, type UserMessage } from '@waypoint/user-messages';
import { runWorkspaceReconcileOperation } from '../../../services/workspace-operations';
import { getCatalogWorkspaceRootForFilePath } from '../../../db/workspace-catalog';

export function NotebookConflictDialog() {
  const documentId = useNotebookConflictStore((state) => state.documentId);
  return documentId ? <NotebookConflictChoice key={documentId} documentId={documentId} /> : null;
}
function NotebookConflictChoice({ documentId }: { documentId: string }) {
  const close = useNotebookConflictStore((state) => state.close);
  const [comparison, setComparison] = useState<NotebookConflictComparison>();
  const [resolved, setResolved] = useState<NotebookConflictResolution>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserMessage>();
  useEffect(() => {
    let current = true;
    const inspect = platform().notebook.inspectConflict;
    if (!inspect) {
      setError(userMessage('document.openFailed'));
      return;
    }
    void inspect(documentId).then(
      (value) => {
        if (current) setComparison(value);
      },
      (cause) => {
        if (current) setError(toUserMessage(cause, 'document.openFailed'));
      }
    );
    return () => {
      current = false;
    };
  }, [documentId]);
  const choose = async (choice: 'file' | 'application') => {
    const resolve = platform().notebook.resolveConflict;
    if (!comparison || busy || !resolve) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await resolve({
        documentId,
        token: comparison.token,
        choice,
      });
      setResolved(result);
      const rows = await platform().db.select<Array<{ path: string }>>(
        "SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'",
        [documentId]
      );
      const root = rows[0] ? await getCatalogWorkspaceRootForFilePath(rows[0].path) : null;
      if (root)
        await runWorkspaceReconcileOperation({
          workspaceRoot: root,
          strict: false,
          displayDelivery: 'optional',
          catalogSource: 'working-tree',
          healManagedHead: false,
        });
    } catch (cause) {
      setError(toUserMessage(cause, 'document.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/50">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="notebook-conflict-title"
        data-testid="notebook-conflict-dialog"
        className="mx-4 max-h-[85vh] w-full max-w-5xl overflow-auto rounded-lg border border-border bg-bg p-5 text-fg shadow-xl"
      >
        <h2 id="notebook-conflict-title">
          Compare notebook versions{comparison ? `: ${comparison.title}` : ''}
        </h2>
        {resolved ? (
          <>
            <p>Both original versions have been retained. The selected version is now current.</p>
            <Button onClick={() => void platform().shell.revealItemInDir(resolved.retainedPath)}>
              Show retained versions
            </Button>
          </>
        ) : (
          <>
            <p>
              Compare the file and application versions. Both original versions will be retained
              before your choice is applied.
            </p>
            {comparison ? (
              <div className="my-4 grid grid-cols-2 gap-4">
                <div>
                  <h3>File version</h3>
                  <pre
                    data-testid="notebook-conflict-file"
                    className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border p-3 text-xs"
                  >
                    {comparison.fileText}
                  </pre>
                </div>
                <div>
                  <h3>Application version</h3>
                  <pre
                    data-testid="notebook-conflict-application"
                    className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border p-3 text-xs"
                  >
                    {comparison.applicationText}
                  </pre>
                </div>
              </div>
            ) : (
              <p>Reading both versions…</p>
            )}
            {comparison?.previewsTruncated && (
              <p>This preview is shortened. Both complete versions will be retained.</p>
            )}
            <div className="flex gap-3">
              <Button disabled={!comparison || busy} onClick={() => void choose('file')}>
                Use file version
              </Button>
              <Button disabled={!comparison || busy} onClick={() => void choose('application')}>
                Use application version
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy} onClick={close}>
          {resolved ? 'Done' : 'Cancel'}
        </Button>
      </section>
    </div>
  );
}

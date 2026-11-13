import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceFolder } from '../stores/workspaceStore';
import type { FileTrashEntry } from '../shared/workspace-file-trash';
import {
  listFileTrash,
  mutateFileLifecycle,
} from '../features/workspace/public/file-lifecycle-commands';

type Row = FileTrashEntry & { project: WorkspaceFolder };

export function FileTrash({
  folders,
  onChanged,
}: {
  folders: readonly WorkspaceFolder[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<Record<string, number | null>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const load = useCallback(
    async (warnings: string[] = []) => {
      setBusy('loading');
      const projects = folders.filter((folder) => !folder.pinned);
      const results = await Promise.allSettled(
        projects.map((project) => listFileTrash(project.path))
      );
      const loaded: Row[] = [],
        errors: string[] = [...warnings],
        next: Record<string, number | null> = {};
      results.forEach((result, index) => {
        const project = projects[index];
        if (result.status === 'rejected') {
          errors.push(`${project.name}: ${String(result.reason)}`);
          return;
        }
        loaded.push(...result.value.entries.map((entry) => ({ ...entry, project })));
        next[project.path] = result.value.nextOffset;
        errors.push(...result.value.errors.map((error) => `${project.name}: ${error.error}`));
      });
      setRows(loaded);
      setErrors(errors);
      setNext(next);
      setBusy(null);
    },
    [folders]
  );
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    void load();
    return () => {
      if (element?.open) element.close();
    };
  }, [load, open]);

  const act = async (row: Row, kind: 'restore' | 'purge') => {
    setBusy(row.id);
    setErrors([]);
    try {
      const result = await mutateFileLifecycle({
        kind,
        workspaceRoot: row.project.path,
        entryId: row.id,
        expectedRevision: row.revision,
      });
      if (result) {
        const warnings = 'warnings' in result ? result.warnings : [];
        onChanged();
        await load(warnings);
      }
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid="file-trash-open"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-fg-muted hover:bg-bg-muted hover:text-fg"
      >
        File Trash
      </button>
      {open && (
        <dialog
          ref={dialog}
          aria-label="File Trash"
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          className="fixed inset-0 m-auto w-[min(48rem,90vw)] max-h-[80vh] rounded-lg border border-border bg-bg p-4 text-fg backdrop:bg-black/40"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">File Trash</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-2 py-1 text-xs hover:bg-bg-muted"
            >
              Close
            </button>
          </div>
          {errors.map((error, index) => (
            <p key={index} role="alert" className="mb-2 text-sm text-error">
              {toUserMessage(error, 'operation.failed')}
            </p>
          ))}
          {busy === 'loading' ? (
            <p className="text-sm text-fg-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-fg-muted">No files in Trash.</p>
          ) : (
            <ul className="divide-y divide-border overflow-auto">
              {rows.map((row) => (
                <li
                  key={`${row.project.path}:${row.id}`}
                  data-testid="file-trash-entry"
                  data-trash-entry-id={row.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">{row.originalPath}</div>
                    <div className="text-xs text-fg-muted">
                      {row.project.name} · {new Date(row.trashedAt).toLocaleString()}
                      {row.deletionStarted ? ' · Deletion incomplete' : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-label={`Restore ${row.originalPath}`}
                      onClick={() => void act(row, 'restore')}
                      className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-label={`Delete ${row.originalPath} permanently`}
                      onClick={() => void act(row, 'purge')}
                      className="rounded px-2 py-1 text-xs text-error disabled:opacity-50"
                    >
                      Delete permanently…
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {Object.entries(next)
            .filter(([, offset]) => offset !== null)
            .map(([root, offset]) => (
              <button
                type="button"
                key={root}
                disabled={busy !== null}
                className="mt-2 rounded border border-border px-2 py-1 text-xs"
                onClick={() => {
                  const project = folders.find((folder) => folder.path === root);
                  if (!project || offset === null) return;
                  setBusy('loading-more');
                  void listFileTrash(root, offset)
                    .then((page) => {
                      setRows((rows) => [
                        ...rows,
                        ...page.entries.map((entry) => ({ ...entry, project })),
                      ]);
                      setNext((next) => ({ ...next, [root]: page.nextOffset }));
                      setErrors(page.errors.map((error) => error.error));
                    })
                    .catch((error) => setErrors([String(error)]))
                    .finally(() => setBusy(null));
                }}
              >
                More from {folders.find((folder) => folder.path === root)?.name}
              </button>
            ))}
        </dialog>
      )}
    </>
  );
}

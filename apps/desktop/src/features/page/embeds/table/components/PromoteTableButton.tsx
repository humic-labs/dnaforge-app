import { useRef, useState } from 'react';
import { platform } from '../../../../../platform';
import { reportSaveFailure } from '../../../../../lib/report-save-failure';
import type { TableDocumentReference } from '../../../../../shared/table-document-reference';
import type { TableDocumentCommand } from '../../../../../shared/table-document-command';
import { getNativeNotebookDocumentClient } from '../../../notebook-document-client';
import { TableDocumentDialog } from './TableDocumentDialog';

export function PromoteTableButton({
  reference,
  title,
  onPromoted,
}: {
  reference: TableDocumentReference;
  title: string;
  onPromoted?: (reference: TableDocumentReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title === 'Untitled Table' ? 'Table' : title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<Extract<TableDocumentCommand, { kind: 'promote' }> | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (reference.backing.kind !== 'notebook-inline')
        throw new Error('Choose a notebook-backed table.');
      const trimmed = name.trim();
      if (!trimmed || /[\\/\0<>:"|?*]/.test(trimmed) || trimmed === '.' || trimmed === '..')
        throw new Error('Enter a table name without path separators or reserved characters.');
      const client = getNativeNotebookDocumentClient(reference.backing.notebookDocumentId);
      await client.initialize();
      if (!request.current) {
        await client.flush();
        if (client.dirty && !(await client.save()))
          throw client.lastCommandError ?? new Error('The source notebook could not be saved.');
        const source = await client.command({ kind: 'inspect-copy' });
        if (
          !source.path ||
          !source.workspaceRoot ||
          source.dirty ||
          source.saving ||
          source.readOnly
        )
          throw new Error('Save and resolve the source notebook before extracting its table.');
        const parent = source.path.replace(/[\\/][^\\/]+$/, '');
        if (parent === source.path) throw new Error('The source notebook folder is unavailable.');
        request.current = {
          kind: 'promote',
          requestId: crypto.randomUUID(),
          source: reference,
          expectedRevision: source.revision,
          destination: { workspaceRoot: source.workspaceRoot, packageRoot: `${parent}/${trimmed}` },
        };
      }
      const result = await platform().fs.tableDocument(request.current);
      if (result.kind !== 'promoted')
        throw new Error(
          result.kind === 'promotion-pending'
            ? result.reason
            : 'The table extraction is awaiting recovery.'
        );
      await client.command({ kind: 'inspect-copy' });
      onPromoted?.(result.table.reference);
      request.current = null;
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      reportSaveFailure(
        '[Table] Table extraction failed:',
        { tableId: reference.documentId },
        failure
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Save as table file…
      </button>
      {open && (
        <TableDocumentDialog title="Save as table file" busy={busy} onClose={() => setOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Table name
              <input
                className="rounded border border-border bg-bg px-2 py-1"
                value={name}
                maxLength={200}
                disabled={busy || Boolean(request.current)}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="mt-3 text-xs text-fg-muted">
              The notebook will contain a live reference to the table file. Saving first also saves
              the notebook’s other changes.
            </p>
            {error && (
              <div className="mt-3 text-sm">
                <p role="alert" className="text-error">
                  The table could not be saved. Your data is preserved.
                </p>
                <details className="mt-2 text-fg-muted">
                  <summary className="cursor-pointer">Show details</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words">{error}</p>
                </details>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="rounded border border-border px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save as table file'}
              </button>
            </div>
          </form>
        </TableDocumentDialog>
      )}
    </>
  );
}

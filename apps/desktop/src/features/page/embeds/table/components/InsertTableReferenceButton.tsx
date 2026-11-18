import { MenuNativeSelect } from '@waypoint/ui-components';
import { useMemo, useRef, useState } from 'react';
import { platform } from '../../../../../platform';
import { reportSaveFailure } from '../../../../../lib/report-save-failure';
import type { TableDocumentReference } from '../../../../../shared/table-document-reference';
import type { FileDocumentClient } from '../../../../workspace/public/file-document-client';
import { getNativeNotebookDocumentClient } from '../../../notebook-document-client';
import { usePageStore } from '../../../store';
import { TableDocumentDialog } from './TableDocumentDialog';

export function InsertTableReferenceButton({
  reference,
  client,
  title,
}: {
  reference: TableDocumentReference;
  client: FileDocumentClient | null;
  title: string;
}) {
  const pages = usePageStore((state) => state.pages);
  const pageList = usePageStore((state) => state.pageList);
  const notebooks = useMemo(() => {
    const found = new Map(pageList.map((page) => [page.id, { id: page.id, title: page.title }]));
    for (const page of Object.values(pages)) found.set(page.id, { id: page.id, title: page.title });
    return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [pages, pageList]);
  const [open, setOpen] = useState(false);
  const [notebookId, setNotebookId] = useState('');
  const [binding, setBinding] = useState<'current' | 'saved-version'>('current');
  const [presentation, setPresentation] = useState<'embed' | 'link'>('embed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef('');
  const submit = async () => {
    if (busy || !notebookId) return;
    setBusy(true);
    setError(null);
    try {
      let selected = reference;
      if (binding === 'saved-version' && reference.binding.kind !== 'saved-version') {
        if (!client) throw new Error('Open the current table before saving a version reference.');
        await client.flush();
        const saved = await client.save();
        if (saved.dirty || saved.saving || saved.recoveryId)
          throw new Error('The current table could not acknowledge a saved version.');
        const pinned = await platform().fs.tableDocument({
          kind: 'pin',
          requestId: requestId.current,
          reference,
          expectedRevision: saved.revision,
        });
        if (pinned.kind !== 'pinned') throw new Error('The saved table version is unavailable.');
        selected = pinned.reference;
      }
      const notebook = getNativeNotebookDocumentClient(notebookId);
      await notebook.initialize();
      await notebook.flush();
      const snapshot = await notebook.command({ kind: 'inspect-copy' });
      if (snapshot.readOnly || snapshot.recovery)
        throw new Error('Choose an editable notebook without a pending recovery.');
      await notebook.command({
        kind: 'insert-reference',
        index: snapshot.blockCount,
        tableReference: selected,
        presentation,
        label: title,
      });
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      reportSaveFailure(
        '[Table] Table reference insertion failed:',
        { tableId: reference.documentId, notebookId },
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
        className="rounded border border-border px-2 py-1 text-xs wp-interactive"
        onClick={() => {
          requestId.current = crypto.randomUUID();
          setNotebookId(notebooks[0]?.id ?? '');
          setBinding(reference.binding.kind);
          setError(null);
          setOpen(true);
        }}
      >
        Insert in notebook…
      </button>
      {open && (
        <TableDocumentDialog title="Insert in notebook" busy={busy} onClose={() => setOpen(false)}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Notebook
              <span className="inline-block min-w-0">
                <MenuNativeSelect
                  density="compact"
                  aria-label="Notebook"
                  disabled={busy}
                  value={notebookId}
                  onChange={(event) => setNotebookId(event.target.value)}
                >
                  {notebooks.length === 0 && (
                    <option value="">Open or create a notebook first</option>
                  )}
                  {notebooks.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                    </option>
                  ))}
                </MenuNativeSelect>
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Reference
              <span className="inline-block min-w-0">
                <MenuNativeSelect
                  density="compact"
                  aria-label="Reference"
                  disabled={busy || reference.binding.kind === 'saved-version'}
                  value={binding}
                  onChange={(event) =>
                    setBinding(event.target.value as 'current' | 'saved-version')
                  }
                >
                  <option value="current">Live table</option>
                  <option value="saved-version">Saved version</option>
                </MenuNativeSelect>
              </span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Display
              <span className="inline-block min-w-0">
                <MenuNativeSelect
                  density="compact"
                  aria-label="Display"
                  disabled={busy}
                  value={presentation}
                  onChange={(event) => setPresentation(event.target.value as 'embed' | 'link')}
                >
                  <option value="embed">Embed</option>
                  <option value="link">Link</option>
                </MenuNativeSelect>
              </span>
            </label>
            <p className="text-xs text-fg-muted">
              Save the notebook after insertion. A saved version keeps the table’s currently saved
              contents.
            </p>
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
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
                disabled={busy || !notebookId}
                className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50"
              >
                {busy ? 'Inserting…' : 'Insert reference'}
              </button>
            </div>
          </form>
        </TableDocumentDialog>
      )}
    </>
  );
}

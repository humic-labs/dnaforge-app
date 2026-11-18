import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { platform } from '../../../platform';
import { Button } from '../../../shared/components/Button';
import type {
  WorkNotebookPlacement,
  WorkPlacementIntent,
} from '../../../shared/work-task-reference';
import type { WorkTaskRecord } from '../../../shared/work-tasks-ipc';
import { createWorkTask, observeWorkTasks, useWorkAccount } from '../../work/public/work';
import type { NativeNotebookDocumentClient } from '../notebook-document-client';

type Target = { projectId: string; taskId: string };
type Insertion = WorkNotebookPlacement &
  Target & { requestId: string; original?: WorkPlacementIntent };
type Position = { placement: WorkNotebookPlacement; name: string; checklist: boolean };

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function capture(editor: Editor, client: NativeNotebookDocumentClient): Promise<Position> {
  const doc = editor.state.doc;
  const { from, to, $from, $to } = editor.state.selection;
  if ($from.index(0) !== $to.index(0))
    throw new Error('Choose a position inside a single notebook block.');
  let name = from === to ? '' : doc.textBetween(from, to, ' ');
  let checklist = false;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== 'taskItem') continue;
    checklist = true;
    if (!name) name = $from.node(depth).firstChild?.textContent ?? '';
    break;
  }
  await client.flush();
  const snapshot = await client.command({ kind: 'inspect-copy' });
  if (snapshot.readOnly || snapshot.recovery)
    throw new Error('This notebook does not have an editable working copy.');
  if (
    editor.isDestroyed ||
    !doc.eq(editor.state.doc) ||
    !editor.schema.nodeFromJSON(snapshot.copy.content).eq(doc)
  )
    throw new Error('The notebook changed. Select the block again.');
  return {
    placement: {
      documentId: snapshot.documentId,
      expectedRevision: snapshot.revision,
      index: Math.min($from.index(0) + 1, snapshot.blockCount),
      placementId: crypto.randomUUID(),
    },
    name: name.slice(0, 500).trim(),
    checklist,
  };
}

export function NotebookWorkControl({
  editor,
  client,
}: {
  editor: Editor;
  client: NativeNotebookDocumentClient;
}) {
  const account = useWorkAccount();
  const snapshot = client.snapshot!;
  const root = snapshot.workspaceRoot,
    documentId = snapshot.documentId;
  const scope = JSON.stringify([account, root, documentId]);
  return (
    <NotebookTasks
      key={scope}
      scope={scope}
      root={root}
      documentId={documentId}
      editor={editor}
      client={client}
    />
  );
}

function NotebookTasks({
  scope,
  root,
  documentId,
  editor,
  client,
}: {
  scope: string;
  root: string;
  documentId: string;
  editor: Editor;
  client: NativeNotebookDocumentClient;
}) {
  const [position, setPosition] = useState<Position | null>(null);
  const [search, setSearch] = useState('');
  const [tasks, setTasks] = useState<WorkTaskRecord[] | null>(null);
  const [pending, setPending] = useState<WorkPlacementIntent[]>([]);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const flight = useRef(false);
  const mounted = useRef(true);
  const autoPlacement = useRef<string | null>(null);
  const recoveryKey = 'notebook-task-placement-v1/' + scope;
  useEffect(() => {
    mounted.current = true;
    const off = observeWorkTasks(() => setRefresh((n) => n + 1));
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (raw) {
        const recovered = JSON.parse(raw) as Insertion;
        if (recovered.documentId === documentId && recovered.requestId && recovered.placementId)
          setInsertion(recovered);
      }
    } catch {
      setError('The saved reference placement could not be read.');
    }
    return () => {
      mounted.current = false;
      off();
    };
  }, [documentId, recoveryKey]);
  useEffect(() => {
    let active = true;
    async function read() {
      try {
        const result = await platform().workTasks.placements({ workspaceRoot: root, documentId });
        if (active) setPending(result);
      } catch (cause) {
        if (active) {
          setPending([]);
          setError(message(cause));
        }
      }
    }
    void read();
    return () => {
      active = false;
    };
  }, [root, documentId, refresh]);
  useEffect(() => {
    if (!position) return;
    let active = true;
    setTasks(null);
    const timer = setTimeout(
      async () => {
        try {
          const result = await platform().workTasks.query({
            workspaceRoot: root,
            state: 'all',
            search: search.trim() || undefined,
            limit: 25,
          });
          if (!active) return;
          if (result.unavailable.length) throw new Error('Project tasks are unavailable.');
          setTasks(result.tasks);
        } catch (cause) {
          if (active) setError(message(cause));
        }
      },
      search ? 160 : 0
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [position, root, search, refresh]);
  async function act(work: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function insert(intent: Insertion) {
    localStorage.setItem(recoveryKey, JSON.stringify(intent));
    setInsertion(intent);
    setStale(false);
    const updated = await client
      .command(
        {
          kind: 'insert-reference',
          index: intent.index,
          workTask: {
            projectId: intent.projectId,
            taskId: intent.taskId,
            placementId: intent.placementId,
          },
        },
        { requestId: intent.requestId, expectedRevision: intent.expectedRevision }
      )
      .catch((cause) => {
        if (mounted.current && message(cause).includes('STALE_NOTEBOOK')) setStale(true);
        throw cause;
      });
    if (intent.original)
      await platform().workTasks.finishPlacement({
        workspaceRoot: root,
        operationId: intent.original.operationId,
        placementId: intent.original.placementId,
        disposition: intent.original.placementId === intent.placementId ? 'inserted' : 'abandoned',
      });
    localStorage.removeItem(recoveryKey);
    if (!mounted.current) return;
    setInsertion(null);
    setPosition(null);
    setRefresh((n) => n + 1);
    const status = updated.result as { disposition?: string } | null;
    setNotice(
      status?.disposition === 'removed'
        ? 'The reference was removed in the notebook.'
        : status?.disposition === 'recovery'
          ? 'The reference is in the notebook recovery copy.'
          : status?.disposition === 'published'
            ? 'Notebook reference saved.'
            : 'Reference in notebook draft. Save the notebook to publish it.'
    );
  }
  function fromPending(intent: WorkPlacementIntent): Insertion {
    return {
      ...intent,
      original: intent,
      requestId: 'insert-task-reference/' + intent.placementId,
    };
  }
  useEffect(() => {
    const intent = pending.find((item) => item.placementId === autoPlacement.current);
    if (!intent || insertion || flight.current) return;
    autoPlacement.current = null;
    void act(() => insert(fromPending(intent)));
  }, [pending, insertion, busy]);
  const disabled = busy || client.snapshot?.readOnly || !!client.snapshot?.recovery;
  const unresolved = insertion || pending.length > 0;
  return (
    <div
      className="relative ml-auto flex flex-wrap items-center gap-1"
      data-testid="notebook-work-control"
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={disabled || !!unresolved}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (position) {
            setPosition(null);
            return;
          }
          void act(async () => {
            const next = await capture(editor, client);
            if (mounted.current) {
              setSearch('');
              setPosition(next);
            }
          });
        }}
      >
        Link task
      </Button>
      {position && !unresolved && (
        <div
          role="dialog"
          aria-label="Link notebook task"
          className="absolute right-0 top-full z-30 mt-1 w-72 space-y-2 rounded border border-border bg-bg p-3 text-xs shadow-lg"
        >
          <p className="font-medium">
            {position.checklist ? 'After selected checklist' : 'After selected block'}
          </p>
          <Button
            type="button"
            size="xs"
            disabled={disabled}
            onClick={() => {
              const shown = createWorkTask({
                workspaceRoot: root,
                subjectIds: [documentId],
                subjectName: client.snapshot?.title,
                initialName: position.name,
                notebookPlacement: position.placement,
              });
              if (shown) {
                autoPlacement.current = position.placement.placementId;
                setPosition(null);
              }
            }}
          >
            {position.checklist ? 'Create from checklist item' : 'Create task'}
          </Button>
          <input
            type="search"
            aria-label="Find existing task"
            placeholder="Find an existing task"
            className="w-full rounded border border-border bg-bg px-2 py-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-40 overflow-y-auto">
            {tasks?.map((task) => (
              <button
                key={task.id}
                type="button"
                disabled={disabled}
                className="block w-full rounded px-1 py-1 text-left hover:bg-bg-muted"
                onClick={() =>
                  void act(() =>
                    insert({
                      ...position.placement,
                      taskId: task.id,
                      projectId: task.project.id,
                      requestId: crypto.randomUUID(),
                    })
                  )
                }
              >
                {task.document.name}
              </button>
            ))}
            {tasks === null ? 'Loading tasks…' : tasks.length === 0 ? 'No matching tasks.' : null}
          </div>
          <Button type="button" size="xs" variant="ghost" onClick={() => setPosition(null)}>
            Close
          </Button>
        </div>
      )}
      {insertion ? (
        <div className="flex flex-wrap items-center gap-1">
          <span>Reference placement pending</span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={disabled}
            onClick={() => void act(() => insert(insertion))}
          >
            Check placement
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled || !stale}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              void act(async () => {
                const current = await capture(editor, client);
                if (mounted.current)
                  await insert({
                    ...insertion,
                    ...current.placement,
                    requestId: crypto.randomUUID(),
                  });
              })
            }
          >
            Use selected block
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy || !stale}
            onClick={() =>
              void act(async () => {
                if (insertion.original)
                  await platform().workTasks.finishPlacement({
                    workspaceRoot: root,
                    operationId: insertion.original.operationId,
                    placementId: insertion.original.placementId,
                    disposition: 'abandoned',
                  });
                localStorage.removeItem(recoveryKey);
                if (mounted.current) {
                  setInsertion(null);
                  setPosition(null);
                  setRefresh((n) => n + 1);
                }
              })
            }
          >
            Leave task without placement
          </Button>
        </div>
      ) : (
        pending.map((intent) => (
          <div key={intent.placementId} className="flex flex-wrap items-center gap-1">
            <span>Saved task awaiting notebook reference</span>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={disabled}
              onClick={() => void act(() => insert(fromPending(intent)))}
            >
              Place reference
            </Button>
          </div>
        ))
      )}
      {notice && <span role="status">{notice}</span>}
      {error && (
        <div role="alert" className="text-error">
          {error}{' '}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setError('');
              setRefresh((n) => n + 1);
            }}
          >
            Refresh
          </Button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { platform } from '../../platform';
import { Button } from '../../shared/components/Button';
import { Input } from '../../shared/components/Input';
import {
  pastWorkDeadline,
  type WorkAssignee,
  type WorkTaskCommand,
} from '@waypoint/domain-services';
import type {
  WorkProject,
  WorkTaskHistory,
  WorkTaskMutation,
  WorkTaskRecord,
} from '../../shared/work-tasks-ipc';
import {
  closeWorkTask,
  useWorkTaskDialog,
  WORK_TASK_CHANGED,
  type NewTaskContext,
} from './task-presentation';
import { observeWorkChanges, useWorkAccount } from './use-work-query';
import { fieldClass } from './DateField';
import { RelativeDateField } from './RelativeDateField';
import { RecurrenceEditor } from './RecurrenceEditor';
import { OccurrencePanel } from './OccurrencePanel';
import { AssigneeField } from './AssigneeField';
import { WorkTaskReminders } from './WorkReminders';
import { WorkFutureSeries } from './WorkFutureSeries';
import { changedTaskFields, taskDraft, describeDate, type TaskDraft } from './task-form';

import { readWorkRecovery, writeWorkRecovery, type WorkEditRecovery } from './task-recovery';

type Request = NonNullable<ReturnType<typeof useWorkTaskDialog.getState>['request']>;
interface Loaded {
  record: WorkTaskRecord | null;
  projects: WorkProject[];
  actor: WorkAssignee;
  recoveryKey: string;
  recovery: WorkEditRecovery | null;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The task could not be loaded.';
}

export function WorkTaskDialogHost() {
  const request = useWorkTaskDialog((s) => s.request);
  const account = useWorkAccount();
  const previousAccount = useRef(account);
  useEffect(() => {
    if (previousAccount.current !== account) {
      closeWorkTask();
      previousAccount.current = account;
    }
  }, [account]);
  return request && previousAccount.current === account ? (
    <TaskDialog key={account} request={request} account={account} />
  ) : null;
}

function TaskDialog({ request, account }: { request: Request; account: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const client = platform().workTasks;
        const context = request.kind === 'create' ? request.context : null;
        const root =
          request.kind === 'open' ? request.target.workspaceRoot : context?.workspaceRoot;
        const [record, list] = await Promise.all([
          request.kind === 'open' ? client.read(request.target) : null,
          client.query({ workspaceRoot: root, limit: 1 }),
        ]);
        if (!current) return;
        if (request.kind === 'open' && !record) throw new Error('This task is unavailable.');
        const projects = list.projects.filter(
          (p) =>
            (!root || root === p.root) &&
            (!context?.workspaceId || context.workspaceId === p.workspaceId) &&
            (request.kind === 'open' || p.writable !== false) &&
            !list.unavailable.some((u) => u.project.id === p.id)
        );
        if (!projects.length) throw new Error('No available project for this task.');
        const recoveryKey =
          'work-edit-v1/' +
          JSON.stringify([
            account,
            list.actor.kind,
            list.actor.id,
            request.kind === 'open'
              ? request.target
              : ['new', context?.workspaceRoot, context?.workspaceId, context?.subjectIds],
          ]);
        const recovery = readWorkRecovery(recoveryKey);
        const sourceProject = recovery && projects.find((p) => p.root === recovery.workspaceRoot);
        if (recovery && !sourceProject)
          throw new Error('The project holding this draft is unavailable.');
        const recoveredTask =
          recovery && !record
            ? await client.read({ workspaceRoot: recovery.workspaceRoot, taskId: recovery.taskId })
            : record;
        if (!current) return;
        if (recovery?.revision && !recoveredTask)
          throw new Error('The task holding this draft is unavailable.');
        const acceptedDraft = taskDraft(recoveredTask);
        const recoveredEdit = recovery && {
          ...recovery,
          base: { ...acceptedDraft, ...recovery.base },
          draft: { ...acceptedDraft, ...recovery.draft },
          captured: recovery.captured && { ...acceptedDraft, ...recovery.captured },
        };
        setLoaded({
          record: recoveredTask,
          projects,
          actor: list.actor,
          recoveryKey,
          recovery: recoveredEdit,
        });
        setError('');
      } catch (cause) {
        if (current) {
          setLoaded(null);
          setError(errorText(cause));
        }
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [request, account, reload]);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="work-task-title"
      data-testid="work-task-dialog"
      onCancel={(e) => {
        if (loaded) e.preventDefault();
        else closeWorkTask();
      }}
      className="m-auto max-h-[86vh] w-[min(94vw,34rem)] overflow-y-auto rounded-lg border border-border bg-bg p-5 text-fg shadow-xl backdrop:bg-black/35"
    >
      {loaded ? (
        <TaskEditor
          loaded={loaded}
          occurrenceSlot={request.kind === 'open' ? request.occurrenceSlot : undefined}
          context={request.kind === 'create' ? request.context : undefined}
        />
      ) : (
        <>
          <h2 id="work-task-title" className="text-base font-semibold">
            Task
          </h2>
          <p className="my-3 text-sm" role={error ? 'alert' : 'status'}>
            {error || 'Loading task…'}
          </p>
          {error && (
            <Button variant="secondary" size="xs" onClick={() => setReload((n) => n + 1)}>
              Retry
            </Button>
          )}{' '}
          <Button variant="ghost" size="xs" onClick={closeWorkTask}>
            Close
          </Button>
        </>
      )}
    </dialog>
  );
}

function TaskEditor({
  loaded,
  context,
  occurrenceSlot,
}: {
  loaded: Loaded;
  context?: NewTaskContext;
  occurrenceSlot?: string;
}) {
  const [record, setRecord] = useState(loaded.record);
  const [base, setBase] = useState(() => loaded.recovery?.base ?? taskDraft(loaded.record));
  const [draft, setDraft] = useState<TaskDraft>(
    () =>
      loaded.recovery?.draft ?? {
        ...base,
        name: context?.initialName ?? base.name,
        assignee: loaded.record ? base.assignee : (loaded.projects[0]!.actor ?? loaded.actor),
      }
  );
  const [projectRoot, setProjectRoot] = useState(
    loaded.recovery?.workspaceRoot ?? loaded.record?.project.root ?? loaded.projects[0]!.root
  );
  const project = loaded.projects.find((p) => p.root === projectRoot)!;
  const me = project.actor ?? loaded.actor;
  const [taskId] = useState(
    () => loaded.recovery?.taskId ?? loaded.record?.id ?? crypto.randomUUID()
  );
  const [acceptedMove, setAcceptedMove] = useState<{ slot: string; operationId: string } | null>(
    null
  );
  const [notice, setNotice] = useState(loaded.recovery ? 'Recovered your unfinished edit.' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<WorkTaskMutation | null>(loaded.recovery?.pending ?? null);
  const [conflict, setConflict] = useState<WorkTaskRecord | null>(
    loaded.recovery &&
      !loaded.recovery.pending &&
      loaded.record?.revisionId !== loaded.recovery.revision
      ? loaded.record
      : null
  );
  const [confirmClose, setConfirmClose] = useState(false);
  const [history, setHistory] = useState<WorkTaskHistory | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  const pendingDraft = useRef(loaded.recovery?.captured ?? draft);
  const [showEnd, setShowEnd] = useState(!!(draft.end.date || draft.end.relative));
  const terminal = record?.document.status === 'done' || record?.document.status === 'canceled';
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  const sources = {
    project,
    taskId,
    subjectIds:
      context?.subjectIds ??
      record?.document.links
        .filter((link) => link.projectId === project.id)
        .map((link) => link.resourceId) ??
      [],
  };
  const hasRelativeDate = Boolean(draft.start.relative || draft.end.relative || draft.due.relative);
  const assigneeIsMe = draft.assignee?.kind === me.kind && draft.assignee?.id === me.id;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const recoveryRevision = useRef(loaded.recovery?.revision ?? record?.revisionId ?? null);
  const notebookPlacement = loaded.recovery?.notebookPlacement ?? context?.notebookPlacement;
  function remember(
    value: TaskDraft,
    intent: WorkTaskMutation | null,
    baseline = base,
    root = projectRoot
  ) {
    writeWorkRecovery(loaded.recoveryKey, {
      taskId,
      workspaceRoot: root,
      ...(notebookPlacement ? { notebookPlacement } : {}),
      revision: recoveryRevision.current,
      base: baseline,
      draft: value,
      pending: intent,
      captured: intent ? pendingDraft.current : null,
    });
  }
  useEffect(() => {
    if (!record || pending) return;
    let generation = 0;
    let active = true;
    const off = observeWorkChanges(async () => {
      if (inFlight.current || document.hidden) return;
      const version = ++generation;
      try {
        const latest = await platform().workTasks.read({ workspaceRoot: projectRoot, taskId });
        if (!active || generation !== version || inFlight.current) return;
        if (!latest) {
          closeWorkTask();
          return;
        }
        if (
          latest.revisionId === record.revisionId &&
          latest.project.writable === record.project.writable &&
          JSON.stringify(latest.schedule) === JSON.stringify(record.schedule)
        )
          return;
        if (
          latest.revisionId === record.revisionId &&
          latest.project.writable === record.project.writable
        ) {
          setRecord(latest);
          return;
        }
        if (JSON.stringify(draftRef.current) !== JSON.stringify(base)) {
          setConflict(latest);
          setError('Another edit was saved. Compare it with your draft.');
        } else {
          const accepted = taskDraft(latest);
          recoveryRevision.current = latest.revisionId;
          setRecord(latest);
          setBase(accepted);
          setDraft(accepted);
          draftRef.current = accepted;
          setHistory(null);
        }
      } catch (cause) {
        if (!active || generation !== version) return;
        if (errorText(cause).includes('WORK_TASK_REFUSED:')) closeWorkTask();
        else setError('Could not refresh this task. ' + errorText(cause));
      }
    });
    return () => {
      active = false;
      off();
    };
  }, [record, base, pending, taskId, projectRoot]);
  function change(patch: Partial<TaskDraft>) {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    remember(next, pending);
    setConfirmClose(false);
  }
  function cancel() {
    if (busy) return;
    if (pending) {
      closeWorkTask();
      return;
    }
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    writeWorkRecovery(loaded.recoveryKey, null);
    closeWorkTask();
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  async function showConflict() {
    setPending(null);
    remember(draftRef.current, null);
    try {
      const latest = await platform().workTasks.read({ workspaceRoot: projectRoot, taskId });
      if (!mounted.current) return;
      setConflict(latest);
      setError(
        latest
          ? 'Another edit was saved. Compare it with your draft before saving.'
          : 'This task is no longer available.'
      );
    } catch (cause) {
      if (mounted.current)
        setError(
          'The task change conflicted. Could not load the current task. ' + errorText(cause)
        );
    }
  }
  async function send(request: WorkTaskMutation, retry = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(request);
    let checkingOriginal = retry;
    try {
      remember(draftRef.current, request);
      const result = await platform().workTasks.mutate(request);
      checkingOriginal = true;
      if (!mounted.current) return;
      const receipt = result.submission.receipt;
      if (receipt.outcome === 'conflict') {
        await showConflict();
        return;
      }
      if (receipt.outcome === 'rejected') {
        setPending(null);
        remember(draftRef.current, null);
        setError('Task change rejected: ' + receipt.error.kind);
        return;
      }
      const accepted =
        result.task ?? (await platform().workTasks.read({ workspaceRoot: projectRoot, taskId }));
      if (!mounted.current) return;
      if (!accepted) throw new Error('Accepted task is unavailable for readback.');
      const next = taskDraft(accepted);
      const submitted = pendingDraft.current;
      const retained = { ...next };
      for (const key of Object.keys(next) as (keyof TaskDraft)[]) {
        if (JSON.stringify(draftRef.current[key]) !== JSON.stringify(submitted[key]))
          Object.assign(retained, { [key]: draftRef.current[key] });
      }
      recoveryRevision.current = accepted.revisionId;
      if (JSON.stringify(next) === JSON.stringify(retained))
        writeWorkRecovery(loaded.recoveryKey, null);
      else remember(retained, null, next);
      setRecord(accepted);
      if (request.command.kind === 'occurrence' && request.command.action.kind === 'move') {
        setAcceptedMove({ slot: request.command.slot, operationId: request.operationId });
      }
      setBase(next);
      setDraft(retained);
      draftRef.current = retained;
      setHistory(null);
      setConflict(null);
      setPending(null);
      setConfirmClose(false);
      setNotice(
        result.submission.delivery?.kind === 'blocked'
          ? 'Task saved. File delivery needs attention. ' + result.submission.delivery.error
          : result.notebookPlacement
            ? 'Task saved. Return to the notebook to check its reference.'
            : 'Saved'
      );
      window.dispatchEvent(new Event(WORK_TASK_CHANGED));
    } catch (cause) {
      if (!mounted.current) return;
      const message = errorText(cause);
      if (!checkingOriginal && message.includes('WORK_TASK_REFUSED:')) {
        setPending(null);
        remember(draftRef.current, null);
        setError(message.split('WORK_TASK_REFUSED:').pop()!.trim());
        return;
      }
      if (!checkingOriginal && message.includes('WORK_TASK_CONFLICT:')) {
        await showConflict();
        return;
      }
      if (mounted.current)
        setError(errorText(cause) + ' Check the save outcome before trying another change.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function submit(command: WorkTaskCommand) {
    if (
      pending ||
      inFlight.current ||
      conflict ||
      project.writable === false ||
      record?.project.writable === false
    )
      return;
    pendingDraft.current = draft;
    void send({
      workspaceRoot: projectRoot,
      taskId,
      operationId: crypto.randomUUID(),
      expectedRevisionId: record?.revisionId ?? null,
      command,
      ...(command.kind === 'create' && notebookPlacement ? { notebookPlacement } : {}),
    });
  }
  function save() {
    if (terminal || project.writable === false || (record && !dirty)) return;
    try {
      const fields = changedTaskFields(draft, base);
      if (!draft.name.trim()) throw new Error('Enter a task name.');
      const links = context?.subjectIds?.map((resourceId) => ({
        projectId: project.id,
        resourceId,
        ...(resourceId === notebookPlacement?.documentId ? { role: 'notebook' } : {}),
      }));
      submit(
        record
          ? { kind: 'edit', ...fields }
          : { kind: 'create', ...fields, name: draft.name.trim(), ...(links ? { links } : {}) }
      );
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  function resolveConflict(keep: boolean) {
    if (!conflict) return;
    const latest = taskDraft(conflict);
    const next = { ...latest };
    if (keep) {
      for (const key of Object.keys(latest) as (keyof TaskDraft)[]) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(base[key]))
          Object.assign(next, { [key]: draft[key] });
      }
    }
    recoveryRevision.current = conflict.revisionId;
    remember(next, null, latest);
    setRecord(conflict);
    setBase(latest);
    setDraft(next);
    draftRef.current = next;
    setConflict(null);
    setError('');
    setNotice(keep ? 'Review the reconciled draft, then save.' : 'Current version loaded.');
  }

  return (
    <form
      data-analytics-block="true"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 id="work-task-title" className="text-base font-semibold">
          {record ? 'Task details' : 'New task'}
        </h2>
        {record && (
          <span className="text-xs text-fg-muted">
            {
              { todo: 'To do', 'in-progress': 'In progress', done: 'Done', canceled: 'Canceled' }[
                record.document.status
              ]
            }
          </span>
        )}
      </header>
      <fieldset disabled={terminal || project.writable === false} className="min-w-0 space-y-3">
        {loaded.projects.length > 1 && !record ? (
          <label className="block text-xs font-medium">
            Project
            <select
              className={fieldClass}
              disabled={!!pending || busy || hasRelativeDate}
              value={projectRoot}
              onChange={(e) => {
                const next = loaded.projects.find((p) => p.root === e.target.value)!;
                setProjectRoot(next.root);
                const updated = assigneeIsMe
                  ? { ...draftRef.current, assignee: next.actor ?? loaded.actor }
                  : draftRef.current;
                draftRef.current = updated;
                setDraft(updated);
                remember(updated, null, base, next.root);
              }}
            >
              {loaded.projects.map((p) => (
                <option key={p.id} value={p.root}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-fg-muted">
            {project.name}
            {context?.subjectName ? ' · ' + context.subjectName : ''}
          </p>
        )}
        <Input
          label="Name"
          id="work-task-name"
          required
          autoFocus
          value={draft.name}
          onChange={(e) => change({ name: e.target.value })}
        />
        <label className="block text-xs font-medium">
          Description
          <textarea
            className={fieldClass}
            rows={2}
            value={draft.description}
            onChange={(e) => change({ description: e.target.value })}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <RelativeDateField
            {...sources}
            label="Plan for"
            resolution={
              JSON.stringify(base.start.relative) === JSON.stringify(draft.start.relative)
                ? record?.schedule.start
                : undefined
            }
            value={draft.start}
            change={(start) => change({ start })}
          />
          <RelativeDateField
            {...sources}
            label="Due"
            resolution={
              JSON.stringify(base.due.relative) === JSON.stringify(draft.due.relative)
                ? record?.schedule.deadline
                : undefined
            }
            value={draft.due}
            change={(due) => change({ due })}
          />
        </div>
        {showEnd || draft.end.date || draft.end.relative ? (
          <RelativeDateField
            {...sources}
            label="Planned end"
            resolution={
              JSON.stringify(base.end.relative) === JSON.stringify(draft.end.relative)
                ? record?.schedule.end
                : undefined
            }
            value={draft.end}
            change={(end) => change({ end })}
          />
        ) : (
          (draft.start.date || draft.start.relative) && (
            <Button type="button" size="xs" variant="ghost" onClick={() => setShowEnd(true)}>
              Add planned end
            </Button>
          )
        )}
        <RecurrenceEditor
          value={draft.recurrence}
          change={(recurrence) => change({ recurrence })}
          start={draft.start}
          saved={record?.document.recurrence ?? null}
        />
        <AssigneeField
          root={projectRoot}
          me={me}
          value={draft.assignee}
          change={(assignee) => change({ assignee })}
        />
      </fieldset>
      {record && (record.document.recurrence || record.document.occurrences.length > 0) && (
        <OccurrencePanel
          record={record}
          initialSlot={occurrenceSlot}
          acceptedMove={acceptedMove}
          editable={
            !terminal &&
            project.writable !== false &&
            record.project.writable !== false &&
            !dirty &&
            !pending &&
            !busy &&
            !conflict
          }
          submit={submit}
        />
      )}
      {record?.document.links.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted">
            Linked records ({record.document.links.length})
          </summary>
          <ul>
            {record.document.links.map((link) => (
              <li className="break-all" key={JSON.stringify(link)}>
                {link.resourceId}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {record && (
        <details
          className="text-xs"
          onToggle={(e) => {
            if (e.currentTarget.open && !history)
              void platform()
                .workTasks.history({ workspaceRoot: projectRoot, taskId })
                .then((h) => {
                  if (mounted.current) setHistory(h);
                })
                .catch((c) => {
                  if (mounted.current) setError(errorText(c));
                });
          }}
        >
          <summary className="cursor-pointer text-fg-muted">History</summary>
          {history ? (
            <ol className="mt-1 space-y-1">
              {history.revisions.map((r) => (
                <li key={r.revisionId}>
                  {new Date(r.document.updatedAt).toLocaleString()} · {r.document.name} ·{' '}
                  {r.document.status}
                </li>
              ))}
            </ol>
          ) : (
            <p>Loading history…</p>
          )}
        </details>
      )}
      {record?.document.completion && (
        <section aria-label="Completion" className="rounded border border-border p-3 text-xs">
          <p>Completed {new Date(record.document.completion.actualAt).toLocaleString()}</p>
          <p className="text-fg-muted">
            Recorded {new Date(record.document.completion.recordedAt).toLocaleString()}
            {record.document.completion.reported ? ' · Actual time supplied' : ''}
          </p>
          <p>
            {record.document.completion.schedule.deadline.kind === 'resolved'
              ? pastWorkDeadline(
                  record.document.completion.schedule.deadline.value,
                  record.document.completion.actualAt
                )
                ? 'Completed after the deadline'
                : 'Completed on time'
              : record.document.completion.schedule.deadline.kind === 'missing'
                ? 'No deadline was set'
                : 'Deadline could not be resolved at completion'}
          </p>
        </section>
      )}
      {record?.document.cancellation && (
        <p className="text-xs text-fg-muted">
          Canceled {new Date(record.document.cancellation.recordedAt).toLocaleString()}
          {record.document.cancellation.reason ? ' · ' + record.document.cancellation.reason : ''}
        </p>
      )}
      {record?.document.recurrence && (
        <WorkFutureSeries
          record={record}
          editable={!dirty && !pending && !busy && !conflict && project.writable !== false}
        />
      )}
      {record && <WorkTaskReminders task={record} />}
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      {conflict && (
        <div className="space-y-2 rounded border border-warning p-2 text-xs">
          <p>
            Current version · {conflict.document.name} · {conflict.document.status}
          </p>
          <p>
            Plan{' '}
            {conflict.schedule.start.kind === 'resolved'
              ? describeDate(conflict.schedule.start.value)
              : conflict.schedule.start.kind}{' '}
            · Due{' '}
            {conflict.schedule.deadline.kind === 'resolved'
              ? describeDate(conflict.schedule.deadline.value)
              : conflict.schedule.deadline.kind}
          </p>
          <p>{conflict.document.description}</p>
          <p>Assignee · {conflict.document.assignee?.id ?? 'Unassigned'}</p>
          <Button type="button" size="xs" variant="secondary" onClick={() => resolveConflict(true)}>
            Keep my changed fields
          </Button>{' '}
          <Button type="button" size="xs" variant="ghost" onClick={() => resolveConflict(false)}>
            Load current version
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-fg-muted">
          {notice}
        </p>
      )}
      {confirmClose && (
        <p role="alert" className="text-xs text-warning">
          Discard these unsaved edits?
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button
          type="submit"
          size="sm"
          disabled={
            terminal ||
            project.writable === false ||
            busy ||
            !!pending ||
            !!conflict ||
            (!dirty && !!record)
          }
        >
          Save
        </Button>
        {record && project.writable !== false && !dirty && !pending && !conflict && (
          <>
            {!terminal && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => submit({ kind: 'complete' })}
              >
                Complete
              </Button>
            )}
            {record.document.status === 'todo' && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => submit({ kind: 'start' })}
              >
                Start
              </Button>
            )}
            {!terminal && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => submit({ kind: 'cancel' })}
              >
                Cancel task
              </Button>
            )}
            {terminal && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => submit({ kind: 'reopen' })}
              >
                Reopen
              </Button>
            )}
          </>
        )}
        {pending && !busy && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void send(pending, true)}
          >
            Check save outcome
          </Button>
        )}
        <Button
          type="button"
          className="ml-auto"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={cancel}
        >
          {pending ? 'Close and keep pending save' : confirmClose ? 'Discard edits' : 'Close'}
        </Button>
      </footer>
    </form>
  );
}

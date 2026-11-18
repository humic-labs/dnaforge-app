import { useState } from 'react';
import {
  workAgendaBucket,
  type WorkAgendaBucket,
  type WorkResolvedDate,
} from '@waypoint/domain-services';
import { Button } from '../../shared/components/Button';
import { WorkCalendar } from './WorkCalendar';
import { createWorkTask, openWorkTask } from './task-presentation';
import { describeDate } from './task-form';
import { useWorkQuery } from './use-work-query';
import { useWorkRecordDates, WorkRecordDateAgenda } from './WorkRecordDates';

const buckets = [
  ['overdue', 'Overdue'],
  ['today', 'Today'],
  ['upcoming', 'Upcoming'],
  ['past-plan', 'Earlier plans'],
  ['unresolved', 'Date needs clarification'],
  ['unscheduled', 'Unscheduled'],
  ['terminal', 'Finished'],
] as const satisfies ReadonlyArray<readonly [WorkAgendaBucket, string]>;

function dateLabel(date: WorkResolvedDate) {
  if (date.kind === 'missing') return null;
  return date.kind === 'resolved' ? describeDate(date.value) : 'Needs clarification';
}

interface WorkPanelProps {
  mode: 'mine' | 'project' | 'record';
  workspaceRoot?: string;
  workspaceId?: number;
  subjectId?: string;
  subjectName?: string;
}

export function WorkPanel({
  mode,
  workspaceRoot,
  workspaceId,
  subjectId,
  subjectName,
}: WorkPanelProps) {
  const [view, setView] = useState<'agenda' | 'calendar'>('agenda');
  const [state, setState] = useState<'active' | 'all'>('active');
  const [assignee, setAssignee] = useState<'all' | 'me' | 'unassigned'>(
    mode === 'mine' ? 'me' : 'all'
  );
  const { result, error, refresh } = useWorkQuery({ workspaceRoot, subjectId, state, assignee });
  const recordDates = useWorkRecordDates(mode === 'project' ? workspaceRoot : undefined);
  const displayError =
    error ??
    (result?.snapshotId && recordDates.snapshotId && result.snapshotId !== recordDates.snapshotId
      ? 'Project schedule changed while loading. Refresh to try again.'
      : undefined);
  const projects =
    result?.projects.filter(
      (p) =>
        (workspaceId === undefined || workspaceId === p.workspaceId) &&
        (!workspaceRoot || workspaceRoot === p.root)
    ) ?? [];
  const tasks = result?.tasks.filter((t) => projects.some((p) => p.id === t.project.id)) ?? [];
  const unavailable =
    result?.unavailable.filter(
      (u) =>
        projects.some((p) => p.id === u.project.id) ||
        workspaceId === u.project.workspaceId ||
        (!workspaceId && !workspaceRoot) ||
        workspaceRoot === u.project.root
    ) ?? [];
  const title =
    mode === 'mine' ? 'My work' : mode === 'project' ? 'Project schedule' : 'Linked work';
  const groups = new Map<WorkAgendaBucket, typeof tasks>();
  for (const task of tasks) {
    const bucket = workAgendaBucket(task.document.status, task.schedule, result!.now);
    const group = groups.get(bucket);
    if (group) group.push(task);
    else groups.set(bucket, [task]);
  }

  return (
    <section
      data-testid={'work-' + mode}
      data-analytics-block="true"
      className="ph-no-capture min-w-0 space-y-3 text-fg"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button
          variant="secondary"
          size="xs"
          disabled={
            !projects.some(
              (p) => p.writable !== false && !unavailable.some((u) => u.project.id === p.id)
            )
          }
          onClick={() =>
            createWorkTask({
              workspaceRoot,
              workspaceId,
              subjectIds: subjectId ? [subjectId] : undefined,
              subjectName,
            })
          }
        >
          Add task
        </Button>
      </header>
      {displayError ? (
        <div role="alert" className="text-xs text-fg-muted">
          {displayError}{' '}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              refresh();
              recordDates.refresh();
            }}
          >
            Retry
          </Button>
        </div>
      ) : !result ? (
        <p role="status" className="text-xs text-fg-muted">
          Loading work…
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            {mode === 'project' && (
              <div aria-label="Schedule view" className="flex rounded border border-border">
                {(['agenda', 'calendar'] as const).map((v) => (
                  <button
                    type="button"
                    key={v}
                    aria-pressed={view === v}
                    className={
                      'rounded px-2 py-1 capitalize ' + (view === v ? 'bg-bg-muted text-fg' : '')
                    }
                    onClick={() => setView(v)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
            {mode !== 'mine' && (
              <select
                aria-label="Filter by assignee"
                className="bg-bg"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value as typeof assignee)}
              >
                <option value="all">All assignees</option>
                <option value="me">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
              </select>
            )}
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={state === 'all'}
                onChange={(e) => setState(e.target.checked ? 'all' : 'active')}
              />
              Include finished
            </label>
          </div>
          {unavailable.map((u) => (
            <p role="status" key={u.project.id} className="text-xs text-warning">
              {u.project.name} · {u.reason}
            </p>
          ))}
          {view === 'calendar' ? (
            <WorkCalendar tasks={tasks} recordDates={recordDates.rows} />
          ) : (
            <>
              {buckets.map(([bucket, label]) => {
                const items = groups.get(bucket);
                if (!items?.length) return null;
                return (
                  <div key={bucket}>
                    <h3
                      className={
                        'border-b border-border pb-1 text-xs font-medium ' +
                        (bucket === 'overdue' ? 'text-error' : 'text-fg-muted')
                      }
                    >
                      {label}
                    </h3>
                    <ul>
                      {items.map((t) => {
                        const due = dateLabel(t.schedule.deadline),
                          plan = dateLabel(t.schedule.start);
                        return (
                          <li key={JSON.stringify([t.project.id, t.id])}>
                            <button
                              type="button"
                              data-task-id={t.id}
                              className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 rounded px-1 py-2 text-left hover:bg-bg-muted"
                              onClick={() =>
                                openWorkTask({ workspaceRoot: t.project.root, taskId: t.id })
                              }
                            >
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {t.document.name}
                              </span>
                              {mode === 'mine' && (
                                <span className="text-xs text-fg-subtle">{t.project.name}</span>
                              )}
                              {plan && <span className="text-xs text-fg-muted">Plan {plan}</span>}
                              {due && (
                                <span
                                  className={
                                    'text-xs ' +
                                    (bucket === 'overdue' ? 'text-error' : 'text-fg-muted')
                                  }
                                >
                                  Due {due}
                                </span>
                              )}
                              {bucket === 'terminal' && (
                                <span className="text-xs text-fg-subtle">
                                  {t.document.status === 'done' ? 'Done' : 'Canceled'}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
              {!tasks.length && !unavailable.length && (
                <p className="text-xs text-fg-muted">
                  {mode === 'mine'
                    ? 'No tasks assigned to you.'
                    : mode === 'project'
                      ? 'No tasks match this view.'
                      : 'No linked tasks.'}
                </p>
              )}
            </>
          )}
          {recordDates.error && (
            <p role="alert" className="text-xs text-error">
              {recordDates.error}
            </p>
          )}
          {view === 'agenda' && <WorkRecordDateAgenda rows={recordDates.rows} />}
        </>
      )}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { workDatePart, type WorkSchedule } from '@waypoint/domain-services';
import { platform } from '../../platform';
import { Button } from '../../shared/components/Button';
import type { WorkRecordDate, WorkTaskRecord } from '../../shared/work-tasks-ipc';
import { openWorkRecordDate } from './WorkRecordDates';
import { openWorkTask } from './task-presentation';

function monthStart(date: Date, offset = 0) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1, 12);
}
function dayKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}
function localDateKey(value: Parameters<typeof workDatePart>[0]) {
  return value.kind === 'timed' ? dayKey(new Date(value.instant)) : workDatePart(value);
}
export function WorkCalendar({
  tasks,
  recordDates = [],
}: {
  tasks: WorkTaskRecord[];
  recordDates?: WorkRecordDate[];
}) {
  const [sourceError, setSourceError] = useState('');
  const [month, setMonth] = useState(() => monthStart(new Date()));
  const days = useMemo(() => {
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: Math.ceil((month.getDay() + end) / 7) * 7 }, (_, i) => {
      const day = i - month.getDay() + 1;
      return day >= 1 && day <= end
        ? new Date(month.getFullYear(), month.getMonth(), day, 12)
        : null;
    });
  }, [month]);
  const start = dayKey(month);
  const from = dayKey(new Date(month.getFullYear(), month.getMonth(), -1, 12));
  const through = dayKey(new Date(month.getFullYear(), month.getMonth() + 1, 2, 12));
  const [occurrences, setOccurrences] = useState<{
    month: string;
    tasks: WorkTaskRecord[];
    items: { task: WorkTaskRecord; slot: string; schedule: WorkSchedule }[];
    unavailable: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const series = tasks.filter(
      (task) => task.document.recurrence || task.document.occurrences.length
    );
    async function load() {
      const groups = await Promise.allSettled(
        series.map(async (task) => {
          const result = await platform().workTasks.occurrences({
            workspaceRoot: task.project.root,
            taskId: task.id,
            from,
            through,
          });
          return result
            .filter((item) => item.status !== 'skipped')
            .map((item) => ({ task, slot: item.slot, schedule: item.schedule }));
        })
      );
      if (active)
        setOccurrences({
          month: start,
          tasks,
          items: groups.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
          unavailable: groups.some((result) => result.status === 'rejected'),
        });
    }
    void load();
    return () => {
      active = false;
    };
  }, [tasks, start, from, through, attempt]);
  const current = occurrences?.month === start && occurrences.tasks === tasks ? occurrences : null;
  const dates = [
    ...tasks
      .filter((task) => !task.document.recurrence && !task.document.occurrences.length)
      .map((task) => ({ task, slot: undefined, schedule: task.schedule })),
    ...(current?.items ?? []),
  ];
  const today = dayKey(new Date());
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <h3 className="mr-auto text-sm font-semibold">
          {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h3>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setMonth(monthStart(month, -1))}
          aria-label="Previous month"
        >
          ‹
        </Button>
        <Button variant="secondary" size="xs" onClick={() => setMonth(monthStart(new Date()))}>
          Today
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setMonth(monthStart(month, 1))}
          aria-label="Next month"
        >
          ›
        </Button>
      </div>
      {current?.unavailable && (
        <p role="alert" className="text-xs text-fg-muted">
          Some repeating tasks could not be loaded.{' '}
          <Button size="xs" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </p>
      )}
      {sourceError && (
        <p role="alert" className="text-xs text-error">
          {sourceError}
        </p>
      )}
      {!current &&
        tasks.some((task) => task.document.recurrence || task.document.occurrences.length) && (
          <p role="status" className="text-xs text-fg-muted">
            Loading repeating tasks…
          </p>
        )}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded border border-border bg-border">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="bg-bg-subtle px-1 py-1 text-center text-[11px] text-fg-muted">
            {new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })}
          </div>
        ))}
        {days.map((date, index) => {
          if (!date) return <div key={index} className="bg-bg-subtle" />;
          const key = dayKey(date);
          return (
            <div key={key} className="min-h-16 min-w-0 bg-bg p-1">
              <span
                className={
                  key === today
                    ? 'rounded bg-accent px-1 text-xs text-accent-fg'
                    : 'text-xs text-fg-muted'
                }
              >
                {date.getDate()}
              </span>
              {dates.flatMap(({ task, slot, schedule }) => {
                const { start, end, deadline } = schedule;
                const from = start.kind === 'resolved' ? localDateKey(start.value) : null;
                const until = end.kind === 'resolved' ? localDateKey(end.value) : from;
                const planned = from !== null && until !== null && key >= from && key <= until;
                const due = deadline.kind === 'resolved' && localDateKey(deadline.value) === key;
                if (!planned && !due) return [];
                const label =
                  (planned && due ? 'Plan and due' : due ? 'Due' : 'Plan') +
                  ' · ' +
                  task.document.name;
                return [
                  <button
                    type="button"
                    key={JSON.stringify([task.project.id, task.id, slot])}
                    title={label}
                    aria-label={label}
                    onClick={() =>
                      openWorkTask({ workspaceRoot: task.project.root, taskId: task.id }, slot)
                    }
                    className="block w-full truncate rounded px-1 text-left text-[11px] text-fg hover:bg-bg-muted"
                  >
                    {label}
                  </button>,
                ];
              })}
              {recordDates
                .filter((row) => row.status === 'resolved' && localDateKey(row.value) === key)
                .map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    title={row.entityName + ' · ' + row.label}
                    className="block w-full truncate rounded px-1 text-left text-[11px] text-fg-muted hover:bg-bg-muted"
                    onClick={() =>
                      void openWorkRecordDate(row).catch((cause) => setSourceError(cause.message))
                    }
                  >
                    {row.label} · {row.entityName}
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

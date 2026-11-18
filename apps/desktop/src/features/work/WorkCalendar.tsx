import { useMemo, useState } from 'react';
import { workDatePart } from '@waypoint/domain-services';
import { Button } from '../../shared/components/Button';
import type { WorkTaskRecord } from '../../shared/work-tasks-ipc';
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
export function WorkCalendar({ tasks }: { tasks: WorkTaskRecord[] }) {
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
              {tasks.flatMap((task) => {
                const { start, end, deadline } = task.schedule;
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
                    key={task.id}
                    title={label}
                    aria-label={label}
                    onClick={() =>
                      openWorkTask({ workspaceRoot: task.project.root, taskId: task.id })
                    }
                    className="block w-full truncate rounded px-1 text-left text-[11px] text-fg hover:bg-bg-muted"
                  >
                    {label}
                  </button>,
                ];
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  workDateAt,
  type WorkOccurrence,
  type WorkOccurrenceAction,
  type WorkResolvedDate,
  type WorkTaskCommand,
} from '@waypoint/domain-services';
import { platform } from '../../platform';
import { Button } from '../../shared/components/Button';
import type { WorkTaskRecord } from '../../shared/work-tasks-ipc';
import { DateField, fieldClass } from './DateField';
import { dateDraft, describeDate, fieldDate } from './task-form';
import { observeWorkChanges } from './use-work-query';

function describe(field: WorkResolvedDate) {
  if (field.kind === 'resolved') return describeDate(field.value);
  return field.kind === 'missing' ? 'None' : 'Unresolved · ' + field.reason;
}

function monthBounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Choose a month.');
  const [year, number] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: month + '-01', through: month + '-' + end };
}

function moveDate(field: WorkResolvedDate) {
  return dateDraft(field.kind === 'resolved' ? { kind: 'fixed', value: field.value } : null);
}

function MoveOccurrence({
  item,
  editable,
  apply,
  cancel,
}: {
  item: WorkOccurrence;
  editable: boolean;
  apply(action: WorkOccurrenceAction): void;
  cancel(): void;
}) {
  const [start, setStart] = useState(() => moveDate(item.schedule.start));
  const [end, setEnd] = useState(() => moveDate(item.schedule.end));
  const [due, setDue] = useState(() => moveDate(item.schedule.deadline));
  const [error, setError] = useState('');
  return (
    <fieldset className="space-y-2 rounded border border-border bg-bg p-2" disabled={!editable}>
      <legend className="px-1 text-xs font-medium">Move this occurrence</legend>
      <DateField label="Occurrence plan" value={start} change={setStart} />
      <DateField label="Occurrence planned end" value={end} change={setEnd} />
      <DateField label="Occurrence due" value={due} change={setDue} />
      <p className="text-xs text-fg-muted">These dates replace the schedule for this occurrence.</p>
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <Button
        type="button"
        size="xs"
        variant="secondary"
        onClick={() => {
          try {
            const from = fieldDate(start),
              through = fieldDate(end);
            if (through && !from) throw new Error('Set a planned start before adding an end.');
            apply({
              kind: 'move',
              plan: from ? { start: from, ...(through ? { end: through } : {}) } : null,
              deadline: fieldDate(due),
            });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Invalid occurrence dates.');
          }
        }}
      >
        Save occurrence
      </Button>{' '}
      <Button type="button" size="xs" variant="ghost" onClick={cancel}>
        Cancel move
      </Button>
    </fieldset>
  );
}

export function OccurrencePanel({
  record,
  initialSlot,
  acceptedMove,
  editable,
  submit,
}: {
  record: WorkTaskRecord;
  initialSlot?: string;
  acceptedMove: { slot: string; operationId: string } | null;
  editable: boolean;
  submit(command: WorkTaskCommand): void;
}) {
  const [open, setOpen] = useState(Boolean(initialSlot));
  const [month, setMonth] = useState(
    () =>
      initialSlot?.slice(0, 7) ??
      workDateAt(Date.now(), record.document.recurrence?.anchor.zone ?? 'UTC').slice(0, 7)
  );
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<WorkOccurrence[] | null>(null);
  const [error, setError] = useState('');
  const [move, setMove] = useState<{ item: WorkOccurrence; revision: string } | null>(null);
  useEffect(() => {
    if (acceptedMove)
      setMove((current) => (current?.item.slot === acceptedMove.slot ? null : current));
  }, [acceptedMove]);
  useEffect(() => (open ? observeWorkChanges(() => setRefresh((n) => n + 1)) : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setItems(null);
    setError('');
    async function load() {
      try {
        const result = await platform().workTasks.occurrences({
          workspaceRoot: record.project.root,
          taskId: record.id,
          ...monthBounds(month),
        });
        if (active) setItems(result);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Occurrences unavailable.');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [open, month, refresh, record.revisionId, record.id, record.project.root]);
  const staleMove = move && move.revision !== record.revisionId;
  const latest = items?.find((item) => item.slot === move?.item.slot);

  return (
    <details
      open={open}
      className="space-y-2 text-xs"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">Occurrences</summary>
      {open && (
        <>
          <label className="block text-xs">
            Occurrence month
            <input
              disabled={!!move}
              type="month"
              className={fieldClass}
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setMove(null);
              }}
            />
          </label>
          {error ? (
            <div role="alert">
              {error}{' '}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setRefresh((n) => n + 1)}
              >
                Retry occurrences
              </Button>
            </div>
          ) : items === null ? (
            <p role="status">Loading occurrences…</p>
          ) : !items.length ? (
            <p>No occurrences this month.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {items.map((item) => {
                const action = (command: WorkOccurrenceAction) =>
                  submit({ kind: 'occurrence', slot: item.slot, action: command });
                const terminal = item.status === 'done' || item.status === 'canceled';
                const unresolved = Object.values(item.schedule).some(
                  (field) => field.kind === 'unresolved'
                );
                return (
                  <li
                    key={item.slot}
                    className={
                      'space-y-1 border-b border-border py-2' +
                      (item.slot === initialSlot ? ' bg-bg-subtle' : '')
                    }
                  >
                    <p className="font-medium">
                      {item.slot} ·{' '}
                      {
                        {
                          todo: 'To do',
                          'in-progress': 'In progress',
                          skipped: 'Skipped',
                          done: 'Done',
                          canceled: 'Canceled',
                        }[item.status]
                      }
                    </p>
                    <p className="text-fg-muted">
                      Plan {describe(item.schedule.start)} · Due {describe(item.schedule.deadline)}
                    </p>
                    {editable && !move && (
                      <div className="flex flex-wrap gap-1">
                        {item.status === 'skipped' ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => action({ kind: 'restore' })}
                          >
                            Restore occurrence
                          </Button>
                        ) : terminal ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => action({ kind: 'reopen' })}
                          >
                            Reopen occurrence
                          </Button>
                        ) : (
                          <>
                            <Button
                              type="button"
                              size="xs"
                              variant="secondary"
                              onClick={() => action({ kind: 'complete' })}
                            >
                              Complete occurrence
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={unresolved}
                              onClick={() => setMove({ item, revision: record.revisionId })}
                            >
                              Move
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              onClick={() => action({ kind: 'skip' })}
                            >
                              Skip
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {move && (
        <MoveOccurrence
          key={move.item.slot + move.revision}
          item={move.item}
          editable={editable && !staleMove}
          apply={(action) => submit({ kind: 'occurrence', slot: move.item.slot, action })}
          cancel={() => setMove(null)}
        />
      )}
      {staleMove && (
        <div role="status" className="space-x-2">
          <p>The series changed while you were moving this occurrence.</p>
          {latest && (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => setMove({ item: latest, revision: record.revisionId })}
            >
              Load current dates
            </Button>
          )}
          <Button type="button" variant="ghost" size="xs" onClick={() => setMove(null)}>
            Discard move
          </Button>
        </div>
      )}
    </details>
  );
}

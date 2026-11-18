import { useId } from 'react';
import { workTimeFromInput } from '@waypoint/domain-services';
import type { DateDraft } from './task-form';

export const fieldClass =
  'w-full min-w-0 rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none';

export function DateField({
  label,
  value,
  change,
}: {
  label: string;
  value: DateDraft;
  change(value: DateDraft): void;
}) {
  const id = useId();
  const update = (patch: Partial<DateDraft>) =>
    change({ ...value, retained: undefined, fold: '', ...patch });
  let ambiguous = false;
  if (value.date && value.time && value.zone) {
    const input = {
      kind: 'timed',
      local: value.date + 'T' + value.time,
      zone: value.zone,
    } as const;
    try {
      const first = workTimeFromInput({ ...input, fold: 'earlier' });
      const last = workTimeFromInput({ ...input, fold: 'later' });
      ambiguous = first.kind === 'timed' && last.kind === 'timed' && first.instant !== last.instant;
    } catch {
      ambiguous = false;
    }
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        type="date"
        className={fieldClass}
        value={value.date}
        onChange={(e) => update({ date: e.target.value, ...(!e.target.value ? { time: '' } : {}) })}
      />
      {value.date && (
        <details open={value.time ? true : undefined}>
          <summary className="cursor-pointer text-xs text-fg-muted">Time and zone</summary>
          <label className="mt-2 block text-xs text-fg-muted">
            Time{' '}
            <input
              aria-label={label + ' time'}
              type="time"
              step="any"
              className={fieldClass}
              value={value.time}
              onChange={(e) => update({ time: e.target.value })}
            />
          </label>
          <label className="mt-1 block text-xs text-fg-muted">
            Time zone{' '}
            <input
              aria-label={label + ' time zone'}
              className={fieldClass}
              value={value.zone}
              onChange={(e) => update({ zone: e.target.value })}
            />
          </label>
          {ambiguous && (
            <label className="mt-1 block text-xs">
              This time occurs twice
              <select
                aria-label={label + ' clock change'}
                className={fieldClass}
                value={value.fold}
                onChange={(e) => update({ fold: e.target.value as DateDraft['fold'] })}
              >
                <option value="">Choose occurrence</option>
                <option value="earlier">First occurrence</option>
                <option value="later">Second occurrence</option>
              </select>
            </label>
          )}
        </details>
      )}
      {value.retained && (
        <p className="text-xs text-fg-muted">
          This saved time uses earlier time-zone rules. Editing it applies current rules.
        </p>
      )}
    </div>
  );
}

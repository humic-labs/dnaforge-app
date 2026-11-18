import type { WorkRecurrence } from '@waypoint/domain-services';
import { DateField, fieldClass } from './DateField';
import { dateDraft, type DateDraft, type RecurrenceDraft } from './task-form';

export function RecurrenceEditor({
  value,
  change,
  start,
  saved,
}: {
  value: RecurrenceDraft;
  change(value: RecurrenceDraft): void;
  start: DateDraft;
  saved: WorkRecurrence | null;
}) {
  const patch = (changes: Partial<RecurrenceDraft>) => change({ ...value, ...changes });
  const ended = saved?.state === 'ended';
  return (
    <fieldset className="space-y-2 rounded border border-border px-3 pb-3" disabled={ended}>
      <legend className="px-1 text-xs font-medium">Repeat</legend>
      <select
        aria-label="Repeat frequency"
        className={fieldClass}
        value={value.frequency}
        onChange={(e) => {
          const frequency = e.target.value as RecurrenceDraft['frequency'];
          patch({
            frequency,
            ...(!value.frequency && !value.anchor.date
              ? { anchor: start.date && !start.relative ? { ...start } : dateDraft() }
              : {}),
          });
        }}
      >
        {!saved && <option value="">Does not repeat</option>}
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      {value.frequency && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs">
              Repeat every
              <input
                type="number"
                min="1"
                max="1000"
                className={fieldClass}
                aria-label="Repeat interval"
                value={value.interval}
                onChange={(e) => patch({ interval: e.target.value })}
              />
              <span className="text-fg-muted">
                {{ daily: 'days', weekly: 'weeks', monthly: 'months' }[value.frequency]}
              </span>
            </label>
            <DateField
              label="First occurrence"
              value={value.anchor}
              change={(anchor) => patch({ anchor, ...(anchor.fold ? { fold: anchor.fold } : {}) })}
            />
          </div>
          {value.anchor.time && (
            <label className="block text-xs">
              When the clock repeats an hour
              <select
                className={fieldClass}
                value={value.fold}
                onChange={(e) => patch({ fold: e.target.value as RecurrenceDraft['fold'] })}
              >
                <option value="">Choose occurrence</option>
                <option value="earlier">First occurrence</option>
                <option value="later">Second occurrence</option>
              </select>
            </label>
          )}
          {value.frequency === 'weekly' && (
            <fieldset className="flex flex-wrap gap-2">
              <legend className="text-xs">Days of the week</legend>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => (
                <label key={label} className="inline-flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={value.weekdays.includes(i + 1)}
                    onChange={(e) =>
                      patch({
                        weekdays: e.target.checked
                          ? [...value.weekdays, i + 1].sort((a, b) => a - b)
                          : value.weekdays.filter((day) => day !== i + 1),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
              {!value.weekdays.length && (
                <span className="text-xs text-fg-muted">Uses the first occurrence’s weekday.</span>
              )}
            </fieldset>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs">
              Last date <span className="text-fg-muted">(optional)</span>
              <input
                aria-label="Series last date"
                type="date"
                min={value.anchor.date}
                className={fieldClass}
                value={value.until}
                onChange={(e) => patch({ until: e.target.value })}
              />
            </label>
            <label className="text-xs">
              Occurrence limit <span className="text-fg-muted">(optional)</span>
              <input
                aria-label="Occurrence limit"
                type="number"
                min="1"
                max="10000"
                className={fieldClass}
                value={value.count}
                onChange={(e) => patch({ count: e.target.value })}
              />
            </label>
          </div>
          {saved && (
            <label className="block text-xs">
              Series status
              <select
                className={fieldClass}
                value={value.state}
                onChange={(e) => patch({ state: e.target.value as RecurrenceDraft['state'] })}
              >
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="ended">Ended</option>
              </select>
            </label>
          )}
          {value.state === 'ended' && (
            <p className="text-xs text-fg-muted">
              Ending this series permanently stops future repeats.
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}

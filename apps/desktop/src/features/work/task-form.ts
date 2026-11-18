import {
  workTimeFromInput,
  type WorkDateSpec,
  type WorkTaskFields,
  type WorkRecurrence,
  type WorkTime,
} from '@waypoint/domain-services';
import type { WorkTaskRecord } from '../../shared/work-tasks-ipc';

export interface DateDraft {
  date: string;
  time: string;
  zone: string;
  fold: '' | 'earlier' | 'later';
  relative?: Extract<WorkDateSpec, { kind: 'relative' }>;
}

export function dateDraft(spec?: WorkDateSpec | null): DateDraft {
  const value = spec?.kind === 'fixed' ? spec.value : null;
  const zone = value?.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = value?.kind === 'day' ? value.date : (value?.local.slice(0, 10) ?? '');
  const time = value?.kind === 'timed' ? value.local.slice(11) : '';
  let fold: DateDraft['fold'] = '';
  if (value?.kind === 'timed') {
    const input = { kind: 'timed', local: value.local, zone } as const;
    const first = workTimeFromInput({ ...input, fold: 'earlier' });
    const last = workTimeFromInput({ ...input, fold: 'later' });
    if (first.kind === 'timed' && last.kind === 'timed' && first.instant !== last.instant) {
      fold = value.instant === first.instant ? 'earlier' : 'later';
    }
  }
  return { date, time, zone, fold, ...(spec?.kind === 'relative' ? { relative: spec } : {}) };
}

export function fieldDate(draft: DateDraft): WorkDateSpec | null {
  if (draft.relative) return draft.relative;
  if (!draft.date && !draft.time) return null;
  const value = workTimeFromInput(
    draft.time
      ? {
          kind: 'timed',
          local: draft.date + 'T' + draft.time,
          zone: draft.zone,
          ...(draft.fold ? { fold: draft.fold } : {}),
        }
      : { kind: 'day', date: draft.date, zone: draft.zone }
  );
  return { kind: 'fixed', value };
}

export function describeDate(value: WorkTime) {
  const day = value.kind === 'day' ? value.date : value.local.slice(0, 10);
  const label = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(day + 'T12:00:00Z'));
  return value.kind === 'day' ? label : label + ' · ' + value.local.slice(11) + ' ' + value.zone;
}

export function taskDraft(task: WorkTaskRecord | null) {
  const doc = task?.document;
  return {
    name: doc?.name ?? '',
    description: doc?.description ?? '',
    assignee: doc?.assignee ?? null,
    start: dateDraft(doc?.plan?.start),
    end: dateDraft(doc?.plan?.end),
    due: dateDraft(doc?.deadline),
    recurrence: recurrenceDraft(doc?.recurrence),
  };
}

export type TaskDraft = ReturnType<typeof taskDraft>;

export function changedTaskFields(draft: TaskDraft, original: TaskDraft): WorkTaskFields {
  const fields: WorkTaskFields = {};
  if (draft.name !== original.name) fields.name = draft.name.trim();
  if (draft.description !== original.description) fields.description = draft.description;
  if (
    draft.assignee?.id !== original.assignee?.id ||
    draft.assignee?.kind !== original.assignee?.kind
  )
    fields.assignee = draft.assignee;
  if (
    JSON.stringify(draft.start) !== JSON.stringify(original.start) ||
    JSON.stringify(draft.end) !== JSON.stringify(original.end)
  ) {
    const start = fieldDate(draft.start),
      end = fieldDate(draft.end);
    if (end && !start) throw new Error('Set a planned start before adding an end.');
    fields.plan = start ? { start, ...(end ? { end } : {}) } : null;
  }
  if (JSON.stringify(draft.due) !== JSON.stringify(original.due))
    fields.deadline = fieldDate(draft.due);
  if (JSON.stringify(draft.recurrence) !== JSON.stringify(original.recurrence))
    fields.recurrence = buildRecurrence(draft.recurrence);
  return fields;
}

export interface RecurrenceDraft {
  frequency: WorkRecurrence['frequency'] | '';
  interval: string;
  anchor: DateDraft;
  weekdays: number[];
  count: string;
  until: string;
  fold: '' | 'earlier' | 'later';
  state: WorkRecurrence['state'];
  excludedSlots?: readonly string[];
}

export function recurrenceDraft(rule?: WorkRecurrence | null): RecurrenceDraft {
  return {
    frequency: rule?.frequency ?? '',
    interval: String(rule?.interval ?? 1),
    anchor: dateDraft(rule ? { kind: 'fixed', value: rule.anchor } : null),
    weekdays: [...(rule?.weekdays ?? [])],
    count: rule?.count ? String(rule.count) : '',
    until: rule?.until ?? '',
    fold: rule?.fold ?? '',
    state: rule?.state ?? 'active',
    ...(rule?.excludedSlots ? { excludedSlots: rule.excludedSlots } : {}),
  };
}

function boundedInteger(input: string, max: number, label: string) {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(label + ' must be between 1 and ' + max + '.');
  return value;
}

export function buildRecurrence(rule: RecurrenceDraft): WorkRecurrence | null {
  if (!rule.frequency) return null;
  const anchor = fieldDate(rule.anchor);
  if (anchor?.kind !== 'fixed') throw new Error('Set a first occurrence date.');
  if (anchor.value.kind === 'timed' && !rule.fold)
    throw new Error('Choose the first or second hour for repeated clock times.');
  if (rule.until && rule.until < rule.anchor.date)
    throw new Error('End the series on or after its first occurrence.');
  return {
    frequency: rule.frequency,
    interval: boundedInteger(rule.interval, 1000, 'Repeat interval'),
    anchor: anchor.value,
    state: rule.state,
    fold: rule.fold || 'earlier',
    ...(rule.count ? { count: boundedInteger(rule.count, 10000, 'Occurrence count') } : {}),
    ...(rule.until ? { until: rule.until } : {}),
    ...(rule.excludedSlots ? { excludedSlots: rule.excludedSlots } : {}),
    ...(rule.frequency === 'weekly' && rule.weekdays.length ? { weekdays: rule.weekdays } : {}),
  };
}

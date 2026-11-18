import {
  fromAbsolute,
  parseDate,
  parseDateTime,
  toCalendarDate,
  toCalendarDateTime,
  toZoned,
  type CalendarDate,
} from '@internationalized/date';
import type {
  WorkDateSpec,
  WorkDueStatus,
  WorkOffset,
  WorkPlan,
  WorkResolvedDate,
  WorkSchedule,
  WorkSource,
  WorkSourceReader,
  WorkStatus,
  WorkTime,
  WorkTimeInput,
} from './work-task-types';

export function calendarDay(text: string): CalendarDate {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError('Enter a calendar date in YYYY-MM-DD format.');
  }
  const day = parseDate(text);
  if (day.year < 1 || day.toString() !== text) throw new TypeError('Invalid calendar day.');
  return day;
}

export function workTimeFromInput(input: WorkTimeInput): WorkTime {
  if (!input || typeof input.zone !== 'string' || !input.zone.trim() || /^[+-]/.test(input.zone)) {
    throw new TypeError('Choose a named time zone.');
  }
  new Intl.DateTimeFormat('en', { timeZone: input.zone });
  if (input.kind === 'day') {
    const day = calendarDay(input.date);
    if (toCalendarDate(toZoned(day, input.zone)).compare(day) !== 0) {
      throw new RangeError('This date does not occur in the selected time zone.');
    }
    return { kind: 'day', date: input.date, zone: input.zone };
  }
  if (
    input.kind !== 'timed' ||
    typeof input.local !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d(:\d\d(\.\d{1,3})?)?$/.test(input.local)
  ) {
    throw new TypeError('Enter a local date and time.');
  }
  calendarDay(input.local.slice(0, 10));
  const local = parseDateTime(input.local);
  if (input.fold !== undefined && input.fold !== 'earlier' && input.fold !== 'later') {
    throw new TypeError('Invalid choice for repeated local time.');
  }
  const earlier = toZoned(local, input.zone, 'earlier');
  const later = toZoned(local, input.zone, 'later');
  if (toCalendarDateTime(earlier).compare(local) !== 0) {
    throw new RangeError(
      'This local time does not exist. Choose a time before or after the change.'
    );
  }
  if (earlier.compare(later) !== 0 && input.fold === undefined) {
    throw new RangeError('This local time occurs twice. Select the earlier or later occurrence.');
  }
  return {
    kind: 'timed',
    local: local.toString(),
    zone: input.zone,
    instant: (input.fold === 'later' ? later : earlier).toDate().getTime(),
  };
}

export function parseWorkTime(value: unknown): WorkTime {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid saved date.');
  const v = value as Record<string, unknown>;
  const keys = v.kind === 'day' ? ['kind', 'date', 'zone'] : ['kind', 'local', 'zone', 'instant'];
  if (
    Object.keys(v).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(v, key))
  )
    throw new TypeError('Invalid saved date fields.');
  if (v.kind === 'day') return workTimeFromInput(v as WorkTimeInput);
  if (
    v.kind !== 'timed' ||
    typeof v.zone !== 'string' ||
    !v.zone.trim() ||
    /^[+-]/u.test(v.zone) ||
    typeof v.local !== 'string' ||
    typeof v.instant !== 'number' ||
    !Number.isSafeInteger(v.instant) ||
    !Number.isFinite(new Date(v.instant).getTime())
  )
    throw new TypeError('Invalid saved time.');
  new Intl.DateTimeFormat('en', { timeZone: v.zone });
  const wall = workTimeFromInput({ kind: 'timed', local: v.local, zone: 'UTC' });
  if (wall.kind !== 'timed') throw new TypeError('Expected a timed value.');
  const offset = wall.instant - v.instant;
  if (Math.abs(offset) >= 86_400_000 || offset % 1000 !== 0)
    throw new TypeError('Invalid saved UTC offset.');
  return { kind: 'timed', local: wall.local, zone: v.zone, instant: v.instant };
}

export function workDateAt(instant: number, zone: string): string {
  return toCalendarDate(fromAbsolute(instant, zone)).toString();
}

export function workDatePart(value: WorkTime): string {
  return value.kind === 'day' ? value.date : value.local.slice(0, 10);
}

export function workTimeStart(value: WorkTime): number {
  return value.kind === 'timed'
    ? value.instant
    : toZoned(calendarDay(value.date), value.zone).toDate().getTime();
}

export function deadlineBoundary(value: WorkTime): number {
  return value.kind === 'timed'
    ? value.instant
    : toZoned(calendarDay(value.date).add({ days: 1 }), value.zone)
        .toDate()
        .getTime();
}

export function pastWorkDeadline(value: WorkTime, instant: number): boolean {
  const boundary = deadlineBoundary(value);
  return value.kind === 'day' ? instant >= boundary : instant > boundary;
}

export function evaluateWorkDueStatus(
  status: WorkStatus,
  deadline: WorkResolvedDate,
  now: number
): WorkDueStatus {
  if (status === 'done' || status === 'canceled') return 'terminal';
  if (deadline.kind === 'missing') return 'unscheduled';
  if (deadline.kind === 'unresolved') return 'unresolved';
  if (pastWorkDeadline(deadline.value, now)) return 'overdue';
  return workDateAt(now, deadline.value.zone) === workDatePart(deadline.value)
    ? 'today'
    : 'upcoming';
}

export function offsetWorkTime(
  value: WorkTime,
  offset: WorkOffset,
  fold?: 'earlier' | 'later'
): WorkTime {
  if (!Number.isSafeInteger(offset.amount)) throw new TypeError('Invalid work date offset.');
  if (offset.unit === 'milliseconds') {
    if (value.kind !== 'timed') throw new TypeError('An elapsed offset requires a timed source.');
    const instant = value.instant + offset.amount;
    if (!Number.isSafeInteger(instant) || !Number.isFinite(new Date(instant).getTime())) {
      throw new RangeError('Work date offset exceeds the supported instant range.');
    }
    const local = toCalendarDateTime(fromAbsolute(instant, value.zone)).toString();
    calendarDay(local.slice(0, 10));
    return { kind: 'timed', zone: value.zone, instant, local };
  }
  if (offset.unit !== 'days') throw new TypeError('Invalid work date offset unit.');
  if (offset.amount === 0) return value;
  const original = calendarDay(workDatePart(value));
  const date = original.add({ days: offset.amount });
  if (date.compare(original) !== offset.amount)
    throw new RangeError('Work date offset exceeds supported dates.');
  if (value.kind === 'day')
    return workTimeFromInput({ kind: 'day', date: date.toString(), zone: value.zone });
  return workTimeFromInput({
    kind: 'timed',
    local: date.toString() + value.local.slice(10),
    zone: value.zone,
    ...(fold ? { fold } : {}),
  });
}

export function resolveWorkDate(
  spec: WorkDateSpec | null,
  read?: WorkSourceReader
): WorkResolvedDate {
  if (!spec) return { kind: 'missing' };
  const seen = new Set<string>();
  const sources: WorkSource[] = [];
  const offsets: WorkOffset[] = [];
  let cursor = spec;
  while (cursor.kind === 'relative') {
    if (!read) return { kind: 'unresolved', reason: 'unavailable' };
    const source = cursor.source;
    const identity = JSON.stringify([
      source.projectId,
      source.resourceId,
      source.role,
      source.revisionId ?? null,
    ]);
    if (seen.has(identity)) return { kind: 'unresolved', reason: 'cycle' };
    if (seen.size >= 64) return { kind: 'unresolved', reason: 'depth' };
    seen.add(identity);
    const state = read(source);
    if (state.kind !== 'resolved') return { kind: 'unresolved', reason: state.kind };
    if (!state.revisionId || (source.revisionId && state.revisionId !== source.revisionId)) {
      return { kind: 'unresolved', reason: 'source-revision' };
    }
    sources.push({ ...source, revisionId: state.revisionId });
    offsets.push(cursor.offset);
    cursor = state.spec;
  }
  let value = cursor.value;
  try {
    for (const offset of offsets.reverse()) value = offsetWorkTime(value, offset);
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
    return { kind: 'unresolved', reason: 'incompatible-offset' };
  }
  return { kind: 'resolved', value, sources };
}

export function resolveWorkSchedule(
  task: { plan: WorkPlan | null; deadline: WorkDateSpec | null },
  readSource?: WorkSourceReader
): WorkSchedule {
  const start = resolveWorkDate(task.plan?.start ?? null, readSource);
  let end = resolveWorkDate(task.plan?.end ?? null, readSource);
  if (
    start.kind === 'resolved' &&
    end.kind === 'resolved' &&
    (start.value.kind !== end.value.kind || workTimeStart(end.value) <= workTimeStart(start.value))
  ) {
    end = { kind: 'unresolved', reason: 'invalid-interval' };
  }
  return { start, end, deadline: resolveWorkDate(task.deadline, readSource) };
}

export type LegacyWorkDate =
  | { kind: 'missing' }
  | { kind: 'exact'; raw: string; value: WorkTime }
  | { kind: 'partial'; raw: string; precision: 'month' | 'year' }
  | { kind: 'unresolved'; raw: unknown };

export function classifyLegacyWorkDate(raw: unknown, zone: string): LegacyWorkDate {
  if (raw === null || raw === undefined || raw === '') return { kind: 'missing' };
  if (typeof raw !== 'string') return { kind: 'unresolved', raw };
  if (/^(?!0000)\d{4}(-(0[1-9]|1[0-2]))?$/.test(raw)) {
    return { kind: 'partial', raw, precision: raw.length === 4 ? 'year' : 'month' };
  }
  try {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      calendarDay(raw.slice(0, 10));
      parseDateTime(raw.replace(/(Z|[+-]\d{2}:\d{2})$/, ''));
      const instant = Date.parse(raw);
      if (!Number.isSafeInteger(instant)) return { kind: 'unresolved', raw };
      const point = fromAbsolute(instant, 'UTC');
      return {
        kind: 'exact',
        raw,
        value: {
          kind: 'timed',
          local: toCalendarDateTime(point).toString(),
          zone: 'UTC',
          instant,
        },
      };
    }
    return { kind: 'exact', raw, value: workTimeFromInput({ kind: 'day', date: raw, zone }) };
  } catch {
    return { kind: 'unresolved', raw };
  }
}

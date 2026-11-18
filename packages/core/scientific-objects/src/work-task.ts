import { canonicalPayload } from './json';
import { fromAbsolute, getDayOfWeek, toCalendarDateTime } from '@internationalized/date';
import {
  calendarDay,
  evaluateWorkDueStatus,
  offsetWorkTime,
  parseWorkTime as time,
  resolveWorkSchedule,
  workDateAt,
  workDatePart,
  workTimeFromInput,
  workTimeStart,
} from './work-time';
import type {
  WorkAssignee,
  WorkCancellation,
  WorkCompletion,
  WorkDateSpec,
  WorkLink,
  WorkOccurrence,
  WorkPlan,
  WorkRecurrence,
  WorkResolvedDate,
  WorkSchedule,
  WorkSource,
  WorkSourceReader,
  WorkStatus,
  WorkTaskCommand,
  WorkTaskContext,
  WorkTaskDocument,
  WorkTaskFields,
  WorkTime,
} from './work-task-types';

function reject(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, required: string, optional = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    reject('Expected a work record.');
  const fields = value as Record<string, unknown>;
  const requiredKeys = required.split(' ').filter(Boolean);
  const allowed = new Set([...requiredKeys, ...optional.split(' ').filter(Boolean)]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(fields, key)) ||
    Object.keys(fields).some((key) => !allowed.has(key))
  )
    reject('Unknown or missing work record fields.');
  return fields;
}

function string(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) reject('Expected work record text.');
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    reject('Expected a finite work record integer.');
  return value;
}

function instant(value: unknown): number {
  const number = integer(value);
  if (!Number.isFinite(new Date(number).getTime())) reject('Invalid work timestamp.');
  return number;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) reject('Expected a work record list.');
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.some((v) => v === value)) reject('Unsupported work record value.');
  return value as T;
}

function link(value: unknown): WorkLink {
  const v = record(value, 'projectId resourceId', 'role revisionId');
  return {
    projectId: string(v.projectId),
    resourceId: string(v.resourceId),
    ...(Object.hasOwn(v, 'role') ? { role: string(v.role) } : {}),
    ...(Object.hasOwn(v, 'revisionId') ? { revisionId: string(v.revisionId) } : {}),
  };
}

function dateSource(value: unknown): WorkSource {
  const { zone, ...reference } = record(value, 'projectId resourceId role', 'revisionId zone');
  const parsed = link(reference);
  if (zone !== undefined) {
    if (typeof zone !== 'string' || !zone.trim() || /^[+-]/u.test(zone))
      reject('Choose a named source time zone.');
    new Intl.DateTimeFormat('en', { timeZone: zone });
  }
  return { ...parsed, role: string(parsed.role), ...(zone === undefined ? {} : { zone }) };
}

function spec(value: unknown): WorkDateSpec {
  if ((value as { kind?: string } | null)?.kind === 'fixed') {
    return { kind: 'fixed', value: time(record(value, 'kind value').value) };
  }
  const v = record(value, 'kind source offset');
  oneOf(v.kind, ['relative']);
  const source = dateSource(v.source);
  const offset = record(v.offset, 'unit amount');
  return {
    kind: 'relative',
    source,
    offset: { unit: oneOf(offset.unit, ['days', 'milliseconds']), amount: integer(offset.amount) },
  };
}

function plan(value: unknown): WorkPlan | null {
  if (value === null) return null;
  const v = record(value, 'start', 'end');
  const p = { start: spec(v.start), ...(Object.hasOwn(v, 'end') ? { end: spec(v.end) } : {}) };
  if (
    p.end?.kind === 'fixed' &&
    p.start.kind === 'fixed' &&
    (p.end.value.kind !== p.start.value.kind ||
      workTimeStart(p.end.value) <= workTimeStart(p.start.value))
  ) {
    reject('A planned interval must end after its start at the same precision.');
  }
  return p;
}

function assignee(value: unknown): WorkAssignee | null {
  if (value === null) return null;
  const v = record(value, 'kind id');
  return { kind: oneOf(v.kind, ['member', 'local']), id: string(v.id) };
}

function recurrence(value: unknown): WorkRecurrence | null {
  if (value === null) return null;
  const v = record(
    value,
    'frequency interval anchor fold state',
    'count until weekdays excludedSlots pauses'
  );
  const excludedSlots =
    v.excludedSlots === undefined
      ? undefined
      : [
          ...new Set(list(v.excludedSlots).map((slot) => calendarDay(string(slot)).toString())),
        ].sort();
  const pauses =
    v.pauses === undefined
      ? undefined
      : list(v.pauses).map((raw) => {
          const range = record(raw, 'start end');
          const start = instant(range.start);
          const end = range.end === null ? null : instant(range.end);
          if (end !== null && end < start) reject('Pause ends before it starts.');
          return { start, end };
        });
  if (
    pauses?.some((p, i) => i > 0 && (pauses[i - 1].end === null || p.start < pauses[i - 1].end!)) ||
    (pauses?.at(-1)?.end === null && v.state === 'active')
  )
    reject('Invalid series pause history.');
  const frequency = oneOf(v.frequency, ['daily', 'weekly', 'monthly'] as const);
  const interval = integer(v.interval),
    anchor = time(v.anchor);
  if (interval < 1 || interval > 1000) reject('Recurrence interval must be between 1 and 1000.');
  const count = v.count === undefined ? null : integer(v.count);
  if (count !== null && (count < 1 || count > 10000))
    reject('Recurrence count must be from 1 to 10000.');
  const until = v.until === undefined ? null : calendarDay(string(v.until)).toString();
  if (until && until < workDatePart(anchor)) reject('Series cannot end before its anchor.');
  const weekdays = v.weekdays === undefined ? null : list(v.weekdays).map(integer);
  if (
    weekdays &&
    (frequency !== 'weekly' ||
      weekdays.length === 0 ||
      weekdays.some((d) => d < 1 || d > 7) ||
      new Set(weekdays).size !== weekdays.length)
  ) {
    reject('Select distinct ISO weekdays 1 to 7 for a weekly repeat.');
  }
  return {
    frequency,
    interval,
    anchor,
    fold: oneOf(v.fold, ['earlier', 'later']),
    state: oneOf(v.state, ['active', 'paused', 'ended']),
    ...(count ? { count } : {}),
    ...(excludedSlots ? { excludedSlots } : {}),
    ...(pauses ? { pauses } : {}),
    ...(until ? { until } : {}),
    ...(weekdays ? { weekdays: weekdays.sort((a, b) => a - b) } : {}),
  };
}

const statuses = ['todo', 'in-progress', 'done', 'canceled'] as const;

function resolved(value: unknown): WorkResolvedDate {
  const kind = (value as { kind?: string } | null)?.kind;
  if (kind === 'missing') {
    record(value, 'kind');
    return { kind };
  }
  if (kind === 'unresolved') return { kind, reason: string(record(value, 'kind reason').reason) };
  const v = record(value, 'kind value sources');
  oneOf(v.kind, ['resolved']);
  return {
    kind: 'resolved',
    value: time(v.value),
    sources: list(v.sources).map((raw) => {
      const source = dateSource(raw);
      return { ...source, role: string(source.role), revisionId: string(source.revisionId) };
    }),
  };
}

function schedule(value: unknown): WorkSchedule {
  const v = record(value, 'start end deadline');
  return { start: resolved(v.start), end: resolved(v.end), deadline: resolved(v.deadline) };
}

function completion(value: unknown): WorkCompletion | null {
  if (value === null) return null;
  const v = record(value, 'recordedAt actualAt reported actor assignee schedule evidence');
  const actualAt = instant(v.actualAt),
    recordedAt = instant(v.recordedAt);
  if (
    actualAt > recordedAt ||
    typeof v.reported !== 'boolean' ||
    (!v.reported && actualAt !== recordedAt)
  ) {
    reject('Invalid reported completion time.');
  }
  return {
    recordedAt,
    actualAt,
    reported: v.reported,
    actor: string(v.actor),
    assignee: assignee(v.assignee),
    schedule: schedule(v.schedule),
    evidence: list(v.evidence).map((pin) => {
      const target = link(pin);
      if (!target.revisionId) reject('Completion evidence requires an accepted revision.');
      return target;
    }),
  };
}

function cancellation(value: unknown): WorkCancellation | null {
  if (value === null) return null;
  const v = record(value, 'recordedAt actor reason');
  return {
    recordedAt: instant(v.recordedAt),
    actor: string(v.actor),
    reason: v.reason === null ? null : string(v.reason),
  };
}

function terminalState(status: WorkStatus | 'skipped', done: unknown, canceled: unknown) {
  if ((status === 'done') !== (done !== null) || (status === 'canceled') !== (canceled !== null)) {
    reject('Terminal state needs the matching saved event.');
  }
  return { completion: completion(done), cancellation: cancellation(canceled) };
}

function occurrence(value: unknown): WorkOccurrence {
  const v = record(
    value,
    'slot nominal status schedule assignee recurrence completion cancellation',
    'override'
  );
  const override = v.override === undefined ? null : record(v.override, 'plan deadline');
  const slot = calendarDay(string(v.slot)).toString(),
    nominal = time(v.nominal);
  if (workDatePart(nominal) !== slot) reject('Occurrence slot must identify its original date.');
  const status = oneOf(v.status, [...statuses, 'skipped'] as const);
  return {
    slot,
    nominal,
    status,
    schedule: schedule(v.schedule),
    ...(override
      ? {
          override: {
            plan: plan(override.plan),
            deadline: override.deadline === null ? null : spec(override.deadline),
          },
        }
      : {}),
    assignee: assignee(v.assignee),
    recurrence: recurrence(v.recurrence) ?? reject('Missing occurrence series.'),
    ...terminalState(status, v.completion, v.cancellation),
  };
}

export function parseWorkTaskDocument(value: unknown): WorkTaskDocument {
  const v = record(
    value,
    'formatVersion kind name description status assignee links plan deadline createdAt updatedAt createdBy updatedBy completion cancellation recurrence occurrences'
  );
  if (v.kind !== 'work-task' || v.formatVersion !== 1) reject('Unknown task format.');
  const status = oneOf(v.status, statuses);
  const occurrences = list(v.occurrences).map(occurrence);
  if (new Set(occurrences.map((o) => o.slot)).size !== occurrences.length)
    reject('Duplicate task occurrence slot.');
  const createdAt = instant(v.createdAt),
    updatedAt = instant(v.updatedAt);
  if (updatedAt < createdAt) reject('Task update precedes creation.');
  return {
    formatVersion: 1,
    kind: 'work-task',
    name: string(v.name),
    description: string(v.description, true),
    status,
    assignee: assignee(v.assignee),
    links: list(v.links).map(link),
    plan: plan(v.plan),
    deadline: v.deadline === null ? null : spec(v.deadline),
    createdAt,
    updatedAt,
    createdBy: string(v.createdBy),
    updatedBy: string(v.updatedBy),
    ...terminalState(status, v.completion, v.cancellation),
    recurrence: recurrence(v.recurrence),
    occurrences,
  };
}

function changes(command: WorkTaskFields, context: WorkTaskContext): WorkTaskFields {
  const result: WorkTaskFields = {};
  if (command.name !== undefined) result.name = string(command.name).trim();
  if (command.description !== undefined) result.description = string(command.description, true);
  if (command.links !== undefined) result.links = list(command.links).map(link);
  if (command.assignee !== undefined) {
    result.assignee = assignee(command.assignee);
    if (result.assignee && !context.canAssign?.(result.assignee))
      reject('Assignment requires an eligible principal.');
  }
  if (command.recurrence !== undefined) {
    const incoming = command.recurrence;
    result.recurrence = recurrence(
      incoming && incoming.pauses ? { ...incoming, pauses: [] } : incoming
    );
  }
  if (command.plan !== undefined) result.plan = plan(command.plan);
  if (command.deadline !== undefined)
    result.deadline = command.deadline === null ? null : spec(command.deadline);
  const activeTimes = [
    result.recurrence?.anchor,
    ...[result.plan?.start, result.plan?.end, result.deadline].flatMap((value) =>
      value?.kind === 'fixed' ? [value.value] : []
    ),
  ];
  for (const value of activeTimes) {
    if (
      value?.kind === 'timed' &&
      toCalendarDateTime(fromAbsolute(value.instant, value.zone)).toString() !== value.local
    )
      reject('The selected instant does not match its local time in the current time zone rules.');
  }
  for (const binding of [result.plan?.start, result.plan?.end, result.deadline]) {
    if (binding?.kind !== 'relative') continue;
    const resolution = resolveWorkSchedule(
      { plan: null, deadline: binding },
      context.readSource
    ).deadline;
    if (resolution.kind !== 'resolved')
      reject('A followed date must resolve before it can be attached.');
  }
  return result;
}

function isTerminal(status: WorkStatus | 'skipped'): boolean {
  return status === 'done' || status === 'canceled';
}

interface StatusChange {
  status: WorkStatus;
  completion: WorkCompletion | null;
  cancellation: WorkCancellation | null;
}

type StatusCommand = Extract<
  WorkTaskCommand,
  { kind: 'start' | 'todo' | 'reopen' | 'cancel' | 'complete' }
>;

function transition(
  status: WorkStatus,
  owner: WorkAssignee | null,
  command: StatusCommand,
  context: WorkTaskContext,
  currentSchedule: () => WorkSchedule
): StatusChange {
  const empty = { completion: null, cancellation: null };
  if (command.kind === 'reopen') {
    if (!isTerminal(status)) reject('Only completed or canceled work can be reopened.');
    return { ...empty, status: 'todo' };
  }
  if (isTerminal(status)) reject('Reopen terminal work before changing it.');
  switch (command.kind) {
    case 'start':
      if (status !== 'todo') reject('Work is already in progress.');
      return { ...empty, status: 'in-progress' };
    case 'todo':
      if (status !== 'in-progress') reject('Work is already to do.');
      return { ...empty, status: 'todo' };
    case 'cancel':
      return {
        ...empty,
        status: 'canceled',
        cancellation: {
          recordedAt: context.now,
          actor: context.actor,
          reason: command.reason === undefined ? null : string(command.reason),
        },
      };
    case 'complete':
      return {
        ...empty,
        status: 'done',
        completion: completion({
          recordedAt: context.now,
          actualAt: command.actualAt === undefined ? context.now : command.actualAt,
          reported: command.actualAt !== undefined,
          actor: context.actor,
          assignee: owner,
          schedule: currentSchedule(),
          evidence: command.evidence ?? [],
        }),
      };
  }
  return reject('Unknown task transition.');
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalPayload(left) === canonicalPayload(right);
}

function validateStatusCommandFields(command: { kind: string }): void {
  record(
    command,
    'kind',
    command.kind === 'complete' ? 'actualAt evidence' : command.kind === 'cancel' ? 'reason' : ''
  );
}

export function applyWorkTaskCommand(
  current: WorkTaskDocument | null,
  command: WorkTaskCommand,
  context: WorkTaskContext
): WorkTaskDocument {
  const writeFields = 'name description assignee links plan deadline recurrence';
  if (command.kind === 'create' || command.kind === 'edit') record(command, 'kind', writeFields);
  else if (command.kind === 'occurrence') {
    record(command, 'kind slot action');
    if (command.action.kind === 'move') record(command.action, 'kind plan deadline');
    else validateStatusCommandFields(command.action);
  } else validateStatusCommandFields(command);
  const now = instant(context.now);
  const actor = string(context.actor);
  if (command.kind === 'create') {
    if (current) reject('Task already exists.');
    return parseWorkTaskDocument({
      formatVersion: 1,
      kind: 'work-task',
      description: '',
      status: 'todo',
      plan: null,
      deadline: null,
      links: [],
      assignee: null,
      completion: null,
      cancellation: null,
      occurrences: [],
      recurrence: null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      updatedBy: actor,
      ...changes(command, context),
    });
  }
  if (!current) return reject('Work task is unavailable.');
  if (now < current.updatedAt) reject('Work command clock precedes the accepted revision.');
  let next: WorkTaskDocument;
  if (command.kind === 'edit') {
    if (isTerminal(current.status)) reject('Reopen terminal work before editing.');
    const edits = changes(command, context);
    const beforeRule = current.recurrence;
    const afterRule = edits.recurrence;
    if (beforeRule && afterRule && beforeRule.state !== afterRule.state) {
      const pauses = [...(beforeRule.pauses ?? [])];
      const last = pauses.at(-1);
      if (afterRule.state === 'active' && last?.end === null)
        pauses[pauses.length - 1] = { ...last, end: now };
      if (afterRule.state !== 'active' && last?.end !== null)
        pauses.push({ start: now, end: null });
      edits.recurrence = { ...afterRule, pauses };
    } else if (beforeRule?.pauses && afterRule) {
      edits.recurrence = { ...afterRule, pauses: beforeRule.pauses };
    }
    if (
      current.recurrence?.state === 'ended' &&
      edits.recurrence &&
      edits.recurrence.state !== 'ended'
    ) {
      reject('An ended series cannot be resumed.');
    }
    next = { ...current, ...edits };
  } else if (command.kind === 'occurrence') {
    if (isTerminal(current.status)) reject('Reopen the parent task before editing occurrences.');
    const revised = changeOccurrence(current, command.slot, command.action, context);
    next = {
      ...current,
      occurrences: [...current.occurrences.filter((o) => o.slot !== revised.slot), revised].sort(
        (a, b) => a.slot.localeCompare(b.slot)
      ),
    };
  } else {
    next = {
      ...current,
      ...transition(current.status, current.assignee, command, context, () =>
        resolveWorkSchedule(current, context.readSource)
      ),
    };
  }
  if (sameJson(next, current)) return current;
  return parseWorkTaskDocument({ ...next, updatedAt: now, updatedBy: actor });
}

function isoWeekday(day: ReturnType<typeof calendarDay>): number {
  return getDayOfWeek(day, 'en', 'mon') + 1;
}

function matchesSlot(
  rule: WorkRecurrence,
  day: ReturnType<typeof calendarDay>,
  anchor: ReturnType<typeof calendarDay>
): boolean {
  const distance = day.compare(anchor);
  if (distance < 0) return false;
  if (rule.frequency === 'daily') return distance % rule.interval === 0;
  if (rule.frequency === 'weekly') {
    const week = Math.floor((distance + isoWeekday(anchor) - 1) / 7);
    return (
      week % rule.interval === 0 &&
      (rule.weekdays ?? [isoWeekday(anchor)]).includes(isoWeekday(day))
    );
  }
  const months = 12 * (day.year - anchor.year) + day.month - anchor.month;
  return months % rule.interval === 0 && day.day === anchor.day;
}

function nominalSlots(rule: WorkRecurrence, from: string, through: string): Map<string, WorkTime> {
  const first = calendarDay(from),
    last = calendarDay(through);
  const width = last.compare(first);
  if (width < 0 || width > 3660) reject('Choose an occurrence range of at most ten years.');
  const anchor = calendarDay(workDatePart(rule.anchor));
  const result = new Map<string, WorkTime>();
  if (last.compare(anchor) < 0 || (rule.until && rule.until < from)) return result;
  let day = rule.count || first.compare(anchor) < 0 ? anchor : first;
  let emitted = 0;
  for (let scanned = 0; day.compare(last) <= 0; scanned++) {
    if (scanned > 100000) reject('Counted recurrence exceeds the supported expansion window.');
    const slot = day.toString();
    if ((rule.until && slot > rule.until) || (rule.count && emitted >= rule.count)) break;
    if (matchesSlot(rule, day, anchor)) {
      let nominal: WorkTime | null = null;
      try {
        nominal = offsetWorkTime(
          rule.anchor,
          { unit: 'days', amount: day.compare(anchor) },
          rule.fold
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      if (nominal) {
        emitted++;
        const startsAt = workTimeStart(nominal);
        if (
          slot >= from &&
          !rule.excludedSlots?.includes(slot) &&
          !rule.pauses?.some((p) => startsAt >= p.start && (p.end === null || startsAt < p.end))
        ) {
          result.set(slot, nominal);
        }
      }
    }
    if (day.compare(last) === 0) break;
    day = day.add({ days: 1 });
  }
  return result;
}

function shiftResolution(
  value: WorkResolvedDate,
  days: number,
  rule: WorkRecurrence
): WorkResolvedDate {
  if (value.kind !== 'resolved') return value;
  try {
    return {
      ...value,
      value: offsetWorkTime(value.value, { unit: 'days', amount: days }, rule.fold),
    };
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
    return { kind: 'unresolved', reason: 'occurrence-time' };
  }
}

function occurrenceAt(
  task: WorkTaskDocument,
  rule: WorkRecurrence,
  slot: string,
  nominal: WorkTime,
  base: WorkSchedule
): WorkOccurrence {
  const delta = calendarDay(slot).compare(calendarDay(workDatePart(rule.anchor)));
  const start =
    base.start.kind === 'missing'
      ? { kind: 'resolved' as const, value: nominal, sources: [] }
      : shiftResolution(base.start, delta, rule);
  return {
    slot,
    nominal,
    recurrence: rule,
    status: 'todo',
    completion: null,
    cancellation: null,
    assignee: task.assignee,
    schedule: {
      start,
      end: shiftResolution(base.end, delta, rule),
      deadline: shiftResolution(base.deadline, delta, rule),
    },
  };
}

function occurrenceTouches(instance: WorkOccurrence, from: string, through: string): boolean {
  const dates = [instance.schedule.start, instance.schedule.deadline].flatMap((field) =>
    field.kind === 'resolved' ? [workDatePart(field.value)] : []
  );
  return (dates.length ? dates : [instance.slot]).some((date) => date >= from && date <= through);
}

export function splitWorkSeries(
  task: WorkTaskDocument,
  firstSlot: string,
  replacement: WorkRecurrence,
  context: WorkTaskContext
): { previous: WorkTaskDocument; successor: WorkTaskDocument } {
  const rule = task.recurrence;
  const first = calendarDay(firstSlot);
  if (
    !rule ||
    rule.state !== 'active' ||
    !nominalSlots(rule, firstSlot, firstSlot).has(firstSlot) ||
    replacement.state !== 'active' ||
    workDatePart(replacement.anchor) < firstSlot
  ) {
    reject(
      'Split requires an active original slot and a successor starting on or after that slot.'
    );
  }
  const delta = first.compare(calendarDay(workDatePart(rule.anchor)));
  if (
    replacement.anchor.kind !== rule.anchor.kind ||
    replacement.anchor.zone !== rule.anchor.zone ||
    (replacement.anchor.kind === 'timed' &&
      rule.anchor.kind === 'timed' &&
      replacement.anchor.local.slice(11) !== rule.anchor.local.slice(11))
  )
    reject(
      'Keep the original clock time and zone when splitting a series. Edit the successor schedule explicitly to change them.'
    );
  const scheduleDelta = calendarDay(workDatePart(replacement.anchor)).compare(
    calendarDay(workDatePart(rule.anchor))
  );
  const shifted = (source: WorkDateSpec): WorkDateSpec => {
    if (source.kind === 'relative')
      reject('Choose explicit dates for the successor of a relative series.');
    return {
      kind: 'fixed',
      value: offsetWorkTime(
        source.value,
        { unit: 'days', amount: scheduleDelta },
        replacement.fold
      ),
    };
  };
  const plan = task.plan
    ? { start: shifted(task.plan.start), ...(task.plan.end ? { end: shifted(task.plan.end) } : {}) }
    : null;
  const deadline = task.deadline ? shifted(task.deadline) : null;
  const previous = applyWorkTaskCommand(
    task,
    {
      kind: 'edit',
      recurrence:
        delta === 0
          ? {
              ...rule,
              state: 'ended',
              excludedSlots: [...(rule.excludedSlots ?? []), firstSlot],
              until: firstSlot,
            }
          : { ...rule, until: first.subtract({ days: 1 }).toString() },
    },
    context
  );
  const excludedSlots = [
    ...new Set([
      ...(replacement.excludedSlots ?? []),
      ...task.occurrences.filter((item) => item.slot >= firstSlot).map((item) => item.slot),
    ]),
  ];
  const successor = applyWorkTaskCommand(
    null,
    {
      kind: 'create',
      name: task.name,
      description: task.description,
      assignee: task.assignee,
      links: task.links,
      plan,
      deadline,
      recurrence: { ...replacement, excludedSlots },
    },
    context
  );
  return { previous, successor };
}

export function expandWorkOccurrences(
  task: WorkTaskDocument,
  from: string,
  through: string,
  readSource?: WorkSourceReader
): WorkOccurrence[] {
  if (
    calendarDay(through).compare(calendarDay(from)) < 0 ||
    calendarDay(through).compare(calendarDay(from)) > 3660
  ) {
    reject('Choose an occurrence range of at most ten years.');
  }
  const visible = new Map<string, WorkOccurrence>();
  const overrides = new Map(task.occurrences.map((o) => [o.slot, o]));
  const rule = task.recurrence;
  if (rule && (rule.state === 'active' || rule.pauses?.length) && !isTerminal(task.status)) {
    const base = resolveWorkSchedule(task, readSource);
    const anchor = calendarDay(workDatePart(rule.anchor));
    const shifts = new Set<number>();
    for (const field of [base.start, base.deadline]) {
      if (field.kind === 'resolved')
        shifts.add(calendarDay(workDatePart(field.value)).compare(anchor));
    }
    if (base.start.kind !== 'resolved' || shifts.size === 0) shifts.add(0);
    for (const shift of shifts) {
      const lower = calendarDay(from).subtract({ days: shift }).toString();
      const upper = calendarDay(through).subtract({ days: shift }).toString();
      for (const [slot, nominal] of nominalSlots(rule, lower, upper)) {
        if (overrides.has(slot) || visible.has(slot)) continue;
        const instance = occurrenceAt(task, rule, slot, nominal, base);
        if (occurrenceTouches(instance, from, through)) visible.set(slot, instance);
      }
    }
  }
  for (const saved of overrides.values()) {
    const instance =
      isTerminal(saved.status) || saved.status === 'skipped'
        ? saved
        : {
            ...saved,
            schedule: saved.override
              ? resolveWorkSchedule(saved.override, readSource)
              : occurrenceAt(
                  task,
                  saved.recurrence,
                  saved.slot,
                  saved.nominal,
                  resolveWorkSchedule(task, readSource)
                ).schedule,
          };
    if (instance.status === 'skipped') continue;
    if (occurrenceTouches(instance, from, through)) visible.set(instance.slot, instance);
  }
  return [...visible.values()].sort((a, b) => {
    const date = (o: WorkOccurrence) =>
      o.schedule.start.kind === 'resolved'
        ? workTimeStart(o.schedule.start.value)
        : workTimeStart(o.nominal);
    return date(a) - date(b) || a.slot.localeCompare(b.slot);
  });
}

function changeOccurrence(
  task: WorkTaskDocument,
  slot: string,
  action: Extract<WorkTaskCommand, { kind: 'occurrence' }>['action'],
  context: WorkTaskContext
): WorkOccurrence {
  calendarDay(slot);
  const rule = task.recurrence;
  const existing = task.occurrences.find((o) => o.slot === slot);
  let current = existing;
  if (!current) {
    if (rule?.state !== 'active') return reject('The series is inactive.');
    const nominal = nominalSlots(rule, slot, slot).get(slot);
    if (!nominal) return reject('Unknown occurrence slot.');
    current = occurrenceAt(
      task,
      rule,
      slot,
      nominal,
      resolveWorkSchedule(task, context.readSource)
    );
  }
  if (action.kind === 'restore') {
    if (
      current.status !== 'skipped' ||
      rule?.state !== 'active' ||
      !nominalSlots(rule, slot, slot).has(slot)
    ) {
      reject('Only a skipped slot in an active series can be restored.');
    }
    return { ...current, status: 'todo' };
  }
  if (current.status === 'skipped') return reject('Restore the skipped occurrence first.');
  if (action.kind === 'skip' || action.kind === 'move') {
    if (isTerminal(current.status)) reject('Reopen the terminal occurrence first.');
    if (action.kind === 'skip') return { ...current, status: 'skipped' };
    const edits = changes({ plan: action.plan, deadline: action.deadline }, context);
    const nextSchedule = resolveWorkSchedule(
      { plan: edits.plan ?? null, deadline: edits.deadline ?? null },
      context.readSource
    );
    return {
      ...current,
      schedule: nextSchedule,
      override: { plan: edits.plan ?? null, deadline: edits.deadline ?? null },
    };
  }
  const activeSchedule = current.override
    ? resolveWorkSchedule(current.override, context.readSource)
    : occurrenceAt(
        task,
        current.recurrence,
        slot,
        current.nominal,
        resolveWorkSchedule(task, context.readSource)
      ).schedule;
  return {
    ...current,
    schedule: activeSchedule,
    ...transition(current.status, current.assignee, action, context, () => activeSchedule),
  };
}

export type WorkAgendaBucket =
  | 'overdue'
  | 'today'
  | 'upcoming'
  | 'past-plan'
  | 'unscheduled'
  | 'unresolved'
  | 'terminal';

export function workAgendaBucket(
  status: WorkStatus,
  schedule: WorkSchedule,
  now: number
): WorkAgendaBucket {
  const due = evaluateWorkDueStatus(status, schedule.deadline, now);
  if (due === 'terminal' || due === 'overdue') return due;
  const start = schedule.start.kind === 'resolved' ? schedule.start.value : null;
  const end = schedule.end.kind === 'resolved' ? schedule.end.value : null;
  if (
    due === 'today' ||
    (start && workDatePart(start) === workDateAt(now, start.zone)) ||
    (start && end && workTimeStart(start) <= now && now < workTimeStart(end))
  )
    return 'today';
  if (due === 'upcoming' || (start && workTimeStart(start) > now)) return 'upcoming';
  if (start && due === 'unscheduled' && schedule.end.kind !== 'unresolved') return 'past-plan';
  if (
    due === 'unresolved' ||
    schedule.start.kind === 'unresolved' ||
    schedule.end.kind === 'unresolved'
  )
    return 'unresolved';
  return 'unscheduled';
}

export function sortWorkAgenda<
  T extends { id: string; status: WorkStatus; schedule: WorkSchedule },
>(entries: readonly T[], now: number): T[] {
  const order: WorkAgendaBucket[] = [
    'overdue',
    'today',
    'upcoming',
    'past-plan',
    'unresolved',
    'unscheduled',
    'terminal',
  ];
  const key = (item: T) => {
    const group = workAgendaBucket(item.status, item.schedule, now);
    const dates = [item.schedule.start, item.schedule.deadline]
      .flatMap((date) => (date.kind === 'resolved' ? [workTimeStart(date.value)] : []))
      .filter((at) => group !== 'upcoming' || at >= now);
    const earliest =
      item.schedule.deadline.kind === 'resolved' && group === 'overdue'
        ? workTimeStart(item.schedule.deadline.value)
        : Math.min(...dates);
    return { rank: order.indexOf(group), earliest };
  };
  return [...entries].sort((a, b) => {
    const left = key(a),
      right = key(b);
    return (
      left.rank - right.rank ||
      (left.earliest === right.earliest ? 0 : left.earliest - right.earliest) ||
      a.id.localeCompare(b.id)
    );
  });
}

import { describe, expect, it } from 'vitest';
import { defineScientificDocument, parseScientificDocument } from './documents';
import {
  applyWorkTaskCommand,
  expandWorkOccurrences,
  workAgendaBucket,
  sortWorkAgenda,
  splitWorkSeries,
} from './work-task';
import { resolveWorkSchedule, workTimeFromInput } from './work-time';
import type { WorkRecurrence, WorkTaskCommand, WorkTaskDocument } from './work-task-types';

const day = (date: string) => workTimeFromInput({ kind: 'day', date, zone: 'UTC' });
const fixed = (date: string) => ({ kind: 'fixed' as const, value: day(date) });
const now = Date.parse('2026-11-17T12:00:00Z');
const run = (state: WorkTaskDocument | null, command: WorkTaskCommand) =>
  applyWorkTaskCommand(state, command, {
    now,
    actor: 'owner',
    canAssign: (target) => target.id === 'maya',
  });

describe('project work', () => {
  it('persists validated tasks through the accepted scientific document format', () => {
    const t = run(null, {
      kind: 'create',
      name: 'Review lot',
      links: [{ projectId: 'p', resourceId: 'lot' }],
    });
    expect(parseScientificDocument(JSON.parse(defineScientificDocument(t).text))).toEqual(t);
    expect(() => parseScientificDocument({ ...t, status: 'done' })).toThrow();
    expect(() => parseScientificDocument({ ...t, recurrence: { interval: 1 } })).toThrow();
    expect(() =>
      run(t, { kind: 'edit', assignee: { kind: 'member', id: 'unavailable' } })
    ).toThrow();
  });

  it('keeps the due date when rescheduling, freezes the completion and only reopens explicitly', () => {
    const deadline = fixed('2026-11-20');
    const t = run(null, {
      kind: 'create',
      name: 'Review',
      deadline,
      plan: { start: fixed('2026-11-18') },
      assignee: { kind: 'member', id: 'maya' },
    });
    const moved = run(t, { kind: 'edit', plan: { start: fixed('2026-11-17') } });
    expect(moved.deadline).toEqual(deadline);
    const evidence = [{ projectId: 'p', resourceId: 'result', revisionId: 'accepted' }];
    const done = run(moved, { kind: 'complete', actualAt: now - 1000, evidence });
    expect(done.completion).toMatchObject({
      recordedAt: now,
      actualAt: now - 1000,
      evidence,
      assignee: t.assignee,
      schedule: { deadline: { kind: 'resolved', value: deadline.value } },
    });
    expect(() => run(done, { kind: 'edit', deadline: null })).toThrow();
    expect(run(done, { kind: 'reopen' }).status).toBe('todo');
    expect(() => run(t, { kind: 'complete', actualAt: now + 1 })).toThrow();
    expect(() =>
      run(t, { kind: 'complete', evidence: [{ projectId: 'p', resourceId: 'result' }] })
    ).toThrow();
  });

  it('puts each task in one agenda group and orders by the earliest relevant future date', () => {
    const make = (id: string, planned: string | null, due: string | null) => ({
      id,
      status: 'todo' as const,
      schedule: resolveWorkSchedule({
        plan: planned ? { start: fixed(planned) } : null,
        deadline: due ? fixed(due) : null,
      }),
    });
    const entries = [
      make('late', '2026-11-17', '2026-11-14'),
      make('today', '2026-11-17', '2026-11-21'),
      make('next', '2026-11-01', '2026-11-18'),
      make('later', '2026-11-19', '2026-11-20'),
      make('earlier', '2026-11-12', null),
      make('none', null, null),
    ];
    expect(entries.map((e) => workAgendaBucket(e.status, e.schedule, now))).toEqual([
      'overdue',
      'today',
      'upcoming',
      'upcoming',
      'past-plan',
      'unscheduled',
    ]);
    expect(sortWorkAgenda([...entries].reverse(), now).map((e) => e.id)).toEqual(
      entries.map((e) => e.id)
    );
  });

  it('retains nominal IDs through move collisions, skip, restore and completion', () => {
    const recurrence: WorkRecurrence = {
      frequency: 'daily',
      interval: 1,
      anchor: day('2026-11-17'),
      state: 'active',
      fold: 'earlier',
      count: 5,
    };
    const initial = run(null, { kind: 'create', name: 'Inspection', recurrence });
    const moved = run(initial, {
      kind: 'occurrence',
      slot: '2026-11-17',
      action: { kind: 'move', plan: { start: fixed('2026-11-18') }, deadline: fixed('2026-11-19') },
    });
    const slots = (task: WorkTaskDocument, date: string) =>
      expandWorkOccurrences(task, date, date).map((o) => o.slot);
    expect(slots(moved, '2026-11-18')).toEqual(['2026-11-17', '2026-11-18']);
    expect(slots(moved, '2026-11-17')).toEqual([]);
    const skipped = run(moved, {
      kind: 'occurrence',
      slot: '2026-11-18',
      action: { kind: 'skip' },
    });
    expect(slots(skipped, '2026-11-18')).toEqual(['2026-11-17']);
    const done = run(skipped, {
      kind: 'occurrence',
      slot: '2026-11-17',
      action: { kind: 'complete' },
    });
    const changed = run(done, { kind: 'edit', recurrence: { ...recurrence, interval: 2 } });
    expect(changed.occurrences[0]?.completion?.schedule.start).toMatchObject({
      value: day('2026-11-18'),
    });
    expect(() =>
      run(changed, { kind: 'occurrence', slot: '2026-11-18', action: { kind: 'restore' } })
    ).toThrow();
    expect(() => expandWorkOccurrences(initial, '2000-01-01', '2060-01-01')).toThrow();
  });

  it('skips missing month days and repeated-hour gaps without inventing slots', () => {
    const recurrence: WorkRecurrence = {
      frequency: 'monthly',
      interval: 1,
      anchor: day('2026-01-31'),
      state: 'active',
      fold: 'earlier',
      count: 2,
    };
    const series = run(null, { kind: 'create', name: 'Monthly', recurrence });
    expect(expandWorkOccurrences(series, '2026-01-01', '2026-04-30').map((o) => o.slot)).toEqual([
      '2026-01-31',
      '2026-03-31',
    ]);
    const anchor = workTimeFromInput({
      kind: 'timed',
      local: '2026-03-07T02:30',
      zone: 'America/Los_Angeles',
    });
    const daily = run(series, {
      kind: 'edit',
      recurrence: { ...recurrence, frequency: 'daily', anchor },
    });
    expect(expandWorkOccurrences(daily, '2026-03-07', '2026-03-10').map((o) => o.slot)).toEqual([
      '2026-03-07',
      '2026-03-09',
    ]);
  });
});

it('preserves old occurrence identities across a split and suppresses the copied exceptions', () => {
  const rule: WorkRecurrence = {
    frequency: 'daily',
    interval: 1,
    anchor: day('2026-11-10'),
    state: 'active',
    fold: 'earlier',
  };
  const series = run(null, { kind: 'create', name: 'Inspection', recurrence: rule });
  const done = run(series, {
    kind: 'occurrence',
    slot: '2026-11-19',
    action: { kind: 'complete' },
  });
  const split = splitWorkSeries(
    done,
    '2026-11-18',
    { ...rule, anchor: day('2026-11-18') },
    { now, actor: 'owner' }
  );
  expect(
    expandWorkOccurrences(split.previous, '2026-11-17', '2026-11-20').map((o) => o.slot)
  ).toEqual(['2026-11-17', '2026-11-19']);
  expect(
    expandWorkOccurrences(split.successor, '2026-11-17', '2026-11-20').map((o) => o.slot)
  ).toEqual(['2026-11-18', '2026-11-20']);
  expect(split.previous.occurrences[0].completion).toEqual(done.occurrences[0].completion);
});

it('resumes a paused series without generating missed occurrences and reads deadlines across slot windows', () => {
  const rule: WorkRecurrence = {
    frequency: 'daily',
    interval: 1,
    anchor: day('2026-11-16'),
    state: 'active',
    fold: 'earlier',
  };
  const series = run(null, {
    kind: 'create',
    name: 'Review',
    recurrence: rule,
    deadline: fixed('2026-11-19'),
  });
  expect(expandWorkOccurrences(series, '2026-11-19', '2026-11-19').map((o) => o.slot)).toEqual([
    '2026-11-16',
    '2026-11-19',
  ]);
  const paused = run(series, { kind: 'edit', recurrence: { ...rule, state: 'paused' } });
  const resumed = applyWorkTaskCommand(
    paused,
    { kind: 'edit', recurrence: rule },
    { now: Date.parse('2026-11-20T00:00:00Z'), actor: 'owner' }
  );
  expect(expandWorkOccurrences(resumed, '2026-11-17', '2026-11-21').map((o) => o.slot)).toEqual([
    '2026-11-16',
    '2026-11-17',
    '2026-11-20',
    '2026-11-21',
  ]);
});

it('starts a delayed successor series at its chosen anchor while keeping the old cutoff', () => {
  const anchor = { kind: 'day' as const, date: '2026-11-17', zone: 'UTC' };
  const task = run(null, {
    kind: 'create',
    name: 'Inspect',
    plan: { start: { kind: 'fixed', value: anchor } },
    deadline: { kind: 'fixed', value: anchor },
    recurrence: { frequency: 'daily', interval: 1, anchor, fold: 'earlier', state: 'active' },
  });
  const result = splitWorkSeries(
    task,
    '2026-11-18',
    { ...task.recurrence!, anchor: { ...anchor, date: '2026-11-20' } },
    { actor: 'p1', now: now + 1 }
  );
  expect(result.previous.recurrence?.until).toBe('2026-11-17');
  expect(expandWorkOccurrences(result.successor, '2026-11-20', '2026-11-20')[0]?.slot).toBe(
    '2026-11-20'
  );
  expect(
    expandWorkOccurrences(result.successor, '2026-11-20', '2026-11-20')[0]?.schedule
  ).toMatchObject({
    start: { value: { date: '2026-11-20' } },
    deadline: { value: { date: '2026-11-20' } },
  });
});

it('freezes the resolved schedule when canceling followed work', () => {
  let source = fixed('2026-11-18');
  const context = {
    actor: 'owner',
    now,
    readSource: () => ({ kind: 'resolved' as const, spec: source, revisionId: 'source-one' }),
  };
  const task = applyWorkTaskCommand(
    null,
    {
      kind: 'create',
      name: 'Followed review',
      deadline: {
        kind: 'relative',
        source: { projectId: 'project', resourceId: 'source', role: 'deadline' },
        offset: { unit: 'days', amount: 0 },
      },
    },
    context
  );
  const canceled = applyWorkTaskCommand(task, { kind: 'cancel' }, context);
  source = fixed('2026-11-30');
  expect(canceled.cancellation?.schedule.deadline).toMatchObject({
    kind: 'resolved',
    value: { date: '2026-11-18' },
    sources: [{ revisionId: 'source-one' }],
  });
});

it('retains a recorded instant across changes to zone rules and checks current rules on new schedules', () => {
  const base = run(null, { kind: 'create', name: 'Inspection' });
  const earlierRules = {
    kind: 'fixed' as const,
    value: {
      kind: 'timed' as const,
      zone: 'America/Los_Angeles',
      local: '2026-11-01T01:30:00',
      instant: Date.parse('2026-11-01T07:30:00Z'),
    },
  };
  const history = parseScientificDocument({ ...base, deadline: earlierRules });
  expect(history).toMatchObject({ deadline: earlierRules });
  expect(() => run(base, { kind: 'edit', deadline: earlierRules })).toThrow(
    'current time zone rules'
  );
});

it('includes a plan spanning the entire month and looks up a distant deadline separately', () => {
  const series = run(null, {
    kind: 'create',
    name: 'Instrument reservation',
    plan: { start: fixed('2026-11-18'), end: fixed('2027-01-10') },
    deadline: fixed('2050-02-01'),
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      anchor: day('2026-11-17'),
      state: 'active',
      fold: 'earlier',
      count: 1,
    },
  });
  expect(expandWorkOccurrences(series, '2026-12-01', '2026-12-31').map((o) => o.slot)).toEqual([
    '2026-11-17',
  ]);
  expect(expandWorkOccurrences(series, '2027-01-11', '2027-01-12')).toEqual([]);
  expect(expandWorkOccurrences(series, '2050-02-01', '2050-02-01').map((o) => o.slot)).toEqual([
    '2026-11-17',
  ]);
});

import { describe, expect, it } from 'vitest';
import type { WorkDateSpec, WorkTime } from './work-task-types';
import {
  classifyLegacyWorkDate,
  deadlineBoundary,
  evaluateWorkDueStatus,
  offsetWorkTime,
  resolveWorkDate,
  workTimeFromInput,
} from './work-time';

const zone = 'America/Los_Angeles';
const day = (date: string) => workTimeFromInput({ kind: 'day', date, zone });
const timed = (local: string, fold?: 'earlier' | 'later') =>
  workTimeFromInput({ kind: 'timed', local, zone, ...(fold ? { fold } : {}) });
const resolved = (value: WorkTime) => ({ kind: 'resolved', value, sources: [] }) as const;

describe('work dates', () => {
  it('preserves civil-day cutoffs through daylight saving transitions and skipped days', () => {
    expect(deadlineBoundary(day('2026-03-08'))).toBe(Date.parse('2026-03-09T07:00:00Z'));
    expect(deadlineBoundary(day('2026-11-01'))).toBe(Date.parse('2026-11-02T08:00:00Z'));
    expect(() =>
      workTimeFromInput({ kind: 'day', zone: 'Pacific/Apia', date: '2011-12-30' })
    ).toThrow();
    expect(
      deadlineBoundary(workTimeFromInput({ kind: 'day', zone: 'Pacific/Apia', date: '2011-12-29' }))
    ).toBe(Date.parse('2011-12-30T10:00:00Z'));
  });

  it('separates inclusive instant deadlines from exclusive all-day boundaries', () => {
    const end = timed('2026-11-02T00:00'),
      boundary = deadlineBoundary(end);
    expect(evaluateWorkDueStatus('todo', resolved(end), boundary)).toBe('today');
    expect(evaluateWorkDueStatus('todo', resolved(end), boundary + 1)).toBe('overdue');
    expect(evaluateWorkDueStatus('todo', resolved(day('2026-11-01')), boundary)).toBe('overdue');
    expect(evaluateWorkDueStatus('done', resolved(end), boundary + 1)).toBe('terminal');
  });

  it('requires a fold choice and rejects a daylight-saving gap', () => {
    expect(() => timed('2026-11-01T01:30')).toThrow('twice');
    expect(() => timed('2026-03-08T02:30')).toThrow('does not exist');
    expect(
      deadlineBoundary(timed('2026-11-01T01:30', 'later')) -
        deadlineBoundary(timed('2026-11-01T01:30', 'earlier'))
    ).toBe(3600000);
    expect(() => day('2026-02-29')).toThrow();
    expect(() => workTimeFromInput({ kind: 'day', zone: '+04:00', date: '2026-02-15' })).toThrow();
  });

  it('applies elapsed and calendar offsets in their original units', () => {
    const start = timed('2026-03-07T09:00');
    expect(offsetWorkTime(start, { unit: 'days', amount: 1 })).toEqual(timed('2026-03-08T09:00'));
    expect(offsetWorkTime(start, { unit: 'milliseconds', amount: 86400000 })).toEqual(
      timed('2026-03-08T10:00')
    );
    expect(() => offsetWorkTime(day('2026-01-01'), { unit: 'milliseconds', amount: 0 })).toThrow();
  });

  it('separates legacy values without rewriting them', () => {
    expect(classifyLegacyWorkDate(null, zone).kind).toBe('missing');
    expect(classifyLegacyWorkDate('2024-02-29', zone).kind).toBe('exact');
    expect(classifyLegacyWorkDate('2024-02-29T09:30:00+01:00', zone)).toMatchObject({
      kind: 'exact',
      value: { kind: 'timed', instant: Date.parse('2024-02-29T08:30:00Z'), zone: 'UTC' },
    });
    expect(classifyLegacyWorkDate('2024-02-29T09:30:00-03:30', zone)).toMatchObject({
      kind: 'exact',
      value: { instant: Date.parse('2024-02-29T13:00:00Z') },
    });
    expect(classifyLegacyWorkDate('2026-11', zone)).toEqual({
      kind: 'partial',
      raw: '2026-11',
      precision: 'month',
    });
    for (const raw of ['02/03/24', '2024-02-30', 45555])
      expect(classifyLegacyWorkDate(raw, zone)).toEqual({ kind: 'unresolved', raw });
  });

  it('records complete derivation provenance and stops on cycles or denied sources', () => {
    const source = { projectId: 'p', resourceId: 'r', role: 'expires' };
    const relative: WorkDateSpec = {
      kind: 'relative',
      source,
      offset: { unit: 'days', amount: -1 },
    };
    const read = () =>
      ({
        kind: 'resolved',
        revisionId: 'v1',
        spec: { kind: 'fixed', value: day('2026-05-01') },
      }) as const;
    expect(resolveWorkDate(relative, read)).toEqual({
      kind: 'resolved',
      value: day('2026-04-30'),
      sources: [{ ...source, revisionId: 'v1' }],
    });
    expect(
      resolveWorkDate(relative, () => ({ kind: 'resolved', revisionId: 'v1', spec: relative }))
    ).toEqual({ kind: 'unresolved', reason: 'cycle' });
    expect(resolveWorkDate(relative, () => ({ kind: 'denied' }))).toEqual({
      kind: 'unresolved',
      reason: 'denied',
    });
  });
});

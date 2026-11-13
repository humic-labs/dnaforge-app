import { userMessage } from '@waypoint/user-messages';
// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  formatJobElapsed,
  projectJobsSnapshot,
  type JobsSidebarJob,
  type JobsSidebarSnapshot,
} from './presentation';

const NOW = Date.UTC(2026, 8, 9, 20, 0, 0);

function job(overrides: Partial<JobsSidebarJob> = {}): JobsSidebarJob {
  return {
    id: 'operation-1',
    title: 'Annotate sequence',
    actorLabel: 'Peter',
    state: 'running',
    observation: { freshness: 'current', observedAtMs: NOW },
    result: { availability: 'none' },
    review: { state: 'not-required' },
    executionContext: {
      mode: 'managed',
      ownerLabel: 'DNAForge local service',
      locationLabel: 'This Mac',
      lifetimeLabel: 'Runs while DNAForge is open',
    },
    createdAtMs: NOW - 90_000,
    startedAtMs: NOW - 65_000,
    canStop: true,
    ...overrides,
  };
}

function snapshot(jobs: readonly JobsSidebarJob[]): JobsSidebarSnapshot {
  return {
    jobs,
    nowMs: NOW,
    collectionObservation: { state: 'current', observedAtMs: NOW },
  };
}

describe('projectJobsSnapshot', () => {
  it('projects execution, freshness, result and review independently into three sections', () => {
    const jobs = [
      job({ id: 'running' }),
      job({ id: 'stopping', state: 'stopping', canStop: false }),
      job({ id: 'queued', state: 'queued', startedAtMs: undefined }),
      job({ id: 'failed', state: 'failed', canStop: false, finishedAtMs: NOW - 1_000 }),
      job({ id: 'interrupted', state: 'interrupted', canStop: false }),
      job({
        id: 'review',
        state: 'succeeded',
        canStop: true,
        finishedAtMs: NOW - 1_000,
        result: { availability: 'available' },
        review: { state: 'awaiting-review', reason: 'Choose annotations to apply' },
      }),
      job({
        id: 'stale-running',
        observation: {
          freshness: 'stale',
          observedAtMs: NOW - 30_000,
          reason: 'Local execution owner is unavailable',
        },
      }),
      job({
        id: 'succeeded',
        state: 'succeeded',
        canStop: false,
        finishedAtMs: NOW - 1_000,
        result: { availability: 'available' },
      }),
      job({ id: 'cancelled', state: 'cancelled', canStop: false }),
    ];

    const projection = projectJobsSnapshot(snapshot(jobs));

    expect(
      projection.sections.map(({ id, jobs: rows }) => [id, rows.map((row) => row.id)])
    ).toEqual([
      ['active', ['running', 'stopping', 'queued']],
      ['attention', ['failed', 'interrupted', 'review', 'stale-running']],
      ['recent', ['succeeded', 'cancelled']],
    ]);
    expect(projection.activeCount).toBe(3);
    expect(projection.uncertainCount).toBe(1);
    expect(projection.attentionCount).toBe(4);
    expect(projection.sections.flatMap((section) => section.jobs)).toHaveLength(jobs.length);

    const review = projection.sections[1]?.jobs.find((row) => row.id === 'review');
    expect(review).toMatchObject({
      state: 'succeeded',
      result: { availability: 'available' },
      review: { state: 'awaiting-review' },
      attentionReasons: ['Choose annotations to apply'],
    });
  });

  it('preserves a stale last-known active state without claiming it is currently active', () => {
    const projection = projectJobsSnapshot(
      snapshot([
        job({
          id: 'stale',
          state: 'running',
          startedAtMs: NOW - 155_000,
          observation: {
            freshness: 'stale',
            observedAtMs: NOW - 120_000,
            reason: 'Owner heartbeat is overdue',
          },
        }),
      ])
    );

    expect(projection.activeCount).toBe(0);
    expect(projection.uncertainCount).toBe(1);
    expect(projection.attentionCount).toBe(1);
    expect(projection.sections[0]).toMatchObject({
      id: 'attention',
      jobs: [
        {
          state: 'running',
          stateLabel: 'Last known: Running',
          elapsedLabel: '35s',
          attentionReasons: [userMessage('jobs.statusStale')],
        },
      ],
    });
  });

  it('does not turn stale terminal history into a failure or attention item', () => {
    const projection = projectJobsSnapshot(
      snapshot([
        job({
          id: 'settled',
          state: 'succeeded',
          canStop: false,
          finishedAtMs: NOW - 30_000,
          observation: {
            freshness: 'stale',
            observedAtMs: NOW - 20_000,
            reason: 'Owner is offline',
          },
          result: { availability: 'expired', reason: 'Retention period ended' },
          review: { state: 'applied' },
        }),
      ])
    );

    expect(projection.sections[0]).toMatchObject({
      id: 'recent',
      jobs: [
        {
          state: 'succeeded',
          observation: { freshness: 'stale' },
          result: { availability: 'expired' },
          review: { state: 'applied' },
          attentionReasons: [],
        },
      ],
    });
    expect(projection.activeCount).toBe(0);
    expect(projection.uncertainCount).toBe(0);
    expect(projection.attentionCount).toBe(0);
  });

  it('surfaces a completed batch with failed children as attention and keeps its real rollup', () => {
    const batch = job({
      id: 'batch',
      state: 'succeeded',
      canStop: false,
      result: { availability: 'available' },
      children: [
        job({ id: 'child-ok', state: 'succeeded', canStop: false }),
        job({ id: 'child-failed', state: 'failed', canStop: false, error: 'No hits database' }),
        job({ id: 'child-queued', state: 'queued', startedAtMs: undefined }),
      ],
    });

    const projection = projectJobsSnapshot(snapshot([batch]));

    expect(projection.sections.map((section) => section.id)).toEqual(['attention']);
    expect(projection.sections[0]?.jobs[0]?.batchSummary).toEqual({
      total: 3,
      finished: 2,
      failed: 1,
      interrupted: 0,
    });
    expect(projection.sections[0]?.jobs[0]?.attentionReasons).toEqual(['1 batch item failed']);
    expect(projection.activeCount).toBe(0);
    expect(projection.attentionCount).toBe(1);
  });

  it('places a live batch with failed children in attention without losing its active count', () => {
    const projection = projectJobsSnapshot(
      snapshot([
        job({
          id: 'live-batch',
          state: 'running',
          children: [job({ id: 'failed-child', state: 'failed', canStop: false })],
        }),
      ])
    );

    expect(projection.sections.map((section) => section.id)).toEqual(['attention']);
    expect(projection.activeCount).toBe(1);
    expect(projection.uncertainCount).toBe(0);
    expect(projection.attentionCount).toBe(1);
  });

  it('uses exact collection counts and reports policy-limited terminal history', () => {
    const value = snapshot([
      job({ id: 'active-one' }),
      job({ id: 'active-two', state: 'queued', startedAtMs: undefined }),
      job({ id: 'visible-terminal', state: 'succeeded', canStop: false }),
    ]);
    const projection = projectJobsSnapshot({
      ...value,
      historySummary: {
        operationCount: 12,
        activeCount: 2,
        terminalCount: 10,
        historyComplete: false,
      },
    });

    expect(projection.activeCount).toBe(2);
    expect(projection.historyCoverage).toEqual({
      operationCount: 12,
      activeCount: 2,
      terminalCount: 10,
      visibleTerminalCount: 1,
      historyComplete: false,
    });
  });

  it('uses only valid owner-reported numeric progress', () => {
    const projection = projectJobsSnapshot(
      snapshot([
        job({ id: 'valid', progress: { completed: 12, total: 40 } }),
        job({ id: 'over-total', progress: { completed: 41, total: 40 } }),
        job({ id: 'zero-total', progress: { completed: 0, total: 0 } }),
        job({ id: 'fractional', progress: { completed: 1.5, total: 4 } }),
      ])
    );

    const rows = projection.sections[0]?.jobs ?? [];
    expect(rows.map(({ id, progress }) => [id, progress])).toEqual([
      ['valid', { completed: 12, total: 40 }],
      ['over-total', null],
      ['zero-total', null],
      ['fractional', null],
    ]);
  });

  it('filters by an actual selected scope without manufacturing scope choices', () => {
    const projection = projectJobsSnapshot({
      ...snapshot([
        job({ id: 'workspace-a', scopeId: 'scope-a' }),
        job({ id: 'workspace-b', scopeId: 'scope-b' }),
        job({ id: 'unscoped' }),
      ]),
      scopes: [
        { id: 'scope-a', label: 'Workspace A' },
        { id: 'scope-b', label: 'Workspace B' },
      ],
      selectedScopeId: 'scope-b',
    });

    expect(projection.sections.flatMap((section) => section.jobs.map((row) => row.id))).toEqual([
      'workspace-b',
    ]);
  });
});

describe('formatJobElapsed', () => {
  it('formats owner timestamps against the supplied snapshot clock', () => {
    expect(formatJobElapsed(500)).toBe('<1s');
    expect(formatJobElapsed(65_000)).toBe('1m 5s');
    expect(formatJobElapsed(3_720_000)).toBe('1h 2m');
    expect(formatJobElapsed(90_000_000)).toBe('1d 1h');
  });

  it('does not manufacture a duration from missing or contradictory timestamps', () => {
    const missingSettlement = projectJobsSnapshot(
      snapshot([job({ state: 'succeeded', canStop: false, finishedAtMs: undefined })])
    );
    const futureStart = projectJobsSnapshot(snapshot([job({ startedAtMs: NOW + 1_000 })]));

    expect(missingSettlement.sections[0]?.jobs[0]?.elapsedLabel).toBe('Duration unknown');
    expect(futureStart.sections[0]?.jobs[0]?.elapsedLabel).toBe('Duration unknown');
  });
});

// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  alignedReadStatusWithRemoteConnection,
  alignedReadBlockedStatus,
  alignedReadRetryDelayMs,
  alignedReadTrackStatusView,
  classifyAlignedReadTileFailure,
  createAlignedReadTrackLifecycleSignal,
} from './aligned-read-track-lifecycle';

describe('aligned-read track lifecycle', () => {
  it('lets remote connection health outrank cached read readiness without losing it on recovery', () => {
    const ready = { phase: 'ready' as const, kind: 'reads' as const };
    const base = {
      attempt: 1,
      transportGeneration: 2,
      lastFailure: null,
      updatedAt: 1,
    };
    expect(alignedReadStatusWithRemoteConnection(ready, { ...base, state: 'retrying' })).toEqual({
      phase: 'recovering',
      attempt: 1,
      hasLastGood: true,
    });
    expect(
      alignedReadStatusWithRemoteConnection(ready, { ...base, state: 'needs-authentication' })
    ).toEqual({ phase: 'waiting-for-authentication', hasLastGood: true });
    expect(
      alignedReadTrackStatusView(
        { phase: 'waiting-for-authentication', hasLastGood: true },
        { remote: true, remoteEndpointLabel: 'cluster-a' }
      )
    ).toMatchObject({
      gutterLabel: 'Sign in to cluster-a in Terminal, then click Retry',
      actionLabel: 'Retry',
    });
    expect(
      alignedReadStatusWithRemoteConnection(ready, {
        ...base,
        state: 'blocked',
        lastFailure: { code: 'alignment-not-found', message: 'Remote file moved.' },
      })
    ).toEqual({
      phase: 'blocked',
      message: 'Remote file moved.',
      action: 'repair',
      hasLastGood: true,
    });
    expect(alignedReadStatusWithRemoteConnection(ready, { ...base, state: 'online' })).toBe(ready);
  });

  it('publishes only semantic state changes', () => {
    const signal = createAlignedReadTrackLifecycleSignal();
    const listener = vi.fn();
    signal.subscribe(listener);

    signal.set('bam-a', { phase: 'loading' });
    signal.set('bam-a', { phase: 'loading' });
    signal.set('bam-a', { phase: 'recovering', attempt: 1, hasLastGood: false });
    signal.set('bam-a', { phase: 'recovering', attempt: 1, hasLastGood: false });
    signal.set('bam-a', { phase: 'ready', kind: 'reads' });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(signal.getSnapshot()).toEqual({ 'bam-a': { phase: 'ready', kind: 'reads' } });
  });

  it('retains and removes runtime state without persistence-shaped defaults', () => {
    const signal = createAlignedReadTrackLifecycleSignal();
    signal.set('bam-a', { phase: 'ready', kind: 'coverage' });
    signal.set('bam-b', { phase: 'ready', kind: 'empty' });

    signal.retain(new Set(['bam-b']));
    expect(signal.getSnapshot()).toEqual({ 'bam-b': { phase: 'ready', kind: 'empty' } });

    signal.remove('bam-b');
    expect(signal.getSnapshot()).toEqual({});
  });

  it.each([
    ['queue-full', 'transient'],
    ['fetch-failed', 'transient'],
    ['http-0', 'transient'],
    ['http-408', 'transient'],
    ['http-429', 'transient'],
    ['http-500', 'transient'],
    ['http-503', 'transient'],
    ['stalled', 'transient'],
    ['timeout', 'timeout'],
    ['http-404', 'permanent'],
    ['not-found', 'permanent'],
    ['missing local BAM index at /tmp/a.bai', 'permanent'],
  ] as const)('classifies %s as %s', (reason, expected) => {
    expect(classifyAlignedReadTileFailure(reason)).toBe(expected);
  });

  it('backs transient recovery off to a persistent bounded cadence', () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 7, 100].map((attempt) => alignedReadRetryDelayMs('http-503', attempt))
    ).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]);
    expect([0, 1, 6, 20].map((attempt) => alignedReadRetryDelayMs('timeout', attempt))).toEqual([
      500, 1_000, 30_000, 30_000,
    ]);
    expect(alignedReadRetryDelayMs('not-found', 0)).toBeNull();
  });

  it('uses repair for permanent source failures and retry after exhausted transient failures', () => {
    expect(alignedReadBlockedStatus('not-found', false)).toEqual({
      phase: 'blocked',
      message: 'The aligned-read source needs attention.',
      action: 'repair',
      hasLastGood: false,
    });
    expect(alignedReadBlockedStatus('queue-full', true)).toEqual({
      phase: 'blocked',
      message: 'Aligned reads could not reconnect.',
      action: 'retry',
      hasLastGood: true,
    });
  });

  it('keeps loading status in the gutter without covering the canvas', () => {
    expect(alignedReadTrackStatusView({ phase: 'loading' })).toMatchObject({
      gutterLabel: 'Loading',
    });
    expect(alignedReadTrackStatusView({ phase: 'ready', kind: 'empty' })).toMatchObject({
      gutterLabel: 'No reads here',
    });
    expect(alignedReadTrackStatusView({ phase: 'ready', kind: 'coverage' })).toMatchObject({
      gutterLabel: 'Coverage',
    });
    expect(alignedReadTrackStatusView({ phase: 'loading' })).not.toHaveProperty('canvasLabel');
  });

  it('names the real remote endpoint in every streaming state without adding canvas copy', () => {
    const remote = { remote: true, remoteEndpointLabel: 'Fred Hutch HPC' } as const;
    expect(
      alignedReadTrackStatusView({ phase: 'refreshing', hasLastGood: true }, remote)
    ).toMatchObject({
      gutterLabel: 'Streaming from Fred Hutch HPC…',
      actionLabel: null,
    });
    expect(
      alignedReadTrackStatusView({ phase: 'stalled', hasLastGood: true, elapsedMs: 5_000 }, remote)
    ).toMatchObject({
      gutterLabel: 'Fred Hutch HPC slow — still waiting',
      actionLabel: 'Retry',
    });
    expect(alignedReadTrackStatusView({ phase: 'ready', kind: 'reads' }, remote)).toMatchObject({
      gutterLabel: 'Fred Hutch HPC live • reads',
    });
    expect(alignedReadTrackStatusView({ phase: 'ready', kind: 'coverage' }, remote)).toMatchObject({
      gutterLabel: 'Fred Hutch HPC live • zoom in for reads',
    });
    expect(
      alignedReadTrackStatusView({ phase: 'stalled', hasLastGood: false, elapsedMs: 5_000 }, remote)
    ).not.toHaveProperty('canvasLabel');
    expect(alignedReadTrackStatusView({ phase: 'loading' }, remote).gutterLabel).not.toContain(
      'SSH'
    );
    expect(alignedReadTrackStatusView({ phase: 'loading' }, remote).gutterLabel).toBe(
      'Opening Fred Hutch HPC…'
    );
    expect(
      alignedReadTrackStatusView({ phase: 'recovering', attempt: 2, hasLastGood: true }, remote)
    ).toMatchObject({
      gutterLabel: 'Reconnecting Fred Hutch HPC…',
      actionLabel: 'Retry',
    });
  });
});

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeStructureViewHandoff,
  attachStructureViewHandoffDestination,
  beginStructureViewHandoff,
  failStructureViewHandoff,
  getStructureViewHandoffDiagnostics,
  markStructureViewHostInteractive,
  resetStructureViewHandoffsForTesting,
} from './structure-view-handoff';

describe('structure view handoff transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStructureViewHandoffsForTesting();
  });

  afterEach(() => {
    resetStructureViewHandoffsForTesting();
    vi.useRealTimers();
  });

  it('commits only after the matching destination instance acknowledges load', async () => {
    const transaction = beginStructureViewHandoff({
      structureViewId: 'view-1',
      bindingId: 'binding-1',
      sourceGeneration: 7,
      timeoutMs: 10_000,
    });
    attachStructureViewHandoffDestination(transaction.transactionId, {
      tabId: 'tab-1',
      panelId: 'panel-2',
      viewerInstanceId: 'tab:tab-1',
      createdTab: true,
      createdPanelId: 'panel-2',
    });

    expect(
      acknowledgeStructureViewHandoff({
        transactionId: transaction.transactionId,
        structureViewId: 'view-1',
        viewerInstanceId: 'tab:stale',
        generation: transaction.generation,
      })
    ).toBe(false);
    expect(
      acknowledgeStructureViewHandoff({
        transactionId: transaction.transactionId,
        structureViewId: 'view-1',
        viewerInstanceId: 'tab:tab-1',
        generation: transaction.generation + 1,
      })
    ).toBe(false);

    expect(
      acknowledgeStructureViewHandoff({
        transactionId: transaction.transactionId,
        structureViewId: 'view-1',
        viewerInstanceId: 'tab:tab-1',
        generation: transaction.generation,
      })
    ).toBe(true);
    await expect(transaction.completion).resolves.toMatchObject({ status: 'committed' });
  });

  it('commits an already-interactive destination without waiting for another load event', async () => {
    markStructureViewHostInteractive('view-1', 'tab:tab-existing');
    const transaction = beginStructureViewHandoff({
      structureViewId: 'view-1',
      bindingId: 'binding-1',
      sourceGeneration: 1,
      timeoutMs: 10_000,
    });
    attachStructureViewHandoffDestination(transaction.transactionId, {
      tabId: 'tab-existing',
      panelId: 'panel-2',
      viewerInstanceId: 'tab:tab-existing',
      createdTab: false,
    });

    await expect(transaction.completion).resolves.toMatchObject({ status: 'committed' });
  });

  it('returns one in-flight transaction for rapid duplicate activation', () => {
    const first = beginStructureViewHandoff({
      structureViewId: 'view-1',
      bindingId: 'binding-1',
      sourceGeneration: 1,
      timeoutMs: 10_000,
    });
    const second = beginStructureViewHandoff({
      structureViewId: 'view-1',
      bindingId: 'binding-1',
      sourceGeneration: 1,
      timeoutMs: 10_000,
    });

    expect(second.transactionId).toBe(first.transactionId);
    expect(second.created).toBe(false);
  });

  it('fails with destination metadata retained for precise rollback', async () => {
    const transaction = beginStructureViewHandoff({
      structureViewId: 'view-1',
      bindingId: 'binding-1',
      sourceGeneration: 1,
      timeoutMs: 10_000,
    });
    attachStructureViewHandoffDestination(transaction.transactionId, {
      tabId: 'tab-1',
      panelId: 'panel-2',
      viewerInstanceId: 'tab:tab-1',
      createdTab: true,
      createdPanelId: 'panel-2',
    });
    failStructureViewHandoff(transaction.transactionId, 'viewer failed');

    await expect(transaction.completion).resolves.toEqual({
      status: 'failed',
      reason: 'viewer failed',
      destination: {
        tabId: 'tab-1',
        panelId: 'panel-2',
        viewerInstanceId: 'tab:tab-1',
        createdTab: true,
        createdPanelId: 'panel-2',
      },
    });
    expect(getStructureViewHandoffDiagnostics()).toMatchObject({ transactionCount: 0 });
  });

  it('times out instead of collapsing the source without a load acknowledgement', async () => {
    const transaction = beginStructureViewHandoff({
      structureViewId: 'view-1',
      bindingId: 'binding-1',
      sourceGeneration: 1,
      timeoutMs: 50,
    });
    attachStructureViewHandoffDestination(transaction.transactionId, {
      tabId: 'tab-1',
      panelId: 'panel-2',
      viewerInstanceId: 'tab:tab-1',
      createdTab: true,
      createdPanelId: 'panel-2',
    });

    await vi.advanceTimersByTimeAsync(51);
    await expect(transaction.completion).resolves.toMatchObject({
      status: 'failed',
      reason: 'destination viewer load timed out',
    });
    expect(getStructureViewHandoffDiagnostics()).toMatchObject({ transactionCount: 0 });
  });
});

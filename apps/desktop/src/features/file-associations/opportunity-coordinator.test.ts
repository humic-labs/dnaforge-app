// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type {
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
} from '../../shared/file-association-ipc';
import { FILE_ASSOCIATION_SNOOZE_MS } from './opportunity-state';
import { FileAssociationOpportunityCoordinator } from './opportunity-coordinator';

const NOW = Date.UTC(2026, 7, 26, 12);

function status(
  state: FileAssociationHandlerStatus['state'] = 'other'
): FileAssociationHandlerStatus {
  return {
    familyId: 'genbank',
    state,
    handlerName: state === 'default' ? 'DNAForge' : state === 'other' ? 'Preview' : null,
    handlerPath: null,
    defaultAction: 'native',
    detail: null,
  };
}

function requestResult(
  outcome: FileAssociationDefaultRequestResult['outcome']
): FileAssociationDefaultRequestResult {
  return { familyId: 'genbank', outcome, detail: null };
}

function harness(input?: {
  readonly stored?: string | null;
  readonly statuses?: readonly FileAssociationHandlerStatus[];
  readonly requestOutcome?: FileAssociationDefaultRequestResult['outcome'];
}) {
  let stored = input?.stored ?? null;
  const getSetting = vi.fn(async () => stored);
  const setSetting = vi.fn(async (_key: string, value: string) => {
    stored = value;
  });
  const queryHandlers = vi.fn(async () => input?.statuses ?? [status()]);
  const requestDefault = vi.fn(async () => requestResult(input?.requestOutcome ?? 'requested'));
  const coordinator = new FileAssociationOpportunityCoordinator({
    getSetting,
    setSetting,
    queryHandlers,
    requestDefault,
    now: () => NOW,
  });
  return {
    coordinator,
    getSetting,
    setSetting,
    queryHandlers,
    requestDefault,
    readStored: () => stored,
  };
}

describe('FileAssociationOpportunityCoordinator', () => {
  it('records a prompt durably only after successful GenBank use', async () => {
    const { coordinator, setSetting, readStored } = harness();

    await expect(coordinator.recordSuccessfulUse('genbank')).resolves.toMatchObject({
      familyId: 'genbank',
      status: { state: 'other' },
    });
    expect(setSetting).toHaveBeenCalledOnce();
    expect(JSON.parse(readStored() ?? '{}').families.genbank.promptCount).toBe(1);
  });

  it('permits only one prompt per session even when successful opens race', async () => {
    const { coordinator } = harness();

    const [first, second] = await Promise.all([
      coordinator.recordSuccessfulUse('genbank'),
      coordinator.recordSuccessfulUse('genbank'),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it('persists Not now for fourteen days across coordinator restarts', async () => {
    const first = harness();
    expect(await first.coordinator.recordSuccessfulUse('genbank')).not.toBeNull();
    await first.coordinator.snooze('genbank');

    const second = harness({ stored: first.readStored() });
    await expect(second.coordinator.recordSuccessfulUse('genbank')).resolves.toBeNull();
    const state = JSON.parse(second.readStored() ?? '{}');
    expect(state.families.genbank.snoozedUntil).toBe(NOW + FILE_ASSOCIATION_SNOOZE_MS);
  });

  it('persists permanent dismissal across coordinator restarts', async () => {
    const first = harness();
    expect(await first.coordinator.recordSuccessfulUse('genbank')).not.toBeNull();
    await first.coordinator.dismissPermanently('genbank');

    const second = harness({ stored: first.readStored() });
    await expect(second.coordinator.recordSuccessfulUse('genbank')).resolves.toBeNull();
  });

  it('marks an observed DNAForge default and never re-prompts after a later change', async () => {
    const initiallyDefault = harness({ statuses: [status('default')] });
    await expect(initiallyDefault.coordinator.recordSuccessfulUse('genbank')).resolves.toBeNull();

    const laterChanged = harness({
      stored: initiallyDefault.readStored(),
      statuses: [status('other')],
    });
    await expect(laterChanged.coordinator.recordSuccessfulUse('genbank')).resolves.toBeNull();
  });

  it('confirms a native default request only after a factual re-query', async () => {
    const { coordinator, queryHandlers } = harness();
    queryHandlers
      .mockResolvedValueOnce([status('other')])
      .mockResolvedValueOnce([status('default')]);
    expect(await coordinator.recordSuccessfulUse('genbank')).not.toBeNull();

    await expect(coordinator.requestDefault('genbank')).resolves.toMatchObject({
      request: { outcome: 'requested' },
      confirmedDefault: true,
    });
  });

  it('fails closed when the operating-system handler query fails', async () => {
    const { coordinator, queryHandlers, setSetting } = harness();
    queryHandlers.mockRejectedValueOnce(new Error('native query failed'));

    await expect(coordinator.recordSuccessfulUse('genbank')).resolves.toBeNull();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('propagates a settings read failure without replacing durable state', async () => {
    const { coordinator, getSetting, setSetting, queryHandlers } = harness();
    getSetting.mockRejectedValueOnce(new Error('database read failed'));

    await expect(coordinator.recordSuccessfulUse('genbank')).rejects.toThrow(
      'database read failed'
    );
    expect(queryHandlers).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });
});

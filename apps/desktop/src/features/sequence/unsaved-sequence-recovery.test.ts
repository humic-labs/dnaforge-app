import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

const DOC = 'sequence-document-recovery';

function makeSequence(sequence = 'AAAACCCCGGGG'): AnnotatedSequence {
  return {
    id: DOC,
    name: 'pFixture',
    length: sequence.length,
    sequence,
    annotations: [],
    metadata: {},
    circular: false,
  };
}

async function startSession() {
  vi.resetModules();
  const { useSequenceStore } = await import('./store');
  const { useToastStore } = await import('../../stores/toast-store');
  const recovery = await import('./unsaved-sequence-recovery');
  const stop = recovery.startUnsavedSequenceRecovery();
  return { useSequenceStore, useToastStore, recovery, stop };
}

const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  const { deleteUnsavedSequenceEntry } = await import('./unsaved-sequence-recovery');
  await deleteUnsavedSequenceEntry(DOC);
});

async function crashWithUnsavedEdit() {
  const first = await startSession();
  stops.push(first.stop);
  first.useSequenceStore.getState().setSequence(DOC, makeSequence());
  first.useSequenceStore.getState().dispatchEdit(DOC, { type: 'SET_CURSOR', position: 4 });
  first.useSequenceStore.getState().dispatchEdit(DOC, { type: 'INSERT', text: 'TTT' });
  expect(first.useSequenceStore.getState().dirtyPaths[DOC]).toBe(true);
  await vi.waitFor(
    async () => expect(await first.recovery.readUnsavedSequenceEntry(DOC)).toBeDefined(),
    { timeout: 3000 }
  );
  first.stop();
  return first.useSequenceStore.getState().sequences[DOC]!.sequence;
}

describe('unsaved sequence recovery ', { timeout: 20_000 }, () => {
  it('restores edits lost with the previous window when the document is reopened', async () => {
    const lostWorking = await crashWithUnsavedEdit();
    expect(lostWorking).toBe('AAAATTTCCCCGGGG');

    const second = await startSession();
    stops.push(second.stop);
    second.useSequenceStore.getState().setSequence(DOC, makeSequence());

    const toast = await vi.waitFor(
      () => {
        const found = second.useToastStore
          .getState()
          .toasts.find((t) => t.definition === 'unsaved-sequence-recovery-available');
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5000 }
    );
    expect(toast.message).toContain('pFixture');
    expect(toast.actions?.map((a) => a.label)).toEqual(['Restore', 'Discard']);

    second.useToastStore.getState().invokeToastAction(toast.id, 0);
    const state = second.useSequenceStore.getState();
    expect(state.dirtyPaths[DOC]).toBe(true);
    expect(state.sequences[DOC]!.sequence).toBe(lostWorking);
    expect(state.drafts[DOC]!.insertedRanges.length).toBeGreaterThan(0);
  });

  it('brings back primer links staged by a rich paste', async () => {
    const first = await startSession();
    stops.push(first.stop);
    first.useSequenceStore.getState().setSequence(DOC, makeSequence());
    first.useSequenceStore.getState().dispatchEdit(DOC, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'TTTTTT',
        annotations: [],
        primerBindings: [{ primerId: 'primer-1', start: 0, end: 6, strand: 1 }],
      },
    });
    const staged = first.useSequenceStore.getState().drafts[DOC]!.pendingPrimerBindings;
    expect(staged).toHaveLength(1);
    await vi.waitFor(
      async () =>
        expect(
          (await first.recovery.readUnsavedSequenceEntry(DOC))?.content.pendingPrimerBindings
        ).toHaveLength(1),
      { timeout: 3000 }
    );
    first.stop();

    const second = await startSession();
    stops.push(second.stop);
    second.useSequenceStore.getState().setSequence(DOC, makeSequence());
    const toast = await vi.waitFor(
      () => {
        const found = second.useToastStore
          .getState()
          .toasts.find((t) => t.definition === 'unsaved-sequence-recovery-available');
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5000 }
    );
    second.useToastStore.getState().invokeToastAction(toast.id, 0);
    expect(second.useSequenceStore.getState().drafts[DOC]!.pendingPrimerBindings).toEqual(staged);
  });

  it('does not offer edits made against a file that has changed since', async () => {
    await crashWithUnsavedEdit();

    const second = await startSession();
    stops.push(second.stop);
    second.useSequenceStore.getState().setSequence(DOC, makeSequence('GGGGGGGG'));

    await vi.waitFor(
      () =>
        expect(
          second.useToastStore
            .getState()
            .toasts.some((t) => t.definition === 'unsaved-sequence-recovery-outdated')
        ).toBe(true),
      { timeout: 5000 }
    );
    expect(
      second.useToastStore
        .getState()
        .toasts.some((t) => t.definition === 'unsaved-sequence-recovery-available')
    ).toBe(false);
    expect(await second.recovery.readUnsavedSequenceEntry(DOC)).toBeUndefined();
  });

  it('drops the copy once the edits are saved or discarded', async () => {
    const session = await startSession();
    stops.push(session.stop);
    const store = session.useSequenceStore;
    store.getState().setSequence(DOC, makeSequence());
    store.getState().dispatchEdit(DOC, { type: 'INSERT', text: 'A' });
    await vi.waitFor(
      async () => expect(await session.recovery.readUnsavedSequenceEntry(DOC)).toBeDefined(),
      { timeout: 3000 }
    );
    store.getState().markClean(DOC);
    await vi.waitFor(
      async () => expect(await session.recovery.readUnsavedSequenceEntry(DOC)).toBeUndefined(),
      { timeout: 5000 }
    );
  });
});

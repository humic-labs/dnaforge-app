import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationPreparingNotice,
} from '../shared/workspace-renderer-mutation';
import {
  WorkspaceRendererMutationPublisher,
  type WorkspaceRendererMutationPublisherDeps,
} from './workspace-renderer-mutation-publisher';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';

const NOTICE: WorkspaceRendererMutationPreparingNotice = {
  workspaceRoot: '/managed/local-folder',
  source: { kind: 'cloud-sync', workspaceUuid: 'workspace-a', remoteVersionId: 'version-a' },
  affectedNotebookIds: ['note-a'],
  affectedDesignIds: [],
  affectedEntityIds: ['note-a', 'record-a'],
};
const APPLIED = {
  ...NOTICE,
  changedPaths: ['/managed/local-folder/Notes.md'],
  deletedPaths: [],
  deletedDesignIds: [],
  deletedEntityIds: [],
};
type AckListener = Parameters<WorkspaceRendererMutationPublisherDeps['subscribeAck']>[0];
function harness() {
  const sent: WorkspaceRendererMutationEvent[] = [];
  let listener: AckListener | null = null;
  let generation = 'load-a';
  const publisher = new WorkspaceRendererMutationPublisher({
    getTarget: () => ({ id: 7, generation, isDestroyed: () => false }),
    send: (_target, event) => sent.push(event),
    subscribeAck: (callback) => {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    createDeliveryId: () => 'delivery-1',
    timeoutMs: 25,
  });
  return {
    publisher,
    reload() {
      generation = 'load-b';
    },
    sent,
    ack(senderId = 7, phase = 'preparing', deliveryId = 'delivery-1') {
      if (!listener) throw new Error('ACK listener missing');
      listener(senderId, { deliveryId, phase, status: 'ok' });
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  workspaceMutationCapabilities.releaseOwner(7);
});

describe('workspace renderer mutation handoff', () => {
  it('refuses a preparation from an earlier document load in the same WebContents', async () => {
    const { publisher, ack, reload, sent } = harness();
    const preparing = publisher.prepare(NOTICE);
    ack();
    const id = await preparing;
    reload();
    await expect(publisher.publish(id, APPLIED)).rejects.toThrow(/no longer available/i);
    expect(sent.some((event) => event.phase === 'applied')).toBe(false);
    publisher.stop();
  });

  it.each(['actionId', 'documentId', 'sourcePath'] as const)(
    'binds native document preparation to its exact %s',
    async (field) => {
      const { publisher, ack, sent } = harness();
      const notice: WorkspaceRendererMutationPreparingNotice = {
        ...NOTICE,
        source: {
          kind: 'document-command',
          actionId: 'action-a',
          documentId: 'document-a',
          sourcePath: '/managed/local-folder/document.gb',
        },
      };
      const preparing = publisher.prepare(notice);
      ack();
      const id = await preparing;
      await expect(
        publisher.publish(id, {
          ...APPLIED,
          ...notice,
          source: { ...notice.source, [field]: 'changed' },
        })
      ).rejects.toThrow(/authority changed/i);
      expect(sent.some((event) => event.phase === 'applied')).toBe(false);
      publisher.abort(id, notice, 'unchanged');
      publisher.stop();
    }
  );

  it('requires exact sender acknowledgements and revokes the cloud refresh capability', async () => {
    const { publisher, sent, ack } = harness();
    let ready = false;
    const preparation = publisher.prepare(NOTICE).then((id) => {
      ready = true;
      return id;
    });
    ack(8);
    ack(7, 'applied');
    ack(7, 'preparing', 'wrong');
    await Promise.resolve();
    expect(ready).toBe(false);
    ack();
    const id = await preparation;
    const applying = publisher.publish(id, APPLIED);
    expect(sent[1]).toMatchObject({
      phase: 'applied',
      source: NOTICE.source,
      mutationToken: expect.any(String),
    });
    const applied = sent[1];
    if (applied?.phase !== 'applied') throw new Error('Applied event missing');
    expect(
      await workspaceMutationCapabilities.runWithToken(
        applied.mutationToken,
        7,
        NOTICE.workspaceRoot,
        async () => true
      )
    ).toEqual({ active: true, value: true });
    ack(7, 'applied');
    await applying;
    expect(workspaceMutationCapabilities.activeCountForTest(7)).toBe(0);
    publisher.stop();
  });

  it.each(['root', 'source', 'action', 'entities'] as const)(
    'refuses changed %s authority after preparation',
    async (variant) => {
      const { publisher, sent, ack } = harness();
      const preparing = publisher.prepare(NOTICE);
      ack();
      const id = await preparing;
      const changed =
        variant === 'root'
          ? { ...APPLIED, workspaceRoot: '/another/workspace' }
          : variant === 'source'
            ? {
                ...APPLIED,
                source: {
                  kind: 'cloud-sync' as const,
                  workspaceUuid: 'cloud-a',
                  remoteVersionId: 'version-a',
                },
              }
            : variant === 'action'
              ? {
                  ...APPLIED,
                  source: {
                    ...NOTICE.source,
                    remoteVersionId: 'other-version',
                  },
                }
              : { ...APPLIED, affectedEntityIds: ['different-record'] };
      await expect(publisher.publish(id, changed)).rejects.toThrow(/authority changed/i);
      expect(sent.some((event) => event.phase === 'applied')).toBe(false);
      expect(workspaceMutationCapabilities.activeCountForTest(7)).toBe(0);
      publisher.abort(id, NOTICE, 'unchanged');
      publisher.stop();
    }
  );

  it('keeps post-commit failure distinct from an unchanged abort and revokes its capability', async () => {
    vi.useFakeTimers();
    const { publisher, sent, ack } = harness();
    const preparing = publisher.prepare(NOTICE);
    ack();
    const applying = publisher.publish(await preparing, APPLIED);
    const rejection = expect(applying).rejects.toThrow(/did not acknowledge/);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(sent.at(-1)).toMatchObject({
      phase: 'released',
      disposition: 'needs-recovery',
      source: NOTICE.source,
    });
    expect(workspaceMutationCapabilities.activeCountForTest(7)).toBe(0);
    publisher.stop();
  });

  it('freezes the preparation authority rather than retaining a caller-mutable object', async () => {
    const { publisher, ack } = harness();
    const mutable = structuredClone(NOTICE);
    const preparing = publisher.prepare(mutable);
    ack();
    const id = await preparing;
    mutable.affectedEntityIds.push('late-record');
    await expect(
      publisher.publish(id, { ...APPLIED, affectedEntityIds: mutable.affectedEntityIds })
    ).rejects.toThrow(/authority changed/i);
    publisher.abort(id, NOTICE, 'unchanged');
    publisher.stop();
  });
});

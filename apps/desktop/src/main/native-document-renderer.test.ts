import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRendererMutationEvent } from '../shared/workspace-renderer-mutation';
import {
  WorkspaceRendererMutationPublisher,
  type WorkspaceRendererMutationPublisherDeps,
} from './workspace-renderer-mutation-publisher';
import { createNativeDocumentMutationBarrier } from './native-document-renderer';

vi.mock('../shared/ipc-contract', () => ({ mainIpc: {}, sendRendererIpc: vi.fn() }));
vi.mock('./ipc/shell-readiness', () => ({ getShellReadiness: vi.fn() }));

const document = {
  documentId: 'document-a',
  workspaceRoot: '/workspace',
  sourcePath: '/workspace/document.gb',
};

function harness(connected = true, failure?: 'preparing' | 'applied') {
  let ack: Parameters<WorkspaceRendererMutationPublisherDeps['subscribeAck']>[0] | undefined;
  const sent: WorkspaceRendererMutationEvent[] = [];
  const publisher = new WorkspaceRendererMutationPublisher({
    getTarget: () => (connected ? { id: 42, isDestroyed: () => false } : null),
    subscribeAck(listener) {
      ack = listener;
      return () => {
        ack = undefined;
      };
    },
    send(_target, event) {
      sent.push(event);
      if (event.phase !== 'released')
        queueMicrotask(() =>
          ack?.(42, {
            deliveryId: event.deliveryId,
            phase: event.phase,
            status: event.phase === failure ? 'failed' : 'ok',
            error: 'Client refusal',
          })
        );
    },
  });
  return { publisher, sent };
}

describe('native document editing barrier', () => {
  it('captures the source path before a caller changes its locator object', async () => {
    const { publisher, sent } = harness();
    const mutable = { ...document };
    const barrier = await createNativeDocumentMutationBarrier(publisher, 'action-a')(mutable);
    mutable.sourcePath = '/workspace/another.gb';
    await barrier.finish();
    expect(sent[1]).toMatchObject({ changedPaths: [document.sourcePath] });
    publisher.stop();
  });

  it('requires acknowledged protection and refresh for the exact stable document', async () => {
    const { publisher, sent } = harness();
    const barrier = await createNativeDocumentMutationBarrier(publisher, 'action-a')(document);
    expect(sent[0]).toMatchObject({
      phase: 'preparing',
      affectedEntityIds: ['document-a'],
      source: {
        kind: 'document-command',
        actionId: 'action-a',
        documentId: 'document-a',
        sourcePath: document.sourcePath,
      },
    });
    expect(await barrier.finish()).toBe('refreshed');
    expect(sent[1]).toMatchObject({ phase: 'applied', changedPaths: [document.sourcePath] });
    barrier.abort('needs-recovery');
    expect(sent).toHaveLength(2);
    publisher.stop();
  });

  it('does not interpret a missing application window as a headless editing authority', async () => {
    const { publisher } = harness(false);
    await expect(
      createNativeDocumentMutationBarrier(publisher, 'action-a')(document)
    ).rejects.toThrow(/No connected editing client/);
    publisher.stop();
  });

  it('refuses dirty or busy editing clients before publication', async () => {
    const { publisher, sent } = harness(true, 'preparing');
    await expect(
      createNativeDocumentMutationBarrier(publisher, 'action-a')(document)
    ).rejects.toThrow(/Client refusal/);
    expect(sent.at(-1)).toMatchObject({ phase: 'released', disposition: 'unchanged' });
    publisher.stop();
  });

  it('requests recovery when a committed document could not be refreshed', async () => {
    const { publisher, sent } = harness(true, 'applied');
    const barrier = await createNativeDocumentMutationBarrier(publisher, 'action-a')(document);
    await expect(barrier.finish()).rejects.toThrow(/Client refusal/);
    barrier.abort('needs-recovery');
    expect(sent.at(-1)).toMatchObject({ phase: 'released', disposition: 'needs-recovery' });
    publisher.stop();
  });
});

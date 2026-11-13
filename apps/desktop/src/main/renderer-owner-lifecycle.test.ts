import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';

import { RendererOwnerLifecycle } from './renderer-owner-lifecycle';
import { WorkspaceMutationCapabilityRegistry } from './ipc/workspace-mutation-capability';
import {
  acquireWorkspaceMutationShared,
  waitForWorkspaceMutationShared,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';

function renderer(): { sender: WebContents; events: EventEmitter } {
  const events = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false });
  return { sender: events as unknown as WebContents, events };
}

describe('renderer ownership across page replacement', () => {
  it('admits the committed replacement when hang recovery starts navigation inside renderer-exit dispatch', () => {
    const owner = renderer();

    owner.events.on('render-process-gone', () => {
      owner.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    });
    const capabilities = new WorkspaceMutationCapabilityRegistry();
    const lifecycle = new RendererOwnerLifecycle((sender) => capabilities.releaseOwner(sender.id));
    const oldGeneration = lifecycle.register(owner.sender);
    const staleToken = capabilities.issue(owner.sender.id, '/project', () => undefined);

    owner.events.emit('render-process-gone');
    expect(capabilities.resolveOwnedWorkspaceRoot(staleToken, owner.sender.id)).toBeNull();
    expect(() => lifecycle.register(owner.sender)).toThrow('owner admission');

    owner.events.emit('did-frame-navigate', {}, 'app://subframe', 200, 'OK', false);
    owner.events.emit('did-stop-loading');
    expect(() => lifecycle.register(owner.sender)).toThrow('owner admission');

    owner.events.emit('did-frame-navigate', {}, 'app://renderer', 200, 'OK', true);
    expect(lifecycle.register(owner.sender)).toBe(oldGeneration + 2);
    expect(() => lifecycle.assertCurrent(owner.sender, oldGeneration)).toThrow('owner admission');
  });

  it('rejects a delayed outgoing-page admission after reload cleanup, then admits the committed page', async () => {
    const root = `/tmp/reload-admission-${crypto.randomUUID()}`;
    const capabilities = new WorkspaceMutationCapabilityRegistry();
    const lifecycle = new RendererOwnerLifecycle((sender) => capabilities.releaseOwner(sender.id));
    const owner = renderer();
    const oldGeneration = lifecycle.register(owner.sender);
    capabilities.issue(owner.sender.id, root, await acquireWorkspaceMutationShared(root));

    owner.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(capabilities.activeCountForTest()).toBe(0);
    expect(() => lifecycle.assertCurrent(owner.sender, oldGeneration)).toThrow('owner admission');
    expect(() => lifecycle.register(owner.sender)).toThrow('owner admission');

    owner.events.emit('did-frame-navigate', {}, 'app://renderer', 200, 'OK', true);
    const newGeneration = lifecycle.register(owner.sender);
    expect(newGeneration).toBe(oldGeneration + 1);
    const freshToken = capabilities.issue(
      owner.sender.id,
      root,
      await waitForWorkspaceMutationShared(root)
    );
    expect(capabilities.release(freshToken, owner.sender.id)).toBe(true);
  });

  it('keeps the root locked until a borrowed file operation drains, and aborts old admission waits', async () => {
    const root = `/tmp/reload-borrowed-${crypto.randomUUID()}`;
    const capabilities = new WorkspaceMutationCapabilityRegistry();
    const waitAbort = new AbortController();
    const lifecycle = new RendererOwnerLifecycle((sender) => {
      waitAbort.abort();
      capabilities.releaseOwner(sender.id);
    });
    const owner = renderer();
    lifecycle.register(owner.sender);
    const token = capabilities.issue(
      owner.sender.id,
      root,
      await acquireWorkspaceMutationShared(root)
    );
    let finishWrite!: () => void;
    const writing = capabilities.runWithToken(
      token,
      owner.sender.id,
      root,
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const abandonedWait = waitForWorkspaceMutationShared(root, { signal: waitAbort.signal });
    const rejectedWait = expect(abandonedWait).rejects.toThrow('WORKSPACE_MUTATION_WAIT_ABORTED');
    expect(workspaceMutationWaiterCountForTest(root)).toBe(1);

    owner.events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await rejectedWait;
    expect(workspaceMutationWaiterCountForTest(root)).toBe(0);
    expect(capabilities.activeCountForTest()).toBe(1);
    expect(() => lifecycle.register(owner.sender)).toThrow('owner admission');
    owner.events.emit('did-frame-navigate', {}, 'app://renderer', 200, 'OK', true);
    lifecycle.register(owner.sender);

    let replacementEntered = false;
    const replacing = waitForWorkspaceMutationShared(root).then((release) => {
      replacementEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(replacementEntered).toBe(false);
    finishWrite();
    await writing;
    const release = await replacing;
    expect(replacementEntered).toBe(true);
    expect(capabilities.activeCountForTest()).toBe(0);
    release();
  });
});

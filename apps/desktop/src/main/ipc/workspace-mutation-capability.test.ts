import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
} from '../workspace-sync-mutation-lease';
import {
  MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER,
  MAX_WORKSPACE_MUTATION_TOKENS_PER_SESSION,
  WorkspaceMutationCapabilityRegistry,
} from './workspace-mutation-capability';

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkspaceMutationCapabilityRegistry', () => {
  it('holds a shared lease until the owning renderer ends the transaction', async () => {
    const root = `/tmp/workspace-mutation-${crypto.randomUUID()}`;
    const releaseShared = await acquireWorkspaceMutationShared(root);
    const registry = new WorkspaceMutationCapabilityRegistry();
    const token = registry.issue(41, root, releaseShared);
    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(root).then((release) => {
      pullEntered = true;
      return release;
    });

    await Promise.resolve();
    expect(pullEntered).toBe(false);
    expect(() => registry.release(token, 42)).toThrow('OWNER_MISMATCH');
    expect(registry.release(token, 41)).toBe(true);

    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    releasePull();
  });

  it('does not release a healthy slow operation while it can still mutate', async () => {
    vi.useFakeTimers();
    const root = `/tmp/workspace-mutation-${crypto.randomUUID()}`;
    const releaseShared = await acquireWorkspaceMutationShared(root);
    const registry = new WorkspaceMutationCapabilityRegistry();
    const token = registry.issue(41, root, releaseShared);
    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(root).then((release) => {
      pullEntered = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(pullEntered).toBe(false);
    expect(registry.activeCountForTest()).toBe(1);
    registry.release(token, 41);
    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    releasePull();
  });

  it('runs nested owner work through the production reentry path while a pull is queued', async () => {
    const root = `/tmp/workspace-mutation-${crypto.randomUUID()}`;
    const releaseShared = await acquireWorkspaceMutationShared(root);
    const registry = new WorkspaceMutationCapabilityRegistry();
    const token = registry.issue(41, root, releaseShared);
    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(root).then((release) => {
      pullEntered = true;
      return release;
    });

    await Promise.resolve();
    let unrelatedMutationEntered = false;
    const unrelatedMutation = acquireWorkspaceMutationShared(root).then((release) => {
      unrelatedMutationEntered = true;
      return release;
    });

    await expect(
      registry.runWithToken(token, 41, root, async () => 'completed under outer lease')
    ).resolves.toEqual({ active: true, value: 'completed under outer lease' });
    await expect(
      registry.runWithToken(token, 42, root, async () => 'wrong owner')
    ).resolves.toEqual({ active: false });
    await expect(
      registry.runWithToken('unrelated-token', 41, root, async () => 'unrelated operation')
    ).resolves.toEqual({ active: false });
    expect(pullEntered).toBe(false);
    expect(unrelatedMutationEntered).toBe(false);

    registry.release(token, 41);
    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    expect(unrelatedMutationEntered).toBe(false);
    releasePull();
    const releaseUnrelatedMutation = await unrelatedMutation;
    expect(unrelatedMutationEntered).toBe(true);
    releaseUnrelatedMutation();
  });

  it('issues nested begin tokens against one underlying workspace lock', async () => {
    const root = `/tmp/workspace-mutation-${crypto.randomUUID()}`;
    const releaseShared = await acquireWorkspaceMutationShared(root);
    const registry = new WorkspaceMutationCapabilityRegistry();
    const outerToken = registry.issue(41, root, releaseShared);
    const innerToken = registry.issueReentry(outerToken, 41, root);
    expect(innerToken).not.toBeNull();
    if (!innerToken) throw new Error('Expected nested mutation token.');
    expect(registry.issueReentry(outerToken, 42, root)).toBeNull();
    expect(registry.issueReentry('unrelated-token', 41, root)).toBeNull();

    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(root).then((release) => {
      pullEntered = true;
      return release;
    });
    registry.release(outerToken, 41);
    await Promise.resolve();
    expect(pullEntered).toBe(false);
    expect(registry.activeCountForTest()).toBe(1);

    registry.release(innerToken, 41);
    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    expect(registry.activeCountForTest()).toBe(0);
    releasePull();
  });

  it('defers lifecycle release until an already-started nested operation settles', async () => {
    const root = `/tmp/workspace-mutation-${crypto.randomUUID()}`;
    const releaseShared = await acquireWorkspaceMutationShared(root);
    const registry = new WorkspaceMutationCapabilityRegistry();
    const token = registry.issue(41, root, releaseShared);
    let finishNested: (() => void) | undefined;
    const nested = registry.runWithToken(
      token,
      41,
      root,
      () => new Promise<void>((resolve) => (finishNested = resolve))
    );
    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(root).then((release) => {
      pullEntered = true;
      return release;
    });

    registry.releaseOwner(41);
    await Promise.resolve();
    expect(pullEntered).toBe(false);
    expect(registry.activeCountForTest()).toBe(1);

    finishNested?.();
    await expect(nested).resolves.toEqual({ active: true, value: undefined });
    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    expect(registry.activeCountForTest()).toBe(0);
    releasePull();
  });

  it('caps reentry tokens within one renderer mutation session', () => {
    const registry = new WorkspaceMutationCapabilityRegistry();
    const releaseMutation = vi.fn();
    const root = `/tmp/workspace-mutation-${crypto.randomUUID()}`;
    const tokens = [registry.issue(41, root, releaseMutation)];

    for (let index = 1; index < MAX_WORKSPACE_MUTATION_TOKENS_PER_SESSION; index += 1) {
      const token = registry.issueReentry(tokens[0], 41, root);
      expect(token).not.toBeNull();
      if (token) tokens.push(token);
    }
    expect(registry.issueReentry(tokens[0], 41, root)).toBeNull();

    for (const token of tokens) expect(registry.release(token, 41)).toBe(true);
    expect(registry.activeCountForTest()).toBe(0);
    expect(releaseMutation).toHaveBeenCalledOnce();
  });

  it('caps all outstanding mutation tokens owned by one renderer', () => {
    const registry = new WorkspaceMutationCapabilityRegistry();
    const releaseMutation = vi.fn();

    for (let index = 0; index < MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER; index += 1) {
      registry.issue(41, `/tmp/workspace-owner-cap-${index}`, releaseMutation);
    }
    expect(() => registry.issue(41, '/tmp/workspace-owner-cap-overflow', releaseMutation)).toThrow(
      'WORKSPACE_MUTATION_OWNER_TOKEN_LIMIT'
    );

    registry.releaseOwner(41);
    expect(registry.activeCountForTest()).toBe(0);
    expect(releaseMutation).toHaveBeenCalledTimes(MAX_WORKSPACE_MUTATION_TOKENS_PER_OWNER);
  });

  it('revokes every descendant and drains already-started work before settling', async () => {
    const registry = new WorkspaceMutationCapabilityRegistry();
    const releaseMutation = vi.fn();
    const root = `/tmp/workspace-revocation-${crypto.randomUUID()}`;
    const capability = registry.issueRevocable(41, root, releaseMutation);
    const child = registry.issueReentry(capability.token, 41, root);
    expect(child).not.toBeNull();
    if (!child) throw new Error('Expected a child capability.');
    let finishOperation: (() => void) | undefined;
    const active = registry.runWithToken(
      child,
      41,
      root,
      () => new Promise<void>((resolve) => (finishOperation = resolve))
    );

    let revoked = false;
    const revoking = capability.revoke().then(() => {
      revoked = true;
    });
    await Promise.resolve();
    expect(revoked).toBe(false);
    await expect(
      registry.runWithToken(child, 41, root, async () => 'stale child entered')
    ).resolves.toEqual({ active: false });
    await expect(
      registry.runWithToken(capability.token, 41, root, async () => 'stale parent entered')
    ).resolves.toEqual({ active: false });

    finishOperation?.();
    await expect(active).resolves.toEqual({ active: true, value: undefined });
    await revoking;
    expect(revoked).toBe(true);
    expect(registry.activeCountForTest()).toBe(0);
    expect(releaseMutation).toHaveBeenCalledOnce();
  });
});

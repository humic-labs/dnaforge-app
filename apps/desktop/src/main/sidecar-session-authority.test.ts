import { describe, expect, it, vi } from 'vitest';

import {
  SidecarSessionAuthority,
  SidecarSessionUnavailableError,
} from './sidecar-session-authority';

function tokenSequence(...tokens: string[]): () => string {
  let index = 0;
  return () => tokens[index++] ?? `unexpected-${index}`;
}

describe('SidecarSessionAuthority', () => {
  it('binds the native writer to one profile before any child starts', () => {
    const authority = new SidecarSessionAuthority();
    const profile = 'a'.repeat(64);
    authority.bindNativeDocumentProfile(profile);
    const first = authority.nativeDocumentAuthority(authority.snapshot());
    expect(first?.ownerInstanceId).toMatch(/^native-v1:a{64}:[a-f0-9-]{36}$/);
    authority.bindNativeDocumentProfile(profile);
    expect(authority.nativeDocumentAuthority(authority.snapshot())).toEqual(first);
    expect(() => authority.bindNativeDocumentProfile('b'.repeat(64))).toThrow(/profile/i);
    authority.prepareManagedSpawn('initial');
    expect(() => authority.bindNativeDocumentProfile(profile)).toThrow(/started/i);
  });

  it('does not relabel an externally supplied native owner as this profile', () => {
    const authority = new SidecarSessionAuthority({
      initialToken: 'external-session',
      initialNativeDocumentToken: 'external-native',
      initialNativeDocumentOwnerId: 'external-owner',
    });
    authority.bindNativeDocumentProfile('a'.repeat(64));
    expect(authority.nativeDocumentAuthority(authority.snapshot())?.ownerInstanceId).toBe(
      'external-owner'
    );
  });

  it('keeps native document authority private and rotates it with the sidecar session', () => {
    const authority = new SidecarSessionAuthority();
    const first = authority.prepareManagedSpawn('initial');
    const native = authority.nativeDocumentAuthority(first);
    expect(native?.token).toBeTruthy();
    expect(native?.token).not.toBe(first.token);
    expect(native?.token).not.toBe(authority.humanOperationToken(first));
    expect(Object.values(first)).not.toContain(native?.token);
    const second = authority.prepareManagedSpawn('respawn');
    expect(authority.nativeDocumentAuthority(second)?.token).not.toBe(native?.token);
    expect(authority.nativeDocumentAuthority(second)?.ownerInstanceId).toBe(
      native?.ownerInstanceId
    );
    expect(() => authority.nativeDocumentAuthority(first)).toThrow(SidecarSessionUnavailableError);
    authority.markStopped();
    expect(() => authority.nativeDocumentAuthority(authority.snapshot())).toThrow(
      SidecarSessionUnavailableError
    );
  });

  it('does not infer native document authority from an external human or agent connection', () => {
    const authority = new SidecarSessionAuthority({
      initialToken: 'external-session',
      initialHumanOperationToken: 'external-human',
    });
    expect(
      authority.nativeDocumentAuthority(authority.prepareManagedSpawn('initial'))
    ).toBeUndefined();
    const native = new SidecarSessionAuthority({
      initialToken: 'external-session',
      initialNativeDocumentToken: 'external-native',
      initialNativeDocumentOwnerId: 'native-owner',
    });
    expect(native.nativeDocumentAuthority(native.prepareManagedSpawn('initial'))).toEqual({
      token: 'external-native',
      ownerInstanceId: 'native-owner',
    });
  });
  it('keeps human operation authority separate from the credential delegated to agents', () => {
    const authority = new SidecarSessionAuthority();
    const first = authority.prepareManagedSpawn('initial');
    const humanToken = authority.humanOperationToken(first);
    expect(humanToken).toBeTruthy();
    expect(humanToken).not.toBe(first.token);
    expect(Object.values(first)).not.toContain(humanToken);

    const second = authority.prepareManagedSpawn('respawn');
    expect(authority.humanOperationToken(second)).not.toBe(humanToken);
    expect(() => authority.humanOperationToken(first)).toThrow(SidecarSessionUnavailableError);
  });

  it('requires an explicit human credential when attaching to an external runtime', () => {
    const agentOnly = new SidecarSessionAuthority({ initialToken: 'agent-session' });
    expect(agentOnly.humanOperationToken(agentOnly.prepareManagedSpawn('initial'))).toBeUndefined();
    const human = new SidecarSessionAuthority({
      initialToken: 'agent-session',
      initialHumanOperationToken: 'human-authority',
    });
    expect(human.humanOperationToken(human.prepareManagedSpawn('initial'))).toBe('human-authority');
    expect(human.humanOperationToken(human.prepareManagedSpawn('respawn'))).toBe('human-authority');
  });

  it('owns a generated current token before any desktop caller can run', () => {
    const authority = new SidecarSessionAuthority({
      mintToken: tokenSequence('bootstrap-token'),
    });

    expect(authority.snapshot()).toEqual({
      owner: 'electron',
      generation: 0,
      state: 'starting',
      token: 'bootstrap-token',
    });
  });

  it('rotates before every Electron-managed child spawn', () => {
    const authority = new SidecarSessionAuthority({
      mintToken: tokenSequence('bootstrap', 'generation-1', 'generation-2'),
    });

    const first = authority.prepareManagedSpawn('initial');
    authority.markReady(first.generation);
    const second = authority.prepareManagedSpawn('respawn');

    expect(first).toMatchObject({ generation: 1, state: 'starting', token: 'generation-1' });
    expect(second).toMatchObject({
      generation: 2,
      state: 'restarting',
      token: 'generation-2',
    });
    expect(second.token).not.toBe(first.token);
  });

  it('releases a token only while the current generation is ready', () => {
    const authority = new SidecarSessionAuthority({
      mintToken: tokenSequence('bootstrap', 'generation-1'),
    });

    expect(() => authority.currentToken()).toThrow(SidecarSessionUnavailableError);
    const first = authority.prepareManagedSpawn('initial');
    expect(() => authority.currentToken()).toThrow(SidecarSessionUnavailableError);
    expect(authority.markReady(first.generation)).toBe(true);
    expect(authority.currentToken()).toBe('generation-1');

    authority.markRestarting();
    expect(() => authority.currentToken()).toThrow(SidecarSessionUnavailableError);
  });

  it('keeps an externally owned token stable while tracking generations', () => {
    const authority = new SidecarSessionAuthority({
      initialToken: 'external-token',
      mintToken: tokenSequence('must-not-be-used'),
    });

    const first = authority.prepareManagedSpawn('initial');
    const second = authority.prepareManagedSpawn('manual_restart');

    expect(first).toMatchObject({ owner: 'external', generation: 1, token: 'external-token' });
    expect(second).toMatchObject({ owner: 'external', generation: 2, token: 'external-token' });
  });

  it('ignores stale readiness and fails locally after stop', () => {
    const authority = new SidecarSessionAuthority({
      mintToken: tokenSequence('bootstrap', 'generation-1', 'generation-2'),
    });
    const first = authority.prepareManagedSpawn('initial');
    authority.prepareManagedSpawn('respawn');

    expect(authority.markReady(first.generation)).toBe(false);
    authority.markStopped();
    expect(() => authority.currentToken()).toThrow(SidecarSessionUnavailableError);
  });

  it('recognizes only the exact current generation and lifecycle state', () => {
    const authority = new SidecarSessionAuthority({
      mintToken: tokenSequence('bootstrap', 'generation-1', 'generation-2'),
    });
    const first = authority.prepareManagedSpawn('initial');

    expect(authority.isCurrent(first)).toBe(true);
    authority.markRestarting();
    expect(authority.isCurrent(first)).toBe(false);

    const second = authority.prepareManagedSpawn('respawn');
    expect(authority.isCurrent(second)).toBe(true);
    expect(authority.isCurrent(first)).toBe(false);
  });

  it('holds callers until the current generation becomes ready', async () => {
    const authority = new SidecarSessionAuthority({
      mintToken: tokenSequence('bootstrap', 'generation-1'),
    });
    const spawn = authority.prepareManagedSpawn('initial');
    let settled = false;
    const pending = authority.waitForReadySnapshot().then((snapshot) => {
      settled = true;
      return snapshot;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(authority.markReady(spawn.generation)).toBe(true);
    await expect(pending).resolves.toMatchObject({
      generation: 1,
      state: 'ready',
      token: 'generation-1',
    });
  });

  it('fails pending callers when the authority stops', async () => {
    const authority = new SidecarSessionAuthority({ mintToken: tokenSequence('bootstrap') });
    const pending = authority.waitForReadySnapshot();
    authority.markStopped();
    await expect(pending).rejects.toThrow(SidecarSessionUnavailableError);
  });

  it.each(['ready', 'stop', 'abort', 'timeout'] as const)(
    'removes the abort listener and timer after %s',
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const authority = new SidecarSessionAuthority();
        const spawn = authority.prepareManagedSpawn('initial');
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        const pending = authority.waitForReadySnapshot(100, controller.signal);
        const settled = pending.then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error })
        );
        expect(vi.getTimerCount()).toBe(1);
        if (outcome === 'ready') authority.markReady(spawn.generation);
        if (outcome === 'stop') authority.markStopped();
        if (outcome === 'abort') controller.abort();
        if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(100);
        const result = await settled;
        if (outcome === 'ready') expect(result.value).toMatchObject({ state: 'ready' });
        else expect(result.error).toBeInstanceOf(Error);
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('rejects an already aborted caller even when the authority is ready', async () => {
    const authority = new SidecarSessionAuthority();
    authority.markReady(authority.prepareManagedSpawn('initial').generation);
    const controller = new AbortController();
    controller.abort();
    await expect(authority.waitForReadySnapshot(30_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

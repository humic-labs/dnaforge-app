import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decideAbandonedLockHolders,
  parsePsProcessList,
  reclaimAbandonedLockHolders,
} from './sidecar-owner-reclaim';

describe('abandoned profile-lock holders', () => {
  it('starts a fresh profile without asking a blocked process inspector about an absent lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sidecar-absent-owner-lock-'));
    const listLockHolders = vi.fn(() => {
      throw new Error('spawnSync lsof ETIMEDOUT');
    });
    const listProcesses = vi.fn(() => []);
    const signal = vi.fn();
    try {
      expect(existsSync(join(directory, 'never-created.lock'))).toBe(false);
      await expect(
        reclaimAbandonedLockHolders({
          lockPath: join(directory, 'never-created.lock'),
          appPid: process.pid,
          currentChildPid: null,
          listLockHolders,
          listProcesses,
          signal,
        })
      ).resolves.toEqual({ kill: [], blockedByLiveParent: [] });
      expect(listLockHolders).not.toHaveBeenCalled();
      expect(listProcesses).not.toHaveBeenCalled();
      expect(signal).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not inspect process ancestry when an existing lock has no holders', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sidecar-unheld-owner-lock-'));
    const lockPath = join(directory, 'unheld.lock');
    writeFileSync(lockPath, '');
    const listLockHolders = vi.fn(() => []);
    const listProcesses = vi.fn(() => {
      throw new Error('spawnSync ps ETIMEDOUT');
    });
    const signal = vi.fn();
    try {
      expect(existsSync(lockPath)).toBe(true);
      await expect(
        reclaimAbandonedLockHolders({
          lockPath,
          appPid: process.pid,
          currentChildPid: null,
          listLockHolders,
          listProcesses,
          signal,
        })
      ).resolves.toEqual({ kill: [], blockedByLiveParent: [] });
      expect(listLockHolders).toHaveBeenCalledWith(lockPath);
      expect(listProcesses).not.toHaveBeenCalled();
      expect(signal).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not inspect processes when the exact lock file is absent', async () => {
    const listLockHolders = vi.fn(() => [10]);
    const listProcesses = vi.fn(() => [{ pid: 10, ppid: 1, executable: 'python3' }]);
    const signal = vi.fn();

    await expect(
      reclaimAbandonedLockHolders({
        lockPath: '/test/absent.lock',
        appPid: 100,
        currentChildPid: null,
        pathExists: () => false,
        listLockHolders,
        listProcesses,
        signal,
      })
    ).resolves.toEqual({ kill: [], blockedByLiveParent: [] });

    expect(listLockHolders).not.toHaveBeenCalled();
    expect(listProcesses).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('leaves unknown owners alone when OS lock inspection times out', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listProcesses = vi.fn(() => [{ pid: 10, ppid: 1, executable: 'python3' }]);
    const signal = vi.fn();

    await expect(
      reclaimAbandonedLockHolders({
        lockPath: '/test/held.lock',
        appPid: 100,
        currentChildPid: null,
        pathExists: () => true,
        listLockHolders: () => {
          throw Object.assign(new Error('spawnSync lsof ETIMEDOUT'), { code: 'ETIMEDOUT' });
        },
        listProcesses,
        signal,
      })
    ).resolves.toEqual({ kill: [], blockedByLiveParent: [] });

    expect(listProcesses).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toContain('RuntimeScopeLease');
  });

  it('keeps a successfully inspected owner whose desktop parent is alive', async () => {
    const signal = vi.fn();
    await expect(
      reclaimAbandonedLockHolders({
        lockPath: '/test/held.lock',
        appPid: 100,
        currentChildPid: null,
        pathExists: () => true,
        listLockHolders: () => [20],
        listProcesses: () => [
          { pid: 20, ppid: 200, executable: 'python3 -m uvicorn src.main:app' },
          { pid: 200, ppid: 1, executable: '/Applications/DNAForge.app/Contents/MacOS/DNAForge' },
        ],
        signal,
      })
    ).resolves.toEqual({ kill: [], blockedByLiveParent: [20] });
    expect(signal).not.toHaveBeenCalled();
  });

  it('parses pid, parent, and command from ps', () => {
    expect(parsePsProcessList('  10   1 python3 hold.py\nnot a process\n')).toEqual([
      { pid: 10, ppid: 1, executable: 'python3 hold.py' },
    ]);
  });

  it.each(['ETIMEDOUT', 'EACCES', 2])(
    'leaves ownership to the runtime lease when holder inspection fails with %s',
    async (code) => {
      const directory = mkdtempSync(join(tmpdir(), 'sidecar-inspection-failure-'));
      const lockPath = join(directory, 'existing.lock');
      writeFileSync(lockPath, '');
      const error = Object.assign(new Error('holder inspection failed'), { code });
      const listProcesses = vi.fn(() => []);
      const signal = vi.fn();
      try {
        await expect(
          reclaimAbandonedLockHolders({
            lockPath,
            appPid: process.pid,
            currentChildPid: null,
            listLockHolders: () => Promise.reject(error),
            listProcesses,
            signal,
          })
        ).resolves.toEqual({ kill: [], blockedByLiveParent: [] });
        expect(listProcesses).not.toHaveBeenCalled();
        expect(signal).not.toHaveBeenCalled();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('clears a holder that is not this build and keeps one owned by a live app', () => {
    const decision = decideAbandonedLockHolders({
      lockHolderPids: [10, 20, 30, 40],
      appPid: 100,
      currentChildPid: 30,
      processes: [
        { pid: 1, ppid: 0, executable: '/sbin/launchd' },
        { pid: 10, ppid: 1, executable: 'python3 /tmp/other-copy/hold.py' },
        {
          pid: 20,
          ppid: 200,
          executable: '/old/DNAForge.app/Contents/MacOS/waypoint-api --port 1',
        },
        { pid: 200, ppid: 1, executable: '/Applications/DNAForge.app/Contents/MacOS/DNAForge' },
        { pid: 30, ppid: 100, executable: 'python3 -m uvicorn src.main:app' },
        { pid: 100, ppid: 1, executable: '/Applications/DNAForge.app/Contents/MacOS/Electron' },
        { pid: 40, ppid: 41, executable: '/usr/bin/python3 -c hold' },
        { pid: 41, ppid: 1, executable: '/usr/bin/python3 -m uvicorn --reload' },
      ],
    });

    expect(decision.kill).toEqual([10, 40]);
    expect(decision.blockedByLiveParent).toEqual([20]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SavedTerminalSession } from './terminal-service';
import {
  readTerminalSavedState,
  writeTerminalSavedState,
  TerminalSessionCheckpoint,
} from './session-storage';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
);
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text),
  decryptString: (bytes: Buffer) => bytes.toString(),
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-async-storage-'));
  directories.push(directory);
  const path = join(directory, 'sessions.json');
  const saved: SavedTerminalSession = {
    profile: { id: 'bash', name: 'Bash', path: '/bin/bash', args: ['-i'] },
    renamed: false,
    replay: 'retained-terminal-output',
    session: {
      id: randomUUID(),
      pid: 42,
      profileId: 'bash',
      shellPath: '/bin/bash',
      title: 'Bash',
      cwd: directory,
      cols: 120,
      rows: 40,
      exitCode: null,
      status: 'running',
      integration: false,
      alternateScreen: false,
      shellState: 'starting',
      commands: [],
    },
  };
  writeTerminalSavedState(path, [saved], encryption);
  return { path, saved };
}

function pendingAvailability() {
  let allow!: (available: boolean) => void;
  const available = new Promise<boolean>((resolve) => {
    allow = resolve;
  });
  return { available, allow };
}

describe('asynchronous terminal secure storage', () => {
  it('retains the encrypted checkpoint while secure storage is pending, then restores it', async () => {
    const { path, saved } = fixture();
    const original = readFileSync(path, 'utf8');
    const pending = pendingAvailability();
    const accept = vi.fn(async (_sessions: SavedTerminalSession[]) => {});
    const checkpoint = new TerminalSessionCheckpoint(path, {
      isEncryptionAvailable: () => pending.available,
      encryptString: async (text: string) => encryption.encryptString(text),
      decryptString: async (bytes: Buffer) => encryption.decryptString(bytes),
    });
    const restoring = checkpoint.restore(accept);
    await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(original);
    pending.allow(true);
    await restoring;
    expect(accept).toHaveBeenCalledWith([saved]);
  });

  it('does not resurrect a checkpoint discarded while secure storage was pending', async () => {
    const { path } = fixture();
    const pending = pendingAvailability();
    const accept = vi.fn(async (_sessions: SavedTerminalSession[]) => {});
    const checkpoint = new TerminalSessionCheckpoint(path, {
      isEncryptionAvailable: () => pending.available,
      encryptString: async (text: string) => encryption.encryptString(text),
      decryptString: async (bytes: Buffer) => encryption.decryptString(bytes),
    });
    const restoring = checkpoint.restore(accept);
    await Promise.resolve();
    checkpoint.discard();
    pending.allow(true);
    await restoring;
    expect(accept).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it('awaits encryption before publishing and retains prior bytes if it fails', async () => {
    const { path, saved } = fixture();
    const original = readFileSync(path, 'utf8');
    await expect(
      writeTerminalSavedState(path, [saved], {
        isEncryptionAvailable: async () => true,
        encryptString: async () => {
          throw new Error('locked');
        },
        decryptString: async (bytes: Buffer) => encryption.decryptString(bytes),
      })
    ).rejects.toThrow('locked');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('does not publish an in-flight encrypted save after the checkpoint is discarded', async () => {
    const { path, saved } = fixture();
    let finish!: (bytes: Buffer) => void;
    const encrypted = new Promise<Buffer>((resolve) => {
      finish = resolve;
    });
    const checkpoint = new TerminalSessionCheckpoint(path, {
      isEncryptionAvailable: async () => true,
      encryptString: () => encrypted,
      decryptString: async (bytes: Buffer) => encryption.decryptString(bytes),
    });
    await checkpoint.restore(async () => {});
    const writing = checkpoint.write([saved]);
    await Promise.resolve();
    checkpoint.discard();
    finish(encryption.encryptString(JSON.stringify({ version: 1, sessions: [saved] })));
    await writing;
    expect(existsSync(path)).toBe(false);
  });

  it('migrates an empty legacy checkpoint without requesting secure storage', () => {
    const { path } = fixture();
    writeFileSync(path, JSON.stringify({ version: 1, sessions: [] }));
    const forbidden = () => {
      throw new Error('Secure storage must not be requested');
    };
    expect(
      readTerminalSavedState(path, {
        isEncryptionAvailable: forbidden,
        encryptString: forbidden,
        decryptString: forbidden,
      })
    ).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 2, payload: null });
  });
});

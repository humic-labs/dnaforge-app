import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushFile, flushFileSync } from './fs-durability';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-durability-'));
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function fileWithMode(name: string, mode: number): string {
  const path = join(root, name);
  writeFileSync(path, 'content');
  chmodSync(path, mode);
  return path;
}

function writable(path: string): boolean {
  return (statSync(path).mode & 0o200) !== 0;
}

describe('flushing a file to disk', () => {
  it('flushes a read-only file on this platform and leaves it read-only', async () => {
    const syncPath = fileWithMode('object-sync', 0o444);
    const asyncPath = fileWithMode('object-async', 0o444);
    flushFileSync(syncPath);
    await flushFile(asyncPath);
    expect(writable(syncPath)).toBe(false);
    expect(writable(asyncPath)).toBe(false);
  });

  it('on Windows makes a read-only file writable only for the flush', async () => {
    const syncPath = fileWithMode('object-sync', 0o444);
    const asyncPath = fileWithMode('object-async', 0o444);
    flushFileSync(syncPath, 'win32');
    await flushFile(asyncPath, 'win32');
    expect(statSync(syncPath).mode & 0o777).toBe(0o444);
    expect(statSync(asyncPath).mode & 0o777).toBe(0o444);
  });

  it('on Windows leaves a writable file permissions unchanged', async () => {
    const path = fileWithMode('index', 0o644);
    flushFileSync(path, 'win32');
    await flushFile(path, 'win32');
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('on Windows restores read-only permissions when the flush itself fails', async () => {
    const directory = join(root, 'not-a-file');
    mkdirSync(directory);
    chmodSync(directory, 0o555);
    expect(() => flushFileSync(directory, 'win32')).toThrow();
    await expect(flushFile(directory, 'win32')).rejects.toThrow();
    expect(statSync(directory).mode & 0o777).toBe(0o555);
  });
});

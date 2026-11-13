import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  __resetBootLogForTest,
  __setBootLogMaxBytesForTest,
  appendBootLog,
  copyInstallLogIntoUserData,
  initBootLog,
  readLogTail,
} from '../boot-log';

describe('boot-log', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-log-'));
    __resetBootLogForTest();
  });

  afterEach(() => {
    __resetBootLogForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes timestamped boot lines', () => {
    const path = initBootLog(dir);
    appendBootLog('step_one');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('schema=1');
    expect(content).toContain('step_one');
  });

  it('readLogTail returns the end of a file', () => {
    const logPath = join(dir, 'sample.log');
    writeFileSync(logPath, `${'a'.repeat(100)}TAIL`);
    expect(readLogTail(logPath, 4)).toBe('TAIL');
  });

  it('readLogTail keeps whole multibyte characters', () => {
    const logPath = join(dir, 'utf8.log');
    writeFileSync(logPath, `${'é'.repeat(50)}端末`);
    expect(readLogTail(logPath, 3)).toBe('é端末');
  });

  it('never lets the boot log grow past its cap and keeps the newest lines', () => {
    __setBootLogMaxBytesForTest(1_000);
    const path = initBootLog(dir);
    for (let i = 0; i < 500; i += 1)
      appendBootLog(`failure kind=crash error_class=uncaught_exception ${i}`);

    const previous = join(dir, 'logs', 'main-boot.log.1');
    expect(statSync(path).size).toBeLessThanOrEqual(1_000);
    expect(statSync(previous).size).toBeLessThanOrEqual(1_000);
    expect(readFileSync(path, 'utf-8').trimEnd().endsWith('uncaught_exception 499')).toBe(true);
  });

  it('trims a boot log that was already oversized to its newest bytes', () => {
    __setBootLogMaxBytesForTest(1_000);
    const path = join(dir, 'logs', 'main-boot.log');
    initBootLog(dir);
    writeFileSync(path, `${'old line\n'.repeat(10_000)}OLD_TAIL\n`);
    __resetBootLogForTest();
    __setBootLogMaxBytesForTest(1_000);

    initBootLog(dir);

    const previous = readFileSync(join(dir, 'logs', 'main-boot.log.1'), 'utf-8');
    expect(previous.length).toBeLessThanOrEqual(1_000);
    expect(previous.endsWith('OLD_TAIL\n')).toBe(true);
    expect(readFileSync(path, 'utf-8')).toMatch(/^# DNAForge main-boot\.log schema=1/);
  });

  it('copyInstallLogIntoUserData is a no-op when install.log is absent', () => {
    expect(copyInstallLogIntoUserData(dir)).toBeNull();
  });
});

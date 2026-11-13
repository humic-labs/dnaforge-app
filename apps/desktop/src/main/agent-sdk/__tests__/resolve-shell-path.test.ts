import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as childProcess from 'node:child_process';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = vi.fn(actual.spawn);
  return { ...actual, spawn, default: { ...actual, spawn } };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: () => process.platform,
    homedir: () => process.env.HOME || actual.homedir(),
  };
});
import {
  __resetShellPathRepairForTests,
  ensureShellPathRepaired,
  findInKnownCliDirs,
  findInKnownCliDirsPresence,
  getSearchedCliDirs,
  knownCliDirCandidates,
  parseSentinelPath,
  probeLoginShellPath,
  resolveExistingKnownCliDirs,
  resolveKnownCliDirPresence,
  unionPathSegments,
} from '../resolve-shell-path';

const OPEN = '__WP_PATH_START__';
const CLOSE = '__WP_PATH_END__';

describe('presence completeness', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fixture-cli-presence-'));
    __resetShellPathRepairForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetShellPathRepairForTests();
    rmSync(home, { recursive: true, force: true });
  });

  it('distinguishes absent known paths from inaccessible paths while legacy lookup stays unchanged', async () => {
    const absent = await findInKnownCliDirsPresence('fixture-synthetic-absent', home);
    expect(absent).toEqual({ value: null, complete: true });
    const access = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
      if (path === join(home, '.local', 'bin'))
        throw Object.assign(new Error('Synthetic permission failure'), { code: 'EACCES' });
      return access(path, mode);
    });
    expect(await findInKnownCliDirsPresence('fixture-synthetic-absent', home)).toEqual({
      value: null,
      complete: false,
    });
    expect(await findInKnownCliDirs('fixture-synthetic-absent', home)).toBeNull();
    expect((await resolveKnownCliDirPresence(home)).complete).toBe(false);
  });

  it('preserves first executable fallback and records executable-inspection uncertainty', async () => {
    const dir = join(home, '.local', 'bin');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'fixture-synthetic-present');
    writeFileSync(path, 'synthetic nonexecuted fixture');
    chmodSync(path, 0o755);
    expect((await findInKnownCliDirsPresence('fixture-synthetic-present', home)).value).toBe(path);
    const stat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation((...args) => {
      if (args[0] === path)
        return Promise.reject(Object.assign(new Error('Synthetic I/O failure'), { code: 'EIO' }));
      return stat(...args);
    });
    expect(await findInKnownCliDirsPresence('fixture-synthetic-present', home)).toEqual({
      value: null,
      complete: false,
    });
  });

  it('marks unreadable nvm enumeration unknown instead of proving no installed CLI', async () => {
    const readdir = fs.readdir;
    vi.spyOn(fs, 'readdir').mockImplementation((...args) => {
      if (args[0] === join(home, '.nvm', 'versions', 'node'))
        return Promise.reject(Object.assign(new Error('Synthetic I/O failure'), { code: 'EIO' }));
      return readdir(...args);
    });
    expect((await resolveKnownCliDirPresence(home)).complete).toBe(false);
  });

  it('retains original known-directory uncertainty in the cached shell repair without a real shell', async () => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', '/synthetic/system');
    const child = new childProcess.ChildProcess();
    const stdout = new PassThrough();
    child.stdout = stdout;
    child.kill = vi.fn(() => true);
    child.unref = vi.fn();
    const spawn = vi.mocked(childProcess.spawn);
    const originalSpawn = spawn.getMockImplementation();
    spawn.mockImplementation(() => {
      queueMicrotask(() => stdout.write(`${OPEN}/synthetic/shell${CLOSE}`));
      return child;
    });
    const access = fs.access;
    const denied = vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
      if (path === join(home, '.local', 'bin'))
        throw Object.assign(new Error('Synthetic permission failure'), { code: 'EACCES' });
      return access(path, mode);
    });
    try {
      const callsBefore = spawn.mock.calls.length;
      const first = await ensureShellPathRepaired();
      expect(first.shellProbeOk).toBe(true);
      expect(first.knownDirsComplete).toBe(false);
      expect(first.repairedPath.startsWith('/synthetic/system:/synthetic/shell')).toBe(true);
      denied.mockRestore();
      expect(await ensureShellPathRepaired()).toBe(first);
      expect((await resolveKnownCliDirPresence(home)).complete).toBe(true);
      expect(spawn.mock.calls.length - callsBefore).toBe(1);
    } finally {
      if (originalSpawn) spawn.mockImplementation(originalSpawn);
    }
  });
});

describe('parseSentinelPath', () => {
  it('extracts the PATH between sentinels', () => {
    expect(parseSentinelPath(`${OPEN}/opt/homebrew/bin:/usr/bin${CLOSE}`)).toBe(
      '/opt/homebrew/bin:/usr/bin'
    );
  });

  it('ignores rc banner noise printed before AND after the sentinels', () => {
    const noisy = `Loading nvm...\nWelcome\n${OPEN}/usr/local/bin:/usr/bin${CLOSE}\n[direnv] done\n`;
    expect(parseSentinelPath(noisy)).toBe('/usr/local/bin:/usr/bin');
  });

  it('returns null when the sentinels are absent', () => {
    expect(parseSentinelPath('no markers here')).toBeNull();
  });

  it('returns null on an empty PATH', () => {
    expect(parseSentinelPath(`${OPEN}${CLOSE}`)).toBeNull();
  });

  it('rejects non-POSIX (no slash) output, e.g. fish space-list', () => {
    expect(parseSentinelPath(`${OPEN}binA binB binC${CLOSE}`)).toBeNull();
  });

  it('does not truncate when a PATH segment is literally named like the close token (review fix)', () => {
    const path = `/usr/bin:/Users/x/${CLOSE}/bin:/opt/homebrew/bin`;
    expect(parseSentinelPath(`${OPEN}${path}${CLOSE}`)).toBe(path);
  });
});

describe('unionPathSegments', () => {
  it('preserves order, dropping duplicates and empties', () => {
    const result = unionPathSegments('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin', '/usr/bin::');
    expect(result.split(delimiter)).toEqual(['/usr/bin', '/bin', '/opt/homebrew/bin']);
  });

  it('keeps the FIRST source (system/launchd PATH) ahead of appended dirs', () => {
    const minimal = '/usr/bin:/bin:/usr/sbin:/sbin';
    const result = unionPathSegments(minimal, '/opt/homebrew/bin', '/Users/x/.local/bin');
    expect(result.startsWith(minimal)).toBe(true);
    expect(result.endsWith('/opt/homebrew/bin:/Users/x/.local/bin')).toBe(true);
  });

  it('tolerates null / undefined sources', () => {
    expect(unionPathSegments('/usr/bin', null, undefined, '/bin')).toBe(`/usr/bin${delimiter}/bin`);
  });
});

describe('knownCliDirCandidates', () => {
  it('includes ~/.local/bin (native-installer primary), ~/.codex/bin, homebrew', () => {
    const dirs = knownCliDirCandidates('/Users/test');
    expect(dirs).toContain('/Users/test/.local/bin');
    expect(dirs).toContain('/Users/test/.codex/bin');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
  });

  it('includes a pnpm global dir', () => {
    const dirs = knownCliDirCandidates('/Users/test');
    expect(dirs.some((d) => d.includes('pnpm'))).toBe(true);
  });
});

describe('resolveExistingKnownCliDirs + findInKnownCliDirs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fixture-known-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('only returns dirs that exist on disk', async () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const dirs = await resolveExistingKnownCliDirs(home);
    expect(dirs).toContain(join(home, '.local', 'bin'));
    expect(dirs).not.toContain(join(home, '.codex', 'bin'));
  });

  it('expands ~/.nvm/versions/node/<v>/bin via readdir', async () => {
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v20.19.4', 'bin');
    mkdirSync(nvmBin, { recursive: true });
    const dirs = await resolveExistingKnownCliDirs(home);
    expect(dirs).toContain(nvmBin);
  });

  it('finds a binary planted in a known dir (the Layer-2 fallback)', async () => {
    const codexDir = join(home, '.codex', 'bin');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'fixture-test-cli'), '#!/bin/sh\necho hi\n');
    chmodSync(join(codexDir, 'fixture-test-cli'), 0o755);
    expect(await findInKnownCliDirs('fixture-test-cli', home)).toBe(
      join(codexDir, 'fixture-test-cli')
    );
    expect(await findInKnownCliDirs('fixture-missing-cli', home)).toBeNull();
  });

  it('rejects a directory or a non-executable file named like the CLI (review fix)', async () => {
    const localBin = join(home, '.local', 'bin');
    mkdirSync(join(localBin, 'fixture-directory-cli'), { recursive: true });
    writeFileSync(join(localBin, 'fixture-non-executable-cli'), 'not a binary');
    chmodSync(join(localBin, 'fixture-non-executable-cli'), 0o644);
    expect(await findInKnownCliDirs('fixture-directory-cli', home)).toBeNull();
    expect(await findInKnownCliDirs('fixture-non-executable-cli', home)).toBeNull();
  });

  it('is a no-op on win32 (the POSIX-dir scan must not run on Windows) (review fix)', async () => {
    const codexDir = join(home, '.codex', 'bin');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'codex'), 'x');
    chmodSync(join(codexDir, 'codex'), 0o755);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(await findInKnownCliDirs('codex', home)).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });
});

describe('probeLoginShellPath (real spawn against a fake shell)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fixture-shell-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFakeShell(name: string, body: string): string {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  it('harvests the PATH a login shell prints between sentinels', async () => {
    const shell = writeFakeShell('fakeshell', `printf '%s' "${OPEN}/fake/a:/fake/b${CLOSE}"`);
    expect(await probeLoginShellPath(shell)).toBe('/fake/a:/fake/b');
  });

  it('returns null (does not hang) when the shell exceeds the timeout', async () => {
    const shell = writeFakeShell('slowshell', 'sleep 5');
    const result = await probeLoginShellPath(shell, 150);
    expect(result).toBeNull();
  });

  it('skips non-POSIX shells (fish) without spawning', async () => {
    expect(await probeLoginShellPath('/opt/homebrew/bin/fish')).toBeNull();
  });

  it('returns null (does not reject/hang) when the shell binary cannot be spawned (review fix)', async () => {
    expect(await probeLoginShellPath('/no/such/shell-fixture', 1000)).toBeNull();
  });
});

describe('ensureShellPathRepaired', () => {
  let originalPath: string | undefined;
  let originalShell: string | undefined;
  let originalHome: string | undefined;
  let home: string;

  beforeEach(() => {
    __resetShellPathRepairForTests();
    originalPath = process.env.PATH;
    originalShell = process.env.SHELL;
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'fixture-repair-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    __resetShellPathRepairForTests();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('appends the shell-probed PATH + known dirs onto a stripped PATH, system dirs first', async () => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });

    const fakeShell = join(home, 'fakeshell');
    writeFileSync(
      fakeShell,
      `#!/bin/sh\nprintf '%s' "${OPEN}/opt/homebrew/bin:/usr/bin${CLOSE}"\n`
    );
    chmodSync(fakeShell, 0o755);
    process.env.SHELL = fakeShell;

    const info = await ensureShellPathRepaired();

    expect(info.skipped).toBe(false);
    expect(info.shellProbeOk).toBe(true);
    expect(info.repairedPath.startsWith('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
    expect(info.repairedPath.split(delimiter)).toContain('/opt/homebrew/bin');
    expect(info.repairedPath.split(delimiter)).toContain(join(home, '.local', 'bin'));
    expect(process.env.PATH).toBe(info.repairedPath);
  });

  it('getSearchedCliDirs redacts the home prefix to ~ (no username leaks to the renderer) (review fix)', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/nonexistent-shell-xyz';
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });

    const dirs = await getSearchedCliDirs();
    expect(dirs).toContain('~/.local/bin');
    expect(dirs.some((d) => d.startsWith(home))).toBe(false);
    expect(dirs).toContain('/usr/bin');
  });

  it('memoizes the promise (a second call does not re-probe / re-mutate)', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/nonexistent-shell-xyz';
    const a = await ensureShellPathRepaired();
    const pathAfterFirst = process.env.PATH;
    const b = await ensureShellPathRepaired();
    expect(b).toBe(a);
    expect(process.env.PATH).toBe(pathAfterFirst);
  });
});

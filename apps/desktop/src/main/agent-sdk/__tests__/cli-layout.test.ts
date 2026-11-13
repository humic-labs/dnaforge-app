import { describe, expect, it, vi, beforeEach } from 'vitest';

const { files, fsPromisesMock } = vi.hoisted(() => {
  const files: Record<string, true> = {};
  const fsPromisesMock = {
    access: async (p: string) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return;
      throw new Error('ENOENT');
    },
  };
  return { files, fsPromisesMock };
});
vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  default: { constants: { X_OK: 1 }, promises: fsPromisesMock },
  promises: fsPromisesMock,
}));

import { parseCmdShimTargets, resolveCodexNativeExe, nodeAwareSpawn } from '../cli-layout';

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
});

function npmCmdShim(vendorLauncherRel: string): string {
  return [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    `"%_prog%"  "%dp0%\\${vendorLauncherRel}" %*`,
  ].join('\r\n');
}

describe('parseCmdShimTargets', () => {
  it('npm .cmd: returns the vendor launcher, NEVER node.exe', () => {
    const shimDir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const body = npmCmdShim('node_modules\\@anthropic-ai\\claude-code\\cli.js');
    const out = parseCmdShimTargets(body, shimDir);
    expect(out).toContain(`${shimDir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`);
    expect(out.some((p) => p.toLowerCase().endsWith('node.exe'))).toBe(false);
  });

  it('handles a profile path WITH A SPACE (quoted token taken whole)', () => {
    const shimDir = 'C:\\Users\\John Smith\\AppData\\Roaming\\npm';
    const out = parseCmdShimTargets(
      npmCmdShim('node_modules\\@openai\\codex\\bin\\codex.js'),
      shimDir
    );
    expect(out).toEqual([`${shimDir}\\node_modules\\@openai\\codex\\bin\\codex.js`]);
  });

  it('tolerates a UTF-8 BOM (.ps1 shims carry one) and $PSScriptRoot', () => {
    const shimDir = 'C:\\pnpm';
    const body = '\uFEFF& "$PSScriptRoot\\node_modules\\@openai\\codex\\bin\\codex.js" $args';
    const out = parseCmdShimTargets(body, shimDir);
    expect(out).toEqual([`${shimDir}\\node_modules\\@openai\\codex\\bin\\codex.js`]);
  });

  it('recognizes the official Grok npm package extensionless Node trampoline', () => {
    const shimDir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const out = parseCmdShimTargets(
      npmCmdShim('node_modules\\@xai-official\\grok\\bin\\grok'),
      shimDir
    );
    expect(out).toEqual([`${shimDir}\\node_modules\\@xai-official\\grok\\bin\\grok`]);
  });

  it('unknown / non-vendor shape → [] (caller falls through)', () => {
    expect(parseCmdShimTargets('@echo off\r\n"%dp0%\\node.exe" %*', 'C:\\x')).toEqual([]);
    expect(parseCmdShimTargets('nonsense', 'C:\\x')).toEqual([]);
  });
});

describe('resolveCodexNativeExe (node-resolution emulation)', () => {
  const X64_TAIL = 'vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';

  it('npm-flat: walks node_modules up from the launcher to the sibling platform pkg', async () => {
    const launcher = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const exe = `C:\\npm\\node_modules\\@openai\\codex-win32-x64\\${X64_TAIL}`;
    files[exe] = true;
    expect(await resolveCodexNativeExe(launcher)).toBe(exe);
  });

  it('PNPM CANARY: exe nested in .pnpm store, absent at dirname(shim) — resolves ONLY via the walk', async () => {
    const launcher =
      'C:\\pnpm\\node_modules\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex\\bin\\codex.js';
    const nestedExe = `C:\\pnpm\\node_modules\\.pnpm\\@openai+codex@1\\node_modules\\@openai\\codex-win32-x64\\${X64_TAIL}`;
    files[nestedExe] = true;
    expect(files[`C:\\pnpm\\node_modules\\@openai\\codex-win32-x64\\${X64_TAIL}`]).toBeUndefined();
    expect(await resolveCodexNativeExe(launcher)).toBe(nestedExe);
  });

  it('in-package vendor fallback (bin/codex.js catch branch)', async () => {
    const launcher = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const inPkg = `C:\\npm\\node_modules\\@openai\\codex\\${X64_TAIL}`;
    files[inPkg] = true;
    expect(await resolveCodexNativeExe(launcher)).toBe(inPkg);
  });

  it('nothing present → null (codex NEVER gets a .js)', async () => {
    const launcher = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    expect(await resolveCodexNativeExe(launcher)).toBeNull();
  });
});

describe('nodeAwareSpawn', () => {
  it('a .js entrypoint runs via the Node runtime with ELECTRON_RUN_AS_NODE', () => {
    const r = nodeAwareSpawn('C:\\x\\cli.js', ['auth', 'status'], { FOO: '1' });
    expect(r.file).toBe(process.execPath);
    expect(r.args).toEqual(['C:\\x\\cli.js', 'auth', 'status']);
    expect(r.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(r.env.FOO).toBe('1');
  });

  it('a native .exe spawns directly, no ELECTRON_RUN_AS_NODE', () => {
    const r = nodeAwareSpawn('C:\\x\\codex.exe', ['login', 'status'], { FOO: '1' });
    expect(r.file).toBe('C:\\x\\codex.exe');
    expect(r.args).toEqual(['login', 'status']);
    expect(r.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('the official Grok npm trampoline runs via Node on Windows', () => {
    const command = 'C:\\npm\\node_modules\\@xai-official\\grok\\bin\\grok';
    const r = nodeAwareSpawn(command, ['agent', 'stdio'], { FOO: '1' });
    expect(r.file).toBe(process.execPath);
    expect(r.args).toEqual([command, 'agent', 'stdio']);
    expect(r.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

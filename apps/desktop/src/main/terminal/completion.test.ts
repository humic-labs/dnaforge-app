import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  completionInput,
  completionSuffix,
  providerEnvironment,
  suggestTerminalCompletions,
} from './completion';

it('retains PowerShell runtime paths without forwarding unrelated credentials', () => {
  const context = {
    input: 'Get-Chi',
    cwd: '/workspace',
    shellPath: '/runtime/pwsh.exe',
    environment: {
      Path: '/runtime/bin',
      UserProfile: '/runtime/user',
      localappdata: '/runtime/local',
      AppData: '/runtime/roaming',
      ProgramFiles: '/runtime/programs',
      'ProgramFiles(x86)': '/runtime/programs-x86',
      ProgramW6432: '/runtime/programs-64',
      psmodulepath: '/runtime/modules',
      PSModuleAnalysisCachePath: '/runtime/cache/ModuleAnalysisCache',
      PSDisableModuleAnalysisCacheCleanup: '1',
      OPENAI_API_KEY: 'not-a-real-key',
      GITHUB_TOKEN: 'not-forwarded',
    },
  };
  const environment = providerEnvironment(context);
  expect(environment).toMatchObject({
    PATH: '/runtime/bin',
    USERPROFILE: '/runtime/user',
    LOCALAPPDATA: '/runtime/local',
    APPDATA: '/runtime/roaming',
    ProgramFiles: '/runtime/programs',
    'ProgramFiles(x86)': '/runtime/programs-x86',
    ProgramW6432: '/runtime/programs-64',
    PSModulePath: '/runtime/modules',
    PSModuleAnalysisCachePath: '/runtime/cache/ModuleAnalysisCache',
    PSDisableModuleAnalysisCacheCleanup: '1',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
  });
  expect(environment).not.toHaveProperty('OPENAI_API_KEY');
  expect(environment).not.toHaveProperty('GITHUB_TOKEN');
  expect(providerEnvironment({ ...context, environment: { PSModulePath: '' } })).toHaveProperty(
    'PSModulePath',
    ''
  );
  expect(providerEnvironment({ ...context, shellPath: '/bin/bash' })).toEqual({
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    PATH: '/runtime/bin',
    USERPROFILE: '/runtime/user',
  });
});

it('uses actual directory entries, PATH executables and bundled Git metadata without executing input', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-completion-'));
  try {
    await mkdir(join(cwd, 'bin'));
    await writeFile(join(cwd, 'bin', 'fixture-command'), '#!/bin/sh\nexit 99\n');
    await chmod(join(cwd, 'bin', 'fixture-command'), 0o755);
    await writeFile(join(cwd, 'literal name;$(not-run).txt'), 'unchanged');
    const context = {
      cwd,
      shellPath: '/bin/bash',
      environment: { PATH: './bin', HOME: cwd },
    };
    const signal = new AbortController().signal;
    expect(
      await suggestTerminalCompletions({ ...context, input: 'fixture-c' }, signal)
    ).toContainEqual(expect.objectContaining({ value: 'fixture-command', kind: 'command' }));
    const file = (
      await suggestTerminalCompletions({ ...context, input: "cat 'literal" }, signal)
    ).find((item) => item.value === 'literal name;$(not-run).txt');
    expect(file?.kind).toBe('file');
    expect(
      completionSuffix(completionInput("cat 'literal", '/bin/bash')!, file!.value, false)
    ).toBe(" name;$(not-run).txt' ");
    expect(
      await suggestTerminalCompletions({ ...context, input: 'git sta' }, signal)
    ).toContainEqual(expect.objectContaining({ value: 'status', kind: 'argument' }));
    expect(
      await suggestTerminalCompletions({ ...context, input: 'git status --sho' }, signal)
    ).toContainEqual(expect.objectContaining({ value: '--short', kind: 'option' }));
    expect(
      await suggestTerminalCompletions({ ...context, input: 'git --ver' }, signal)
    ).toContainEqual(expect.objectContaining({ value: '--version', kind: 'option' }));
    expect(completionInput('cat $(touch unexpected)', '/bin/bash')).toBeUndefined();
    expect(completionInput('git status; dangerous', '/bin/bash')).toBeUndefined();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('keeps generated Bash history and tilde characters literal, including an open double quote', () => {
  expect(completionSuffix(completionInput('cat "lit', '/bin/bash')!, 'literal!file', false)).toBe(
    "\"'eral!file' "
  );
  expect(completionSuffix(completionInput('cat ', '/bin/bash')!, '~root', false)).toBe("'~root' ");
  expect(completionSuffix(completionInput('cat ~r', '/bin/bash')!, '~root', false)).toBe("'oot' ");
  expect(
    completionSuffix(completionInput('cat ~/lit', '/bin/bash')!, '~/literal file', false)
  ).toBe("'eral file' ");
});

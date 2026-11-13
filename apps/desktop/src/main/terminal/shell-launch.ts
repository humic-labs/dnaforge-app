import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { TerminalProfile } from '../../shared/terminal-ipc';
import { DEFAULT_TERMINAL_LS_COLORS } from '../../shared/file-type-colors';

export function detectTerminalProfiles(): TerminalProfile[] {
  const candidates =
    process.platform === 'win32'
      ? ['pwsh.exe', 'powershell.exe', 'cmd.exe']
      : [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh', 'fish'].filter(
          (value): value is string => Boolean(value)
        );
  const seen = new Set<string>();
  const profiles: TerminalProfile[] = [];
  for (const candidate of candidates) {
    const executable = existsSync(candidate)
      ? candidate
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map((directory) => join(directory, candidate))
          .find(existsSync);
    if (!executable || seen.has(executable)) continue;
    seen.add(executable);
    const name = basename(executable);
    profiles.push({
      id: executable,
      name,
      path: executable,
      args: process.platform === 'win32' ? [] : ['-il'],
    });
  }
  return profiles;
}

export async function prepareTerminalShell(
  profile: TerminalProfile,
  integrationRoot: string | null,
  parentEnvironment: NodeJS.ProcessEnv = process.env
): Promise<{
  args: string[];
  env: Record<string, string>;
  originalEnvironment: Record<string, string>;
  nonce: string;
  cleanup(): Promise<void>;
}> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined && !key.startsWith('VSCODE_') && key !== 'ELECTRON_RUN_AS_NODE') {
      env[key] = value;
    }
  }
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  if (!env.NO_COLOR && env.DNAFORGE_TERMINAL_COLORS !== '0') {
    for (const [key, value] of Object.entries({
      CLICOLOR: '1',
      LSCOLORS: 'ExGxBxDxCxEgEdxbxgxcxd',
      LS_COLORS: DEFAULT_TERMINAL_LS_COLORS,
    })) {
      if (env[key] === undefined && !Object.prototype.hasOwnProperty.call(profile.env ?? {}, key))
        env[key] = value;
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'DNAForge';
  const originalEnvironment = { ...env };
  const nonce = randomUUID();
  let args = [...profile.args];
  let privateRoot: string | null = null;
  const shell = basename(profile.path).toLowerCase();
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const defaults = integrationRoot
    ? `\n. ${shellQuote(join(integrationRoot, 'dnaforge-defaults.sh'))}\n`
    : '';
  const powershell = ['pwsh', 'pwsh.exe', 'powershell.exe'].includes(shell);
  const normalizedArgs = args.map((argument) => argument.toLowerCase());
  const loginFlags = powershell ? ['-l', '-login'] : ['-l', '-il', '-li', '--login'];
  const logoFlags = ['-nol', '-nologo'];
  const standardArgs = powershell
    ? normalizedArgs.every(
        (argument) => loginFlags.includes(argument) || logoFlags.includes(argument)
      ) &&
      normalizedArgs.filter((argument) => loginFlags.includes(argument)).length <= 1 &&
      normalizedArgs.filter((argument) => logoFlags.includes(argument)).length <= 1
    : args.every((argument) =>
        ['-i', '-l', '-il', '-li', '--login', '--interactive'].includes(argument)
      );
  const login = (powershell ? normalizedArgs : args).some((argument) =>
    loginFlags.includes(argument)
  );
  if (integrationRoot && standardArgs && (powershell || ['zsh', 'bash', 'fish'].includes(shell))) {
    env.VSCODE_INJECTION = '1';
    env.VSCODE_NONCE = nonce;
    if (shell === 'zsh') {
      privateRoot = await mkdtemp(join(tmpdir(), 'dnaforge-terminal-zsh-'));
      try {
        for (const [source, destination] of [
          ['shellIntegration-rc.zsh', '.zshrc'],
          ['shellIntegration-env.zsh', '.zshenv'],
          ['shellIntegration-profile.zsh', '.zprofile'],
          ['shellIntegration-login.zsh', '.zlogin'],
        ])
          await copyFile(join(integrationRoot, source!), join(privateRoot, destination!));
        await appendFile(join(privateRoot, '.zshrc'), defaults);
      } catch (error) {
        await rm(privateRoot, { recursive: true, force: true });
        throw error;
      }
      env.USER_ZDOTDIR = env.ZDOTDIR || env.HOME || homedir();
      env.ZDOTDIR = privateRoot;
      args = [login ? '-il' : '-i'];
    } else if (shell === 'bash') {
      if (login) env.VSCODE_SHELL_LOGIN = '1';
      privateRoot = await mkdtemp(join(tmpdir(), 'dnaforge-terminal-bash-'));
      try {
        const startup = join(privateRoot, 'init.bash');
        await writeFile(
          startup,
          `. ${shellQuote(join(integrationRoot, 'shellIntegration-bash.sh'))}${defaults}`
        );
        args = ['--init-file', startup, '-i'];
      } catch (error) {
        await rm(privateRoot, { recursive: true, force: true });
        throw error;
      }
    } else if (shell === 'fish') {
      args = [
        login ? '-il' : '-i',
        '--init-command',
        `source "${join(integrationRoot, 'shellIntegration.fish').replaceAll('"', '\\"')}"`,
      ];
    } else if (powershell) {
      args = [
        ...(login ? ['-Login'] : []),
        ...(normalizedArgs.some((argument) => logoFlags.includes(argument)) ? ['-NoLogo'] : []),
        '-NoExit',
        '-Command',
        `. '${join(integrationRoot, 'shellIntegration.ps1').replaceAll("'", "''")}'`,
      ];
    }
  }
  return {
    args,
    env,
    originalEnvironment,
    nonce,
    cleanup: async () => {
      if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
    },
  };
}

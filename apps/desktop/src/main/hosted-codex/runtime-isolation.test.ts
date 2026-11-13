import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertCodexRuntimeIsolation,
  buildCodexRuntimeEnv,
  createCodexRuntimeIsolation,
  CodexRuntimeIsolationError,
} from './runtime-isolation';

const AMBIENT: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: 'sk-real-user-key',
  ANTHROPIC_API_KEY: 'sk-ant-real-user-key',
  AZURE_OPENAI_API_KEY: 'azure-real-key',
  AWS_SECRET_ACCESS_KEY: 'aws-real-secret',
  GITHUB_TOKEN: 'ghp_realtoken',
  DOPPLER_TOKEN: 'dp.ct.realtoken',
  CODEX_HOME: '/Users/real-person/.codex',
  CODEX_MCP_SERVERS: '/Users/real-person/.codex/mcp.json',
  CODEX_PLUGINS: '/Users/real-person/.codex/plugins',
  SHELL: '/bin/zsh',
  ZDOTDIR: '/Users/real-person',
  HOME: '/Users/real-person',
  PATH: '/Users/real-person/.local/bin:/usr/bin',
  NODE_OPTIONS: '--require /Users/real-person/inject.js',
  LANG: 'en_US.UTF-8',
  TZ: 'America/Los_Angeles',
};

let roots: string[] = [];

function isolationRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-isolation-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('Codex runtime isolation', () => {
  it('passes none of the ambient environment to the child', () => {
    const env = buildCodexRuntimeEnv({ codexHome: '/private/codex-home', hostEnv: AMBIENT });
    const values = Object.values(env).join('\u0000');

    for (const secret of [
      'sk-real-user-key',
      'sk-ant-real-user-key',
      'azure-real-key',
      'aws-real-secret',
      'ghp_realtoken',
      'dp.ct.realtoken',
    ]) {
      expect(values, `${secret} must not reach the child`).not.toContain(secret);
    }
    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'DOPPLER_TOKEN',
      'CODEX_MCP_SERVERS',
      'CODEX_PLUGINS',
      'SHELL',
      'ZDOTDIR',
      'NODE_OPTIONS',
    ]) {
      expect(env, `${name} must not be inherited`).not.toHaveProperty(name);
    }
  });

  it('does not inherit PATH, so a shimmed binary cannot be found instead of the pinned one', () => {
    const env = buildCodexRuntimeEnv({ codexHome: '/private/codex-home', hostEnv: AMBIENT });
    expect(env).not.toHaveProperty('PATH');
  });

  it('points the child at our Codex home, never the user\u2019s', () => {
    const env = buildCodexRuntimeEnv({ codexHome: '/private/codex-home', hostEnv: AMBIENT });
    expect(env.CODEX_HOME).toBe('/private/codex-home');
    expect(env.HOME).toBe('/private/codex-home');
    expect(env.CODEX_HOME).not.toBe(AMBIENT.CODEX_HOME);
  });

  it('keeps only locale and system variables, which name the machine and not the user', () => {
    const env = buildCodexRuntimeEnv({ codexHome: '/private/codex-home', hostEnv: AMBIENT });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('America/Los_Angeles');
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'TZ']);
  });

  it('adds only the system variables Windows needs to start a process', () => {
    const env = buildCodexRuntimeEnv({
      codexHome: 'C:\\private\\codex-home',
      hostEnv: { ...AMBIENT, SYSTEMROOT: 'C:\\Windows', COMSPEC: 'C:\\Windows\\cmd.exe' },
      platform: 'win32',
    });
    expect(env.SYSTEMROOT).toBe('C:\\Windows');
    expect(env.USERPROFILE).toBe('C:\\private\\codex-home');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('PATH');
  });

  it('refuses a relative home, which would resolve against whatever cwd it inherits', () => {
    expect(() => buildCodexRuntimeEnv({ codexHome: 'codex-home', hostEnv: AMBIENT })).toThrow(
      /must be an absolute path/u
    );
  });

  it('creates a private, empty Codex home and working directory', () => {
    const isolation = createCodexRuntimeIsolation({
      rootDir: isolationRoot(),
      runId: 'run-1',
      hostEnv: AMBIENT,
    });

    expect(readdirSync(isolation.codexHome)).toEqual(['config.toml']);
    expect(readdirSync(isolation.cwd)).toEqual([]);
    expect(isolation.env.CODEX_HOME).toBe(isolation.codexHome);
    expect(statSync(isolation.codexHome).mode & 0o777).toBe(0o700);
    expect(statSync(isolation.cwd).mode & 0o777).toBe(0o700);
    expect(() => assertCodexRuntimeIsolation(isolation)).not.toThrow();
  });

  it('never uses the user workspace as the child working directory', () => {
    const root = isolationRoot();
    const isolation = createCodexRuntimeIsolation({ rootDir: root, runId: 'run-2' });
    expect(isolation.cwd.startsWith(root)).toBe(true);
    expect(isolation.cwd).toContain('hosted-codex-runtime');
  });

  it('fails closed if anything is later seeded into the runtime directories', () => {
    const isolation = createCodexRuntimeIsolation({ rootDir: isolationRoot(), runId: 'run-3' });

    writeFileSync(path.join(isolation.codexHome, 'mcp.json'), '{}');
    expect(() => assertCodexRuntimeIsolation(isolation)).toThrow(/unexpected file set/u);

    rmSync(path.join(isolation.codexHome, 'mcp.json'));
    writeFileSync(path.join(isolation.cwd, 'AGENTS.md'), 'follow these repository instructions');
    expect(() => assertCodexRuntimeIsolation(isolation)).toThrow(CodexRuntimeIsolationError);
    expect(() => assertCodexRuntimeIsolation(isolation)).toThrow(/must be empty/u);
  });

  it('removes both directories on dispose', () => {
    const root = isolationRoot();
    const isolation = createCodexRuntimeIsolation({ rootDir: root, runId: 'run-4' });
    isolation.dispose();
    expect(readdirSync(path.join(root, 'hosted-codex-runtime'))).toEqual([]);
  });

  it('gives each run its own home, so nothing leaks between turns', () => {
    const root = isolationRoot();
    const first = createCodexRuntimeIsolation({ rootDir: root, runId: 'run-a' });
    const second = createCodexRuntimeIsolation({ rootDir: root, runId: 'run-b' });
    expect(first.codexHome).not.toBe(second.codexHome);
  });
});

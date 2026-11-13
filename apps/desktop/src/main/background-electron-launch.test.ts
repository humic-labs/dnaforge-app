import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import sequenceWebglConfig from '../../../../e2e/harness/sequence-webgl.config';

const require = createRequire(import.meta.url);
const { devChildEnv } = require('../../scripts/dev-single-instance-guard.cjs') as {
  devChildEnv(options: {
    env: NodeJS.ProcessEnv;
    appDir: string;
    repoRoot: string;
    platform: NodeJS.Platform;
    electronBinary: string;
  }): NodeJS.ProcessEnv;
};
function fakeElectronBinary(): string {
  const macOsDir = join(
    mkdtempSync(join(tmpdir(), 'dnaforge-electron-')),
    'Electron.app/Contents/MacOS'
  );
  mkdirSync(macOsDir, { recursive: true });
  const binary = join(macOsDir, 'Electron');
  writeFileSync(binary, '');
  return binary;
}

const launcher = require('../../scripts/background-electron-launch.cjs') as {
  backgroundDevRequested(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): boolean;
  configureBackgroundElectronLaunch(
    env: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
    electronBinary?: string,
    appDirectory?: string
  ): NodeJS.ProcessEnv;
  assertBackgroundElectronLaunchProtected(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): void;
  openArguments(appBundle: string, entry: string, args: string[], cwd?: string): string[];
  ownedElectronPids(
    appBundle: string,
    entry: string,
    execute?: (
      file: string,
      args: string[],
      options: { encoding: 'utf8'; maxBuffer?: number }
    ) => string
  ): number[];
  waitForPreviousElectron(
    appBundle: string,
    entry: string,
    listPids: () => number[],
    pause: () => Promise<void>
  ): Promise<void>;
};

describe('background Electron dev launch', () => {
  it('handles a real process-output stream above 1 MiB without losing exact ownership', () => {
    const app = '/fixture/Electron.app',
      entry = '/fixture/owned/apps/desktop';
    const prefix = `${app}/Contents/MacOS/Electron ${entry}`;
    const script = `process.stdout.write(('88 unrelated '+ 'x'.repeat(240)+'\\n').repeat(6000)); process.stdout.write(${JSON.stringify(`12345 ${prefix} --example\n777 ${prefix}-other\n`)});`;
    const execute = (
      _file: string,
      _args: string[],
      options: { encoding: 'utf8'; maxBuffer?: number }
    ) => execFileSync(process.execPath, ['-e', script], options);
    expect(launcher.ownedElectronPids(app, entry, execute)).toEqual([12345]);
  });
  it('recognizes agent and explicit background launches but respects a foreground override', () => {
    expect(launcher.backgroundDevRequested({ DNAFORGE_BACKGROUND_WINDOW: '1' }, 'darwin')).toBe(
      true
    );
    expect(launcher.backgroundDevRequested({ CODEX_HOME: '/x' }, 'darwin')).toBe(true);
    expect(
      launcher.backgroundDevRequested(
        { DNAFORGE_BACKGROUND_WINDOW: '1', DNAFORGE_FOREGROUND_WINDOW: '1' },
        'darwin'
      )
    ).toBe(true);
    expect(
      launcher.backgroundDevRequested(
        { CODEX_HOME: '/x', DNAFORGE_FOREGROUND_WINDOW: '1' },
        'darwin'
      )
    ).toBe(false);
    expect(launcher.backgroundDevRequested({ DNAFORGE_BACKGROUND_WINDOW: '1' }, 'linux')).toBe(
      false
    );
  });

  it('uses the macOS no-activation launch mechanism and preserves the app entry', () => {
    const args = launcher.openArguments(
      '/opt/electron/Electron.app',
      '.',
      ['--remote-debugging-port=9637'],
      '/worktree/apps/desktop'
    );
    expect(args).toEqual([
      '-g',
      '-n',
      '-F',
      '-W',
      '-a',
      '/opt/electron/Electron.app',
      '--env',
      'DNAFORGE_BACKGROUND_WINDOW=1',
      '--env',
      'DNAFORGE_BACKGROUND_LAUNCH_SAFE=1',
      '--env',
      'DNAFORGE_BACKGROUND_WORKTREE_CWD=/worktree/apps/desktop',
      '--args',
      '/worktree/apps/desktop',
      '--remote-debugging-port=9637',
    ]);
    expect(args).not.toContain('-j');
  });

  it('refuses a direct electron-vite launch and accepts only the guard-installed wrapper', () => {
    const binary = fakeElectronBinary();
    const env = { DNAFORGE_BACKGROUND_WINDOW: '1', NODE_ENV: 'development' };
    expect(() => launcher.assertBackgroundElectronLaunchProtected(env, 'darwin')).toThrow(
      'Refusing an agent/background Electron dev launch'
    );
    const configured = launcher.configureBackgroundElectronLaunch(
      env,
      'darwin',
      binary,
      '/worktree/apps/desktop'
    );
    expect(configured.ELECTRON_EXEC_PATH).toBe(
      resolve(__dirname, '../../scripts/background-electron-launch.cjs')
    );
    expect(configured.DNAFORGE_BACKGROUND_ELECTRON_APP_PATH).toMatch(/\/Electron\.app$/);
    expect(configured.DNAFORGE_BACKGROUND_WORKTREE_CWD).toBe('/worktree/apps/desktop');
    expect(() =>
      launcher.assertBackgroundElectronLaunchProtected(configured, 'darwin')
    ).not.toThrow();
  });

  it('installs the protected launcher in the actual desktop dev child environment', () => {
    const childEnv = devChildEnv({
      env: { DNAFORGE_BACKGROUND_WINDOW: '1', NODE_ENV: 'development' },
      appDir: resolve(__dirname, '../..'),
      repoRoot: resolve(__dirname, '../../../..'),
      platform: 'darwin',
      electronBinary: fakeElectronBinary(),
    });
    expect(childEnv.ELECTRON_EXEC_PATH).toBe(
      resolve(__dirname, '../../scripts/background-electron-launch.cjs')
    );
    expect(childEnv.DNAFORGE_BACKGROUND_LAUNCH_SAFE).toBe('1');
    expect(childEnv.DNAFORGE_BACKGROUND_WORKTREE_CWD).toBe(resolve(__dirname, '../..'));
  });

  it('waits for the old app to exit before a watched main-process restart', async () => {
    let checks = 0;
    await launcher.waitForPreviousElectron(
      '/app/Electron.app',
      '/worktree/apps/desktop',
      () => (++checks < 4 ? [12] : []),
      async () => {}
    );
    expect(checks).toBe(4);
    await expect(
      launcher.waitForPreviousElectron(
        '/app/Electron.app',
        '/worktree/apps/desktop',
        () => [12],
        async () => {}
      )
    ).rejects.toThrow('refusing a duplicate launch');
  });

  it('keeps the sequence browser acceptance suite headless and unable to launch Electron', () => {
    const webServer = sequenceWebglConfig.webServer;
    expect(Array.isArray(webServer)).toBe(false);
    const command = (webServer as { command: string }).command;
    expect(command).toContain('vite.renderer.config.ts');
    expect(command).not.toMatch(/electron-vite|npm run dev|dev-single-instance-guard/);
    expect(sequenceWebglConfig.use?.headless).toBe(true);
  });
});

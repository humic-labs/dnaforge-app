// @vitest-environment node
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig, type Plugin } from 'vite';

const originalNodeEnvironment = process.env.NODE_ENV;
afterEach(() => {
  if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnvironment;
});

async function sessionAlias(mode: string): Promise<Plugin> {
  const config = await resolveConfig(
    {
      configFile: resolve(import.meta.dirname, '../../vite.renderer.config.ts'),
      mode,
      logLevel: 'silent',
    },
    'build'
  );
  const plugin = config.plugins.find((plugin) => plugin.name === 'hosted-electron-session-alias');
  if (!plugin) throw new Error('Hosted session alias plugin missing');
  return plugin;
}

async function resolveSession(mode: string, id: string, importer: string) {
  const plugin = await sessionAlias(mode);
  const hook =
    typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId?.handler;
  if (!hook) throw new Error('Hosted session resolver missing');
  return hook.call({} as never, id, importer, { isEntry: false, attributes: {} });
}

describe('Hosted session build boundary', () => {
  it('routes the named public facade to Hosted without loading Electron runtime', async () => {
    const result = await resolveSession(
      'hosted',
      '../electron-session',
      '/project/apps/desktop/src/features/workspace-session/public/electron-session.ts'
    );
    expect(result).toBe(
      resolve(import.meta.dirname, '../features/workspace-session/hosted-session.ts')
    );
  });

  it('preserves direct session routing and rejects an unrelated same-name module', async () => {
    expect(
      await resolveSession(
        'hosted',
        '../../features/workspace-session/electron-session',
        '/project/src/services/save.ts'
      )
    ).toBe(resolve(import.meta.dirname, '../features/workspace-session/hosted-session.ts'));
    expect(
      await resolveSession(
        'hosted',
        '../electron-session',
        '/project/src/features/other/public/index.ts'
      )
    ).toBeNull();
  });

  it('keeps Electron test builds on their native session owner', async () => {
    expect(
      await resolveSession(
        'test',
        '../electron-session',
        '/project/apps/desktop/src/features/workspace-session/public/electron-session.ts'
      )
    ).toBeNull();
  });

  it('still rejects an Electron runtime leaked into the Hosted bundle', async () => {
    const plugin = await sessionAlias('hosted');
    const hook =
      typeof plugin.generateBundle === 'function'
        ? plugin.generateBundle
        : plugin.generateBundle?.handler;
    if (!hook) throw new Error('Hosted bundle guard missing');
    expect(() =>
      hook.call(
        {} as never,
        {} as never,
        { entry: { type: 'chunk', code: 'Workspace resource identity conflicts at' } } as never,
        false
      )
    ).toThrow('Hosted build included the Electron workspace runtime');
  });
});

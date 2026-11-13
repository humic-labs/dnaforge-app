import type { App } from 'electron';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isEntityNavigationScheme, type EntityNavigationScheme } from '../shared/entity-navigation';

type DevelopmentRuntime = {
  schemaVersion: number;
  appDirectory: string;
  entry: string;
  electronBinary: string;
  scheme: string;
  userDataDir?: string;
};

export function createEntityNavigationProtocol(input: {
  app: Pick<App, 'isPackaged' | 'getPath' | 'getAppPath' | 'setAsDefaultProtocolClient'>;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  executable: string;
  testRuntime: boolean;
  defaultScheme: () => EntityNavigationScheme;
}) {
  let registeredScheme: EntityNavigationScheme | null = null;
  let failure = 'Start the development app with npm run dev before requesting external links.';

  return {
    prepare() {
      if (input.app.isPackaged || input.testRuntime) return;
      try {
        const configPath = input.env.DNAFORGE_DEV_RUNTIME_CONFIG;
        if (!configPath) return;
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as DevelopmentRuntime;
        if (
          config.schemaVersion !== 1 ||
          !isEntityNavigationScheme(config.scheme) ||
          !config.scheme.startsWith('dnaforge-dev-') ||
          config.scheme !== input.env.DNAFORGE_DEV_ENTITY_SCHEME ||
          resolve(configPath) !==
            join(config.appDirectory, '.cache/dnaforge-dev-runtime/runtime.json') ||
          config.entry !== join(config.appDirectory, 'out/main/index.js') ||
          !input.argv.includes(config.appDirectory) ||
          realpathSync(input.app.getAppPath()) !== realpathSync(config.appDirectory) ||
          realpathSync(config.electronBinary) !== realpathSync(input.executable)
        )
          throw new Error('The development URL handler does not belong to this application.');

        const updated = { ...config, userDataDir: input.app.getPath('userData') };
        const temporary = `${configPath}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(updated, null, 2), { mode: 0o600 });
        renameSync(temporary, configPath);
        if (
          !input.app.setAsDefaultProtocolClient(config.scheme, input.executable, [
            config.appDirectory,
          ])
        ) {
          throw new Error('The operating system refused the development entity URL handler.');
        }
        registeredScheme = config.scheme;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        console.warn('[EntityNavigation]', failure);
      }
    },
    getScheme(): EntityNavigationScheme {
      if (input.app.isPackaged || input.testRuntime) return input.defaultScheme();
      if (registeredScheme) return registeredScheme;
      throw new Error(failure);
    },
    acceptsUrl(value: string): boolean {
      const scheme = new URL(value).protocol.slice(0, -1);
      return !scheme.startsWith('dnaforge-dev-') || scheme === input.env.DNAFORGE_DEV_ENTITY_SCHEME;
    },
  };
}

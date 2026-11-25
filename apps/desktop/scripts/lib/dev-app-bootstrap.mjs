import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { automationUserDataPath } = createRequire(import.meta.url)(
  '../../src/main/automation-profile.cjs'
);

export function configureDevelopmentEntry({
  app,
  argv,
  env,
  configuration,
  configPath,
  changeDirectory,
}) {
  if (
    configuration.schemaVersion !== 1 ||
    !isAbsolute(configuration.appDirectory) ||
    !isAbsolute(configuration.entry) ||
    !/^dnaforge-dev-([1-9]\d{0,4})$/.test(configuration.scheme) ||
    Number(configuration.scheme.slice('dnaforge-dev-'.length)) > 65535
  )
    throw new Error('Invalid DNAForge development runtime configuration.');

  const suppliedEntryIndex = argv.findIndex((value, index) =>
    index > 0 && !value.startsWith('-') &&
    [configuration.entry, dirname(configuration.entry), configuration.appDirectory].includes(resolve(value))
  );
  const suppliedEntry = suppliedEntryIndex >= 0;
  if (suppliedEntry) argv[suppliedEntryIndex] = configuration.appDirectory;
  for (const [key, value] of Object.entries(configuration.environment)) {
    if (env[key] === undefined) env[key] = value;
  }
  const automationProfile = automationUserDataPath(argv, env, configuration.appDirectory);
  if (automationProfile) {
    if (!argv.some((value) => value === '--user-data-dir' || value.startsWith('--user-data-dir=')))
      argv.push('--user-data-dir=' + automationProfile);
    app.commandLine.appendSwitch('user-data-dir', automationProfile);
    app.setPath('userData', automationProfile);
  }
  env.DNAFORGE_DEV_RUNTIME_CONFIG = configPath;
  env.DNAFORGE_DEV_ENTITY_SCHEME = configuration.scheme;
  env.DNAFORGE_BACKGROUND_WORKTREE_CWD = configuration.appDirectory;
  changeDirectory(configuration.appDirectory);

  if (!suppliedEntry) {
    argv.splice(1, 0, configuration.appDirectory);
    delete env.ELECTRON_RENDERER_URL;
    if (configuration.userDataDir && !automationProfile) {
      if (!isAbsolute(configuration.userDataDir))
        throw new Error('Invalid saved development profile.');
      argv.push('--user-data-dir=' + configuration.userDataDir);
      app.commandLine.appendSwitch('user-data-dir', configuration.userDataDir);
      app.setPath('userData', configuration.userDataDir);
    }
  } else if (!env.ELECTRON_RENDERER_URL) {
    env.ELECTRON_RENDERER_URL = `http://localhost:${configuration.scheme.slice('dnaforge-dev-'.length)}/`;
  }

  const pending = [];
  const capture = (event, url) => {
    event.preventDefault();
    pending.push({ event, url });
  };
  const flush = () => {
    if (app.listenerCount('open-url') < 2) return;
    app.removeListener('open-url', capture);
    app.removeListener('newListener', added);
    for (const item of pending.splice(0)) app.emit('open-url', item.event, item.url);
  };
  const added = (name) => {
    if (name === 'open-url') queueMicrotask(flush);
  };
  app.on('open-url', capture);
  app.on('newListener', added);
}

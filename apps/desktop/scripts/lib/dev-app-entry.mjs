import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureDevelopmentEntry } from './dev-app-bootstrap.mjs';

try {
  const { disableKeychainInteraction } = createRequire(import.meta.url)(
    '../../src/main/noninteractive-keychain.cjs'
  );
  const configPath = resolve(dirname(process.execPath), '../../../..', 'runtime.json');
  const configuration = JSON.parse(readFileSync(configPath, 'utf8'));
  configureDevelopmentEntry({
    app,
    argv: process.argv,
    env: process.env,
    configuration,
    configPath,
    changeDirectory: (directory) => process.chdir(directory),
  });
  const authorization = disableKeychainInteraction({
    loadNative: createRequire(resolve(configuration.appDirectory, 'package.json')),
  });
  writeFileSync(
    resolve(dirname(configPath), `authorization-${process.pid}.json`),
    JSON.stringify({
      ...authorization,
      appDirectory: configuration.appDirectory,
      configuredAt: new Date().toISOString(),
    }) + '\n',
    { mode: 0o600 }
  );
  await import(
    pathToFileURL(
      resolve(dirname(process.execPath), '../Resources/dnaforge-original-default-app.asar/main.js')
    ).href
  );
} catch (error) {
  console.error(
    '[DNAForge development entry]',
    error instanceof Error ? error.message : String(error)
  );
  app.exit(1);
}

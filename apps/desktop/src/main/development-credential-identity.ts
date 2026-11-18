import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

interface DevelopmentCredentialApp {
  isPackaged: boolean;
  isReady(): boolean;
  getAppPath(): string;
  getPath(name: 'userData' | 'sessionData'): string;
  setPath(name: 'userData' | 'sessionData', path: string): void;
  setName(name: string): void;
}

export class DevelopmentCredentialIdentityError extends Error {
  constructor() {
    super('Invalid prepared development credential identity configuration.');
    this.name = 'DevelopmentCredentialIdentityError';
  }
}

function canonicalPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw new DevelopmentCredentialIdentityError();
  const canonical = realpathSync(value);
  if (canonical !== value || resolve(value) !== value)
    throw new DevelopmentCredentialIdentityError();
  return canonical;
}

function metadata(path: string): Record<string, unknown> {
  const file = statSync(path);
  if (!file.isFile() || file.size > 64 * 1024) throw new DevelopmentCredentialIdentityError();
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new DevelopmentCredentialIdentityError();
  return value as Record<string, unknown>;
}

export function configureDevelopmentCredentialIdentity({
  app,
  entryPath,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
}: {
  app: DevelopmentCredentialApp;
  entryPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}): string | null {
  if (app.isPackaged || platform !== 'darwin' || env.DNAFORGE_DEV_RUNTIME_CONFIG === undefined)
    return null;

  try {
    if (app.isReady()) throw new DevelopmentCredentialIdentityError();
    const appDirectory = canonicalPath(app.getAppPath());
    const cacheRoot = join(appDirectory, '.cache/dnaforge-dev-runtime');
    const configPath = canonicalPath(env.DNAFORGE_DEV_RUNTIME_CONFIG);
    if (configPath !== join(cacheRoot, 'runtime.json'))
      throw new DevelopmentCredentialIdentityError();
    const configuration = metadata(configPath);
    if (
      configuration.schemaVersion !== 1 ||
      canonicalPath(configuration.appDirectory) !== appDirectory ||
      canonicalPath(configuration.entry) !== canonicalPath(entryPath) ||
      configuration.entry !== join(appDirectory, 'out/main/index.js') ||
      canonicalPath(configuration.electronBinary) !== canonicalPath(execPath)
    )
      throw new DevelopmentCredentialIdentityError();

    const bundle = dirname(dirname(dirname(execPath)));
    const versionDirectory = dirname(bundle);
    const fingerprint = basename(versionDirectory);
    if (
      !/^[0-9a-f]{24}$/.test(fingerprint) ||
      execPath !== join(cacheRoot, fingerprint, 'Electron.app/Contents/MacOS/Electron')
    )
      throw new DevelopmentCredentialIdentityError();
    const readyPath = join(versionDirectory, 'ready.json');
    canonicalPath(readyPath);
    const ready = metadata(readyPath);
    const worktreeId = createHash('sha256').update(appDirectory).digest('hex').slice(0, 16);
    const bundleId = `com.dnaforge.development.${worktreeId}.${fingerprint}`;
    const scheme = configuration.scheme;
    if (
      ready.fingerprint !== fingerprint ||
      ready.bundleId !== bundleId ||
      typeof scheme !== 'string' ||
      !/^dnaforge-dev-([1-9]\d{0,4})$/.test(scheme) ||
      Number(scheme.slice('dnaforge-dev-'.length)) > 65535 ||
      ready.scheme !== scheme
    )
      throw new DevelopmentCredentialIdentityError();
    const plist = join(bundle, 'Contents/Info.plist');
    canonicalPath(plist);
    if (!statSync(plist).isFile() || statSync(plist).size > 1024 * 1024)
      throw new DevelopmentCredentialIdentityError();
    const actualBundleId = execFileSync(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trimEnd();
    if (actualBundleId !== bundleId) throw new DevelopmentCredentialIdentityError();

    const userData = app.getPath('userData');
    const sessionData = app.getPath('sessionData');
    app.setPath('userData', userData);
    app.setPath('sessionData', sessionData);
    const name = `DNAForge Dev ${worktreeId}.${fingerprint}`;
    app.setName(name);
    return name;
  } catch {
    throw new DevelopmentCredentialIdentityError();
  }
}

import { keyringContract } from '../../shared/ipc/keyring.contract';
import { handleGroup } from '../../shared/ipc-contract';
import { safeStorage, app } from 'electron';
import { readFile, writeFile, mkdir, unlink, rename, stat, link } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { KEYRING_SERVICE, LEGACY_KEYRING_SERVICE } from '../../shared/keyring-service';
import { isQualificationEphemeralAuthEnabled } from '../qualification-auth-state';

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

let sharedUserDataPath: string | null = null;

export function configureSharedCredentialStorage(userDataPath: string | null): void {
  sharedUserDataPath = userDataPath;
}

function validateCredentialArgs(service: string, name: string): void {
  if (!SAFE_NAME.test(service) || !SAFE_NAME.test(name)) {
    throw new Error('Invalid credential service or name');
  }
}

function credentialsDir(): string {
  return join(sharedUserDataPath ?? app.getPath('userData'), 'credentials');
}

const getCredPath = (service: string, name: string) =>
  join(credentialsDir(), `${service}-${name}.enc`);

function legacyCredPath(service: string, name: string): string | null {
  return service === KEYRING_SERVICE ? getCredPath(LEGACY_KEYRING_SERVICE, name) : null;
}

async function credentialFileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function profileCredentialPaths(service: string, name: string): string[] {
  const dir = join(app.getPath('userData'), 'credentials');
  return [
    join(dir, `${service}-${name}.enc`),
    ...(service === KEYRING_SERVICE ? [join(dir, `${LEGACY_KEYRING_SERVICE}-${name}.enc`)] : []),
  ];
}

async function decryptCredentialFiles(paths: string[]): Promise<string | null> {
  const buffers = await Promise.all(paths.map(readFileOrNull));

  if (buffers[0]?.length === 0) return null;
  if (!buffers.some((buffer) => buffer?.length)) return null;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption not available');
  for (const buffer of buffers) {
    if (!buffer?.length) continue;
    try {
      return safeStorage.decryptString(buffer);
    } catch {}
  }
  return null;
}

async function persistCredentialRecord(
  path: string,
  contents: Buffer,
  onlyIfAbsent = false
): Promise<void> {
  await mkdir(credentialsDir(), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, contents, { mode: 0o600, flag: 'wx' });
    if (onlyIfAbsent) {
      try {
        await link(tmpPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } else {
      await rename(tmpPath, path);
    }
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function hasCredential(service: string, name: string): Promise<boolean> {
  validateCredentialArgs(service, name);
  if (isQualificationEphemeralAuthEnabled()) return false;
  const primarySize = await credentialFileSize(getCredPath(service, name));
  if (primarySize !== null) return primarySize > 0;
  const legacy = legacyCredPath(service, name);
  const legacySize = legacy ? await credentialFileSize(legacy) : null;
  if (legacySize !== null) return legacySize > 0;
  if (sharedUserDataPath && sharedUserDataPath !== app.getPath('userData')) {
    for (const path of profileCredentialPaths(service, name)) {
      const size = await credentialFileSize(path);
      if (size !== null) return size > 0;
    }
  }
  return false;
}

export async function readCredential(service: string, name: string): Promise<string | null> {
  validateCredentialArgs(service, name);
  if (isQualificationEphemeralAuthEnabled()) return null;
  const primary = getCredPath(service, name);
  const legacy = legacyCredPath(service, name);
  const paths = [primary, ...(legacy ? [legacy] : [])];
  if (
    !sharedUserDataPath ||
    sharedUserDataPath === app.getPath('userData') ||
    (await credentialFileSize(primary)) !== null ||
    (legacy && (await credentialFileSize(legacy)) !== null)
  ) {
    return decryptCredentialFiles(paths);
  }
  const value = await decryptCredentialFiles(profileCredentialPaths(service, name));
  if (value === null) return null;

  await persistCredentialRecord(primary, safeStorage.encryptString(value), true);
  return decryptCredentialFiles(paths);
}

export async function writeCredential(
  service: string,
  name: string,
  password: string
): Promise<void> {
  validateCredentialArgs(service, name);
  if (isQualificationEphemeralAuthEnabled()) {
    throw new Error('QUALIFICATION_EPHEMERAL_AUTH_FORBIDS_KEYRING');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available');
  }
  const encrypted = safeStorage.encryptString(password);
  const finalPath = getCredPath(service, name);
  await persistCredentialRecord(finalPath, encrypted);

  const legacy = legacyCredPath(service, name);
  if (legacy) {
    try {
      await unlink(legacy);
    } catch {}
  }
}

export async function deleteCredential(service: string, name: string): Promise<void> {
  validateCredentialArgs(service, name);
  if (isQualificationEphemeralAuthEnabled()) return;
  if (sharedUserDataPath) {
    await persistCredentialRecord(getCredPath(service, name), Buffer.alloc(0));
    return;
  }
  const paths = [getCredPath(service, name)];
  const legacy = legacyCredPath(service, name);
  if (legacy) paths.push(legacy);
  for (const path of paths) {
    try {
      await unlink(path);
    } catch {}
  }
}

export function registerKeyringHandlers(): void {
  handleGroup(keyringContract, {
    hasPassword: (_event, service: string, name: string) => hasCredential(service, name),
    getPassword: (_event, service: string, name: string) => readCredential(service, name),
    setPassword: (_event, service: string, name: string, password: string) =>
      writeCredential(service, name, password),
    deletePassword: (_event, service: string, name: string) => deleteCredential(service, name),
  });
}

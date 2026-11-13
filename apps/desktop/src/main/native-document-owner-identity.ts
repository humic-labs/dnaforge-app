import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

const ownerPattern =
  /^native-v1:([a-f0-9]{64}):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function nativeDocumentProfileKey(userDataPath: string): string {
  return createHash('sha256').update(realpathSync(userDataPath)).digest('hex');
}

export function createProfileBoundNativeDocumentOwnerId(profileKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(profileKey)) throw new Error('Invalid native document profile key.');
  return `native-v1:${profileKey}:${randomUUID()}`;
}

export function nativeDocumentOwnerProfile(ownerId: string): string | undefined {
  return ownerPattern.exec(ownerId)?.[1];
}

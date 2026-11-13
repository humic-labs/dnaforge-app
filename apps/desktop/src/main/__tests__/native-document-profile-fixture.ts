import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { nativeDocuments } from '../features/native-documents';

export function installNativeDocumentTestProfile(): void {
  let profile: string | undefined;
  let bound = false;
  beforeAll(async () => {
    profile = await realpath(await mkdtemp(join(tmpdir(), 'native-document-test-profile-')));
    nativeDocuments.bindProfile(profile);
    bound = true;
  });
  afterAll(async () => {
    if (bound) await nativeDocuments.closeServerAndRecovery();
    if (profile) await rm(profile, { recursive: true, force: true });
  });
}

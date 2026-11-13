import { app } from 'electron';
import { join } from 'node:path';
import { configureSharedCredentialStorage } from '../ipc/keyring';
import type { MainFeature } from './main-feature';

export const credentialStorageFeature = {
  id: 'credential-storage',
  configureProfile: ({ isolated }) =>
    configureSharedCredentialStorage(isolated ? null : join(app.getPath('appData'), 'DNAForge')),
} satisfies MainFeature;

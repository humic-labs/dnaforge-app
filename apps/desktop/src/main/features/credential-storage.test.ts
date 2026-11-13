// @vitest-environment node
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  configureSharedCredentialStorage: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getPath: mocks.getPath } }));
vi.mock('../ipc/keyring', () => ({
  configureSharedCredentialStorage: mocks.configureSharedCredentialStorage,
}));

import { credentialStorageFeature } from './credential-storage';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPath.mockReturnValue('/native-app-data');
});

describe('credential storage profile configuration', () => {
  it('keeps explicitly isolated profiles separate from shared connections', () => {
    credentialStorageFeature.configureProfile({ isolated: true });
    expect(mocks.configureSharedCredentialStorage).toHaveBeenCalledExactlyOnceWith(null);
    expect(mocks.getPath).not.toHaveBeenCalled();
  });

  it('configures the shared owner for ordinary profiles', () => {
    credentialStorageFeature.configureProfile({ isolated: false });
    expect(mocks.getPath).toHaveBeenCalledExactlyOnceWith('appData');
    expect(mocks.configureSharedCredentialStorage).toHaveBeenCalledExactlyOnceWith(
      join('/native-app-data', 'DNAForge')
    );
  });
});

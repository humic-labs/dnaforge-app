import { describe, expect, it, vi } from 'vitest';

import {
  checkAndDownloadStartupUpdate,
  startupUpdateCandidateFingerprint,
  type StartupUpdaterPort,
} from '../startup-update-downloader';

function candidate(version = '1.2.4') {
  return {
    version,
    files: [
      {
        url: `DNAForge-${version}.zip`,
        sha512: `sha512-${version}`,
        size: 1234,
      },
    ],
  };
}

function updaterPort(
  results: Array<
    | { isUpdateAvailable: false; updateInfo: ReturnType<typeof candidate> }
    | {
        isUpdateAvailable: true;
        updateInfo: ReturnType<typeof candidate>;
        downloadPromise: Promise<string[]>;
      }
    | Error
  >
): StartupUpdaterPort {
  let index = 0;
  return {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => {
      const result = results[index++];
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('startup update downloader', () => {
  it('downloads through the first healthy authority', async () => {
    const updateInfo = candidate();
    const updater = updaterPort([
      {
        isUpdateAvailable: true,
        updateInfo,
        downloadPromise: Promise.resolve(['/tmp/DNAForge.zip']),
      },
    ]);

    await expect(
      checkAndDownloadStartupUpdate({
        updater,
        feedUrls: ['https://primary.example/updates/stable/arm64'],
      })
    ).resolves.toEqual({
      kind: 'downloaded',
      authorityIndex: 0,
      updateInfo,
      fingerprint: startupUpdateCandidateFingerprint(updateInfo),
    });
  });

  it.each([
    'connect ETIMEDOUT primary.example',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_SOCKET_NOT_CONNECTED',
  ])('uses the next sealed authority after an availability failure: %s', async (message) => {
    const updateInfo = candidate();
    const updater = updaterPort([
      new Error(message),
      {
        isUpdateAvailable: true,
        updateInfo,
        downloadPromise: Promise.resolve(['/tmp/DNAForge.zip']),
      },
    ]);

    await expect(
      checkAndDownloadStartupUpdate({
        updater,
        feedUrls: [
          'https://primary.example/updates/stable/arm64',
          'https://fallback.example/updates/stable/arm64',
        ],
      })
    ).resolves.toMatchObject({ kind: 'downloaded', authorityIndex: 1 });
    expect(updater.setFeedURL).toHaveBeenCalledTimes(2);
  });

  it('does not consult fallback after a healthy no-update response', async () => {
    const updater = updaterPort([{ isUpdateAvailable: false, updateInfo: candidate('1.2.3') }]);

    await expect(
      checkAndDownloadStartupUpdate({
        updater,
        feedUrls: [
          'https://primary.example/updates/stable/arm64',
          'https://fallback.example/updates/stable/arm64',
        ],
      })
    ).resolves.toEqual({ kind: 'no-update', authorityIndex: 0, version: '1.2.3' });
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
  });

  it('fails closed on signature errors instead of hiding them behind fallback', async () => {
    const updater = updaterPort([new Error('code signature validation failed')]);

    await expect(
      checkAndDownloadStartupUpdate({
        updater,
        feedUrls: [
          'https://primary.example/updates/stable/arm64',
          'https://fallback.example/updates/stable/arm64',
        ],
      })
    ).rejects.toThrow(/signature/i);
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
  });

  it('rejects a fallback that changes the candidate after a payload failure', async () => {
    const updater = updaterPort([
      {
        isUpdateAvailable: true,
        updateInfo: candidate('1.2.4'),
        downloadPromise: Promise.reject(new Error('sha512 checksum mismatch')),
      },
      {
        isUpdateAvailable: true,
        updateInfo: candidate('1.2.5'),
        downloadPromise: Promise.resolve(['/tmp/DNAForge.zip']),
      },
    ]);

    await expect(
      checkAndDownloadStartupUpdate({
        updater,
        feedUrls: [
          'https://primary.example/updates/stable/arm64',
          'https://fallback.example/updates/stable/arm64',
        ],
      })
    ).rejects.toThrow(/candidate identity/i);
  });
});

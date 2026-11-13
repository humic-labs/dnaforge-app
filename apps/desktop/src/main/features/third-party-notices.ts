import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, shell } from 'electron';
import { handleGroup } from '../../shared/ipc-contract';
import {
  thirdPartyNoticesContract,
  type ThirdPartyNotices,
} from '../../shared/ipc/third-party-notices.contract';
import type { MainFeature } from './main-feature';

export const THIRD_PARTY_NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';
export const CHROMIUM_LICENSES_FILE = 'LICENSES.chromium.html';

export interface AppResourceLocation {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}

export function appResourceFile(name: string, location: AppResourceLocation): string {
  if (location.isPackaged) return join(location.resourcesPath, name);
  const candidates = [
    join(location.appPath, 'resources', name),
    resolve(location.appPath, '../../resources', name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export async function readThirdPartyNotices(
  location: AppResourceLocation
): Promise<ThirdPartyNotices> {
  try {
    const text = await readFile(appResourceFile(THIRD_PARTY_NOTICES_FILE, location), 'utf8');
    return text.trim() ? { status: 'available', text } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

function currentLocation(): AppResourceLocation {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
}

export function registerThirdPartyNoticesIpc(
  location: () => AppResourceLocation = currentLocation,
  openPath: (file: string) => Promise<string> = (file) => shell.openPath(file)
): () => void {
  return handleGroup(thirdPartyNoticesContract, {
    read: async () => readThirdPartyNotices(location()),
    openChromiumLicenses: async () => {
      const file = appResourceFile(CHROMIUM_LICENSES_FILE, location());
      return existsSync(file) && (await openPath(file)) === '';
    },
  });
}

export const thirdPartyNoticesFeature: MainFeature = {
  id: 'third-party-notices',
  registerIpc: () => registerThirdPartyNoticesIpc(),
};

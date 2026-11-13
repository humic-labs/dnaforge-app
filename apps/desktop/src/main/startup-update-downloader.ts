import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { isUpdateOriginFailoverEligible } from './update-authority';

export interface StartupUpdateInfo {
  version: string;
  files: ReadonlyArray<{
    url: string;
    sha512: string;
    size?: number;
  }>;
}

export interface StartupUpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: StartupUpdateInfo;
  downloadPromise?: Promise<string[]> | null;
}

export interface StartupUpdaterPort {
  setFeedURL(config: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<StartupUpdateCheckResult | null>;
}

export type StartupUpdateResult =
  | { kind: 'no-update'; authorityIndex: number; version: string }
  | {
      kind: 'downloaded';
      authorityIndex: number;
      updateInfo: StartupUpdateInfo;
      fingerprint: string;
    };

function payloadName(value: string): string {
  try {
    return basename(new URL(value).pathname);
  } catch {
    return basename(value);
  }
}

export function startupUpdateCandidateFingerprint(updateInfo: StartupUpdateInfo): string {
  const files = updateInfo.files
    .map((file) => ({
      name: payloadName(file.url),
      sha512: file.sha512,
      size: file.size ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash('sha256')
    .update(JSON.stringify({ version: updateInfo.version, files }), 'utf8')
    .digest('hex');
}

export async function checkAndDownloadStartupUpdate(input: {
  updater: StartupUpdaterPort;
  feedUrls: readonly string[];
  onAuthorityAttempt?: (authorityIndex: number) => void;
}): Promise<StartupUpdateResult> {
  if (input.feedUrls.length === 0) {
    throw new Error('Startup update has no sealed update authority');
  }

  let expectedFingerprint: string | null = null;
  let lastAvailabilityError: unknown = null;

  for (let authorityIndex = 0; authorityIndex < input.feedUrls.length; authorityIndex += 1) {
    input.onAuthorityAttempt?.(authorityIndex);
    input.updater.setFeedURL({ provider: 'generic', url: input.feedUrls[authorityIndex] });

    let result: StartupUpdateCheckResult | null;
    try {
      result = await input.updater.checkForUpdates();
    } catch (error) {
      if (authorityIndex + 1 < input.feedUrls.length && isUpdateOriginFailoverEligible(error)) {
        lastAvailabilityError = error;
        continue;
      }
      throw error;
    }

    if (!result) {
      const error = new Error('Startup update check returned no result');
      if (authorityIndex + 1 < input.feedUrls.length) {
        lastAvailabilityError = error;
        continue;
      }
      throw error;
    }

    if (!result.isUpdateAvailable) {
      if (expectedFingerprint) {
        throw new Error('Fallback authority changed or removed the expected candidate identity');
      }
      return {
        kind: 'no-update',
        authorityIndex,
        version: result.updateInfo.version,
      };
    }

    const fingerprint = startupUpdateCandidateFingerprint(result.updateInfo);
    if (expectedFingerprint && fingerprint !== expectedFingerprint) {
      throw new Error('Fallback authority changed the expected candidate identity');
    }
    expectedFingerprint ??= fingerprint;

    try {
      if (!result.downloadPromise) {
        throw new Error('Startup update downloader did not start a candidate download');
      }
      await result.downloadPromise;
      return {
        kind: 'downloaded',
        authorityIndex,
        updateInfo: result.updateInfo,
        fingerprint,
      };
    } catch (error) {
      if (authorityIndex + 1 < input.feedUrls.length && isUpdateOriginFailoverEligible(error)) {
        lastAvailabilityError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastAvailabilityError ?? new Error('Every startup update authority failed');
}

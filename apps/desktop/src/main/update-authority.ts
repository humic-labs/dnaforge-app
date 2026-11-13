import { app } from 'electron';

import checkedInUpdateAuthority from '../../update-authority.json';

const UPDATE_AUTHORITY_STAMP_PREFIX = 'DNAFORGE_UPDATE_AUTHORITIES=';
const UPDATE_AUTHORITY_STAMP_SUFFIX = '::UPDATE_AUTHORITY_V2::END';
const SUPPORTED_UPDATE_ARCHITECTURES = new Set(['arm64', 'x64']);
export const UPDATE_FEED_ROOT = 'humic/updates';
const MAC_TEAM_ID_CUTOVER_ENABLED =
  typeof __DNAFORGE_MAC_TEAM_ID_CUTOVER__ === 'boolean' && __DNAFORGE_MAC_TEAM_ID_CUTOVER__;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseCompiledUpdateAuthorities(stamp: string): string[] {
  if (
    !stamp.startsWith(UPDATE_AUTHORITY_STAMP_PREFIX) ||
    !stamp.endsWith(UPDATE_AUTHORITY_STAMP_SUFFIX)
  ) {
    throw new Error('Desktop update authority stamp is missing or malformed');
  }
  const encoded = stamp.slice(
    UPDATE_AUTHORITY_STAMP_PREFIX.length,
    -UPDATE_AUTHORITY_STAMP_SUFFIX.length
  );
  const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!Array.isArray(parsed) || parsed.some((origin) => typeof origin !== 'string')) {
    throw new Error('Desktop update authority stamp does not contain an ordered origin list');
  }
  return parsed;
}

const UPDATE_FEED_BASE = typeof __UPDATE_FEED_BASE__ !== 'undefined' ? __UPDATE_FEED_BASE__ : '';
const UPDATE_FEED_BASES =
  typeof __UPDATE_FEED_AUTHORITY_STAMP__ !== 'undefined'
    ? parseCompiledUpdateAuthorities(__UPDATE_FEED_AUTHORITY_STAMP__)
    : checkedInUpdateAuthority.stableFeedBases;
if (UPDATE_FEED_BASE && UPDATE_FEED_BASE !== UPDATE_FEED_BASES[0]) {
  throw new Error('Desktop updater compatibility primary disagrees with sealed authorities');
}

export function resolveUpdateFeedUrl(
  opts: {
    testFeedUrl?: string;
    feedBase?: string;
    arch?: string;
    isPackaged?: boolean;
    envFeedUrl?: string;
  } = {}
): string {
  return resolveUpdateFeedUrls({
    ...opts,
    feedBases: opts.feedBase === undefined ? undefined : [opts.feedBase],
  })[0];
}

export function resolveUpdateFeedUrls(
  opts: {
    testFeedUrl?: string;
    feedBases?: readonly string[];
    arch?: string;
    isPackaged?: boolean;
    envFeedUrl?: string;
  } = {}
): string[] {
  const isPackaged = opts.isPackaged ?? app.isPackaged;
  const envFeedUrl = opts.envFeedUrl ?? process.env.WAYPOINT_UPDATE_FEED_URL;
  const testFeedUrl = opts.testFeedUrl ?? (isPackaged ? undefined : envFeedUrl);
  if (testFeedUrl) return [testFeedUrl];
  const arch = opts.arch ?? process.arch;
  if (!SUPPORTED_UPDATE_ARCHITECTURES.has(arch)) {
    throw new Error(`Unsupported architecture for desktop updates: ${arch}`);
  }
  const bases = (opts.feedBases ?? UPDATE_FEED_BASES)
    .map((base) => base.replace(/\/+$/, ''))
    .filter(Boolean);
  if (bases.length === 0) {
    throw new Error('Desktop update authority is empty; refusing private-GitHub fallback');
  }
  if (new Set(bases).size !== bases.length) {
    throw new Error('Desktop update authorities must be unique');
  }
  return bases.map((base) => `${base}/${UPDATE_FEED_ROOT}/stable/${arch}`);
}

export function isUpdateOriginFailoverEligible(error: unknown): boolean {
  const message = errorMessage(error);
  if (
    /not signed|signature|code sign|designated requirement|publisher(?:Name)?|downgrade|not supported|unsupported (?:platform|system|architecture)|minimum system/i.test(
      message
    )
  ) {
    return false;
  }
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_(?:INTERNET|NETWORK|NAME|CONNECTION_(?:REFUSED|RESET|CLOSED|ABORTED|TIMED_OUT|FAILED)\b|SOCKET_NOT_CONNECTED\b|TIMED_OUT\b)|socket hang up|network|timed? ?out|HTTP Error [45]\d\d|status(?: code)? [45]\d\d|latest-mac\.ya?ml|latest\.ya?ml|channel .*not found|YAMLException|bad indentation|checksum|sha512|fetch|TLS|certificate/i.test(
    message
  );
}

export function isValidationAppIdentity(input: { isPackaged: boolean; appName: string }): boolean {
  return input.isPackaged && input.appName === 'DNAForge Validation';
}

export function shouldDisableAutoUpdaterForMacTeamIdCutover(input: {
  macTeamIdCutoverEnabled: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return input.macTeamIdCutoverEnabled && input.platform === 'darwin';
}

export function isMacTeamIdCutoverBuild(platform: NodeJS.Platform = process.platform): boolean {
  return shouldDisableAutoUpdaterForMacTeamIdCutover({
    macTeamIdCutoverEnabled: MAC_TEAM_ID_CUTOVER_ENABLED,
    platform,
  });
}

export function isAutoUpdateSupportedIdentity(input: {
  isPackaged: boolean;
  appName: string;
  platform?: NodeJS.Platform;
}): boolean {
  return (
    !isValidationAppIdentity(input) && !isMacTeamIdCutoverBuild(input.platform ?? process.platform)
  );
}

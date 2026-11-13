import type { BbiRangeGrant } from './bbi-reader-worker-protocol';
import type { RemoteSignalLocatorV1 } from '../../shared/remote-genomics-ipc';
import { isRemoteSshTarget } from '../../shared/remote-ssh-target';

export function isRemoteSignalLocator(value: unknown): value is RemoteSignalLocatorV1 {
  if (!value || typeof value !== 'object') return false;
  const locator = value as Partial<RemoteSignalLocatorV1>;
  return (
    Object.keys(value).every((key) =>
      ['contract', 'endpointId', 'target', 'signalPath'].includes(key)
    ) &&
    locator.contract === 'remote-signal-locator.v1' &&
    typeof locator.endpointId === 'string' &&
    locator.endpointId.trim().length > 0 &&
    typeof locator.target === 'string' &&
    isRemoteSshTarget(locator.target) &&
    typeof locator.signalPath === 'string' &&
    locator.signalPath.startsWith('/') &&
    !locator.signalPath.includes('\0')
  );
}

export function durableRemoteSignalUri(
  locator: Pick<RemoteSignalLocatorV1, 'target' | 'signalPath'>
): string {
  return `ssh://${locator.target}${locator.signalPath}`;
}

export function sameRemoteSignalLocator(
  left: RemoteSignalLocatorV1 | undefined,
  right: RemoteSignalLocatorV1 | undefined
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.endpointId === right.endpointId &&
      left.target === right.target &&
      left.signalPath === right.signalPath
    )
  );
}

export interface RemoteSignalGrantSource {
  readonly uri: string;
  readonly fingerprint: string;
  readonly expectedValidators?: {
    readonly contentLength?: number;
    readonly etag?: string;
    readonly lastModified?: string;
  };
}

const TRUSTED_REMOTE_SIGNAL_URL =
  /^http:\/\/127\.0\.0\.1:(\d{1,5})\/v1\/([A-Za-z0-9_-]{8,128})\/signal\.bigWig$/u;

export function isTrustedRemoteSignalUrl(value: string): boolean {
  return remoteSignalSourceId(value) !== null;
}

export function remoteSignalSourceId(value: string): string | null {
  const match = TRUSTED_REMOTE_SIGNAL_URL.exec(value);
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65_535) return null;
  return match[2] ?? null;
}

export function remoteAlignmentSourceId(value: string): string | null {
  const alignmentRoute = /\/alignment\.(?:bam|cram)$/u;
  if (!alignmentRoute.test(value)) return null;
  return remoteSignalSourceId(value.replace(alignmentRoute, '/signal.bigWig'));
}

export function directRemoteSignalGrant(source: RemoteSignalGrantSource): BbiRangeGrant {
  if (!isTrustedRemoteSignalUrl(source.uri)) {
    throw new Error('The remote histogram URL is not a DNAForge SSH range endpoint.');
  }
  const byteLength = source.expectedValidators?.contentLength;
  if (byteLength == null || !Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error('The remote histogram is missing its file length.');
  }
  return {
    baseUrl: 'http://127.0.0.1',
    sourceUri: source.uri,
    sourceToken: `remote-signal:${source.uri}`,
    canonicalUrlHash: source.fingerprint,
    byteLength,
    ...(source.expectedValidators?.etag ? { etag: source.expectedValidators.etag } : {}),
    ...(source.expectedValidators?.lastModified
      ? { lastModified: source.expectedValidators.lastModified }
      : {}),
    provenanceId: source.fingerprint,
    directRangeUrl: source.uri,
    expiresAtMs: Date.now() + 12 * 60 * 60 * 1000,
  };
}

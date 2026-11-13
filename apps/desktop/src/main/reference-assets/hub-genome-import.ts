import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { join } from 'node:path';

import type { ReferenceAssetPreparationProgressUpdateV1 } from '../../shared/reference-assets-ipc';
import {
  requestHostedReferenceAsset,
  type HostedReferenceFetch,
} from './hosted-reference-transport';
import { convertTwoBitToFasta, hasTwoBitSignature, type TwoBitSequenceSummary } from './twobit';

export const HUB_GENOME_SEQUENCE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;
export const HUB_GENOME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface HubGenomeSequenceLocator {
  readonly hubUrl: string;
  readonly genome: string;
  readonly twoBitPath: string;
}

export interface HubGenomeUrlPolicy {
  readonly allowLoopbackHttpForTests: boolean;
}

export interface HubGenomeSequenceDownload {
  readonly url: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface AcquireHubGenomeFastaInput {
  readonly locator: HubGenomeSequenceLocator;
  readonly stagingRoot: string;
  readonly policy: HubGenomeUrlPolicy;
  readonly onProgress: (update: ReferenceAssetPreparationProgressUpdateV1) => void;
  readonly fetchAsset?: HostedReferenceFetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxSequenceBytes?: number;
}

export interface AcquireHubGenomeFastaResult {
  readonly fastaPath: string;
  readonly download: HubGenomeSequenceDownload;
  readonly sequences: ReadonlyArray<TwoBitSequenceSummary>;
  readonly totalBases: number;
}

export class HubGenomeSequenceError extends Error {
  readonly code: 'HUB_SEQUENCE_URL_REFUSED' | 'HUB_SEQUENCE_DOWNLOAD_FAILED';

  constructor(message: string, code: HubGenomeSequenceError['code']) {
    super(message);
    this.name = 'HubGenomeSequenceError';
    this.code = code;
  }
}

function refuse(message: string): never {
  throw new HubGenomeSequenceError(message, 'HUB_SEQUENCE_URL_REFUSED');
}

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

function ipv4IsNonGlobal(address: string): boolean {
  const [a, b] = address.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isNonGlobalHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare === '') return true;
  if (isIPv4(bare)) return ipv4IsNonGlobal(bare);
  if (isIPv6(bare)) {
    if (bare === '::' || bare === '::1') return true;
    const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(bare);
    if (mappedDotted) return ipv4IsNonGlobal(mappedDotted[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(bare);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      return ipv4IsNonGlobal(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    const head = bare.split(':')[0]!;
    return /^f[cd]/u.test(head) || /^fe[89ab]/u.test(head) || /^fe[c-f]/u.test(head);
  }
  return false;
}

export function resolveHubGenomeSequenceUrl(
  locator: HubGenomeSequenceLocator,
  policy: HubGenomeUrlPolicy
): URL {
  if (!HUB_GENOME_ID_PATTERN.test(locator.genome)) refuse('The hub genome name is invalid.');
  if (locator.hubUrl.length > MAX_URL_LENGTH || locator.twoBitPath.length > MAX_URL_LENGTH) {
    refuse('The hub sequence address is too long.');
  }
  let hub: URL;
  try {
    hub = new URL(locator.hubUrl);
  } catch {
    return refuse('The hub address must be an absolute URL.');
  }
  if (hub.protocol !== 'https:' && hub.protocol !== 'http:') {
    refuse('The hub address must use HTTP or HTTPS.');
  }
  let resolved: URL;
  try {
    resolved = new URL(locator.twoBitPath, hub);
  } catch {
    return refuse('The hub sequence address is invalid.');
  }
  return admitSequenceUrl(resolved, policy);
}

function admitSequenceUrl(url: URL, policy: HubGenomeUrlPolicy): URL {
  const loopbackHttp =
    policy.allowLoopbackHttpForTests &&
    url.protocol === 'http:' &&
    isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    refuse('Hub sequences are downloaded over HTTPS only.');
  }
  if (url.username || url.password || url.search || url.hash) {
    refuse('The hub sequence address cannot carry credentials, a query, or a fragment.');
  }
  if (!loopbackHttp && isNonGlobalHostname(url.hostname)) {
    refuse('The hub sequence address must use a public host.');
  }
  if (!/\.2bit$/iu.test(url.pathname)) {
    refuse('The hub sequence address must point at a .2bit file.');
  }
  return url;
}

export async function downloadHubGenomeSequence(input: {
  readonly url: URL;
  readonly destinationPath: string;
  readonly policy: HubGenomeUrlPolicy;
  readonly fetchAsset?: HostedReferenceFetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly onProgress?: (received: number, total: number | null) => void;
}): Promise<HubGenomeSequenceDownload> {
  const maxBytes = input.maxBytes ?? HUB_GENOME_SEQUENCE_MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])];
  const signal = AbortSignal.any(signals);
  const fetchAsset = input.fetchAsset ?? globalThis.fetch;

  let url = input.url;
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const candidate = await requestHostedReferenceAsset({
      url,
      label: 'assembly hub sequence',
      fetchAsset,
      redirect: 'manual',
      headers: { 'user-agent': 'dnaforge-assembly-hub-import/1.0' },
      signal,
    });
    if (candidate.status >= 300 && candidate.status <= 399) {
      const location = candidate.headers.get('location');
      void candidate.body?.cancel().catch(() => undefined);
      if (!location || hop === MAX_REDIRECTS) {
        throw new HubGenomeSequenceError(
          `The hub sequence download redirected too many times (${url.href}).`,
          'HUB_SEQUENCE_DOWNLOAD_FAILED'
        );
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new HubGenomeSequenceError(
          'The hub sequence download redirected to an invalid address.',
          'HUB_SEQUENCE_DOWNLOAD_FAILED'
        );
      }
      url = admitSequenceUrl(next, input.policy);
      continue;
    }
    response = candidate;
    break;
  }
  if (!response) throw new Error('unreachable: redirect loop exited without a response');
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new HubGenomeSequenceError(
      `The hub sequence could not be downloaded (HTTP ${response.status} from ${url.host}).`,
      'HUB_SEQUENCE_DOWNLOAD_FAILED'
    );
  }
  const declaredLengthRaw = response.headers.get('content-length');
  const declaredLength = declaredLengthRaw === null ? null : Number(declaredLengthRaw);
  if (
    declaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > maxBytes)
  ) {
    void response.body.cancel().catch(() => undefined);
    throw new HubGenomeSequenceError(
      `The hub sequence declares ${declaredLengthRaw ?? 'an invalid'} bytes, beyond the ${maxBytes.toLocaleString('en-US')}-byte limit.`,
      'HUB_SEQUENCE_DOWNLOAD_FAILED'
    );
  }

  const handle = await open(input.destinationPath, 'wx', 0o600);
  const sha256 = createHash('sha256');
  let byteLength = 0;
  let head: Buffer = Buffer.alloc(0);
  let signatureChecked = false;
  const reader = response.body.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const bytes = Buffer.from(chunk.value);
      if (!signatureChecked) {
        head = Buffer.concat([head, bytes]);
        if (head.byteLength >= 4) {
          if (!hasTwoBitSignature(head)) {
            throw new HubGenomeSequenceError(
              `${url.pathname.split('/').pop()} is not a UCSC 2bit sequence file.`,
              'HUB_SEQUENCE_DOWNLOAD_FAILED'
            );
          }
          signatureChecked = true;
        }
      }
      byteLength += bytes.byteLength;
      if (byteLength > maxBytes) {
        throw new HubGenomeSequenceError(
          `The hub sequence exceeds the ${maxBytes.toLocaleString('en-US')}-byte limit.`,
          'HUB_SEQUENCE_DOWNLOAD_FAILED'
        );
      }
      sha256.update(bytes);
      await handle.writeFile(bytes);
      input.onProgress?.(byteLength, declaredLength);
      chunk = await reader.read();
    }
    if (!signatureChecked) {
      throw new HubGenomeSequenceError(
        'The hub sequence download ended before a 2bit header arrived.',
        'HUB_SEQUENCE_DOWNLOAD_FAILED'
      );
    }
    if (declaredLength !== null && byteLength !== declaredLength) {
      throw new HubGenomeSequenceError(
        `The hub sequence download ended after ${byteLength.toLocaleString('en-US')} of ${declaredLength.toLocaleString('en-US')} bytes.`,
        'HUB_SEQUENCE_DOWNLOAD_FAILED'
      );
    }
    await handle.sync();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(input.destinationPath, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
  await handle.close();
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  return {
    url: url.href,
    byteLength,
    sha256: sha256.digest('hex'),
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
  };
}

export async function acquireHubGenomeFasta(
  input: AcquireHubGenomeFastaInput
): Promise<AcquireHubGenomeFastaResult> {
  const url = resolveHubGenomeSequenceUrl(input.locator, input.policy);
  await mkdir(input.stagingRoot, { recursive: true, mode: 0o700 });
  const twoBitPath = join(input.stagingRoot, `${input.locator.genome}.2bit`);
  const fastaPath = join(input.stagingRoot, `${input.locator.genome}.fa`);
  const genome = input.locator.genome;
  input.onProgress({
    phase: 'downloading-hub-sequence',
    label: `Downloading ${genome} sequence from ${url.host}`,
  });
  let lastReported = -1;
  const download = await downloadHubGenomeSequence({
    url,
    destinationPath: twoBitPath,
    policy: input.policy,
    fetchAsset: input.fetchAsset,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    maxBytes: input.maxSequenceBytes,
    onProgress: (received, total) => {
      if (total === null) return;
      const step = Math.floor((received / total) * 100);
      if (step === lastReported) return;
      lastReported = step;
      input.onProgress({
        phase: 'downloading-hub-sequence',
        label: `Downloading ${genome} sequence from ${url.host}`,
        completed: received,
        total,
      });
    },
  });
  input.onProgress({
    phase: 'unpacking-hub-sequence',
    label: `Unpacking ${genome} sequence`,
  });
  let lastUnpackStep = -1;
  const converted = await convertTwoBitToFasta({
    twoBitPath,
    fastaPath,
    signal: input.signal,
    onProgress: (progress) => {
      const step = Math.floor((progress.basesWritten / progress.totalBases) * 100);
      if (step === lastUnpackStep) return;
      lastUnpackStep = step;
      input.onProgress({
        phase: 'unpacking-hub-sequence',
        label: `Unpacking ${genome} sequence (${progress.sequenceName})`,
        completed: progress.basesWritten,
        total: progress.totalBases,
      });
    },
  });
  await rm(twoBitPath, { force: true });
  return { fastaPath, download, sequences: converted.sequences, totalBases: converted.totalBases };
}

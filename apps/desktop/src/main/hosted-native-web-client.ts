import { lookup as nodeLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import ipaddr from 'ipaddr.js';
import { DOMParser } from 'linkedom';

const PRODUCTION_MAXIMUM_BYTES = 2 * 1024 * 1024;
const PRODUCTION_MAXIMUM_TEXT_CHARACTERS = 200_000;
const PRODUCTION_MAXIMUM_REDIRECTS = 5;
const PRODUCTION_TIMEOUT_MS = 15_000;

const SUPPORTED_CONTENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xhtml+xml',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml',
]);

export interface HostedNativeWebLookupAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface HostedNativeWebRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly signal: AbortSignal;
}

export interface HostedNativeWebResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly discard: () => void;
}

export interface HostedNativeWebFetchResult {
  readonly url: string;
  readonly title: string | null;
  readonly content: string;
  readonly content_type: string;
  readonly truncated: boolean;
}

interface HostedNativeWebClientOptions {
  readonly lookup?: (hostname: string) => Promise<readonly HostedNativeWebLookupAddress[]>;
  readonly request?: (request: HostedNativeWebRequest) => Promise<HostedNativeWebResponse>;
  readonly maximumBytes?: number;
  readonly maximumTextCharacters?: number;
  readonly maximumRedirects?: number;
  readonly timeoutMs?: number;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function boundedCeiling(value: number | undefined, productionMaximum: number): number {
  if (value === undefined) return productionMaximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > productionMaximum) {
    throw new Error('Hosted web client limits may only lower the production ceiling.');
  }
  return value;
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}

function validateUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WebFetch requires a safe public web address.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== (url.protocol === 'https:' ? '443' : '80'))
  ) {
    throw new Error('WebFetch requires a safe public web address.');
  }
  const hostname = normalizedHostname(url);
  if (!hostname || (ipaddr.isValid(hostname) && !isPublicAddress(hostname))) {
    throw new Error('WebFetch requires a safe public web address.');
  }
  url.hash = '';
  return url;
}

function singleHeader(
  headers: HostedNativeWebResponse['headers'],
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value[0] : undefined;
}

function contentType(headers: HostedNativeWebResponse['headers']): string {
  const raw = singleHeader(headers, 'content-type');
  return raw?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isRedirect(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readableContent(raw: string, type: string): { title: string | null; content: string } {
  if (type !== 'text/html' && type !== 'application/xhtml+xml') {
    return { title: null, content: normalizeText(raw) };
  }
  const document = new DOMParser().parseFromString(raw, 'text/html');
  for (const element of document.querySelectorAll(
    'script,style,noscript,template,svg,canvas,iframe,object,embed'
  )) {
    element.remove();
  }
  const titleElement = document.querySelector('title');
  const bodyElement = document.querySelector('body');
  const title = normalizeText(titleElement?.textContent ?? '') || null;
  return { title, content: normalizeText(bodyElement?.textContent ?? '') };
}

async function defaultLookup(hostname: string): Promise<readonly HostedNativeWebLookupAddress[]> {
  if (ipaddr.isValid(hostname)) {
    return [{ address: hostname, family: ipaddr.process(hostname).kind() === 'ipv4' ? 4 : 6 }];
  }
  return nodeLookup(hostname, { all: true, verbatim: true }).then((addresses) =>
    addresses.map((address) => ({
      address: address.address,
      family: address.family === 6 ? (6 as const) : (4 as const),
    }))
  );
}

function incomingHeaders(headers: IncomingHttpHeaders): HostedNativeWebResponse['headers'] {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value : value,
    ])
  );
}

async function defaultRequest(request: HostedNativeWebRequest): Promise<HostedNativeWebResponse> {
  const transport = request.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = transport(
      request.url,
      {
        method: 'GET',
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/json,application/xml,text/plain,text/markdown,text/csv;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'DNAForge Hosted AI WebFetch/1.0',
        },
        signal: request.signal,
        lookup: (_hostname, _options, callback) => callback(null, request.address, request.family),
      },
      (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: incomingHeaders(response.headers),
          body: response,
          discard: () => response.destroy(),
        });
      }
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

export class HostedNativeWebClient {
  private readonly lookup: NonNullable<HostedNativeWebClientOptions['lookup']>;
  private readonly request: NonNullable<HostedNativeWebClientOptions['request']>;
  private readonly maximumBytes: number;
  private readonly maximumTextCharacters: number;
  private readonly maximumRedirects: number;
  private readonly timeoutMs: number;

  constructor(options: HostedNativeWebClientOptions = {}) {
    this.lookup = options.lookup ?? defaultLookup;
    this.request = options.request ?? defaultRequest;
    this.maximumBytes = boundedCeiling(options.maximumBytes, PRODUCTION_MAXIMUM_BYTES);
    this.maximumTextCharacters = boundedCeiling(
      options.maximumTextCharacters,
      PRODUCTION_MAXIMUM_TEXT_CHARACTERS
    );
    this.maximumRedirects = boundedCeiling(options.maximumRedirects, PRODUCTION_MAXIMUM_REDIRECTS);
    this.timeoutMs = boundedCeiling(options.timeoutMs, PRODUCTION_TIMEOUT_MS);
  }

  async fetch(rawUrl: string, callerSignal?: AbortSignal): Promise<HostedNativeWebFetchResult> {
    assertNotAborted(callerSignal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError());
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(abortError()), this.timeoutMs);
    timer.unref?.();
    try {
      let url = validateUrl(rawUrl);
      for (let redirectCount = 0; ; redirectCount += 1) {
        assertNotAborted(controller.signal);
        const hostname = normalizedHostname(url);
        const addresses = await this.lookup(hostname);
        assertNotAborted(controller.signal);
        if (
          addresses.length === 0 ||
          addresses.some(
            (entry) => (entry.family !== 4 && entry.family !== 6) || !isPublicAddress(entry.address)
          )
        ) {
          throw new Error('WebFetch requires a safe public web address.');
        }
        const selected = addresses[0]!;
        const response = await this.request({
          url,
          address: selected.address,
          family: selected.family,
          signal: controller.signal,
        });
        if (isRedirect(response.statusCode)) {
          response.discard();
          if (redirectCount >= this.maximumRedirects) {
            throw new Error('WebFetch followed too many redirects.');
          }
          const location = singleHeader(response.headers, 'location');
          if (!location) throw new Error('WebFetch received an invalid redirect.');
          url = validateUrl(new URL(location, url));
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.discard();
          throw new Error(`WebFetch failed with HTTP ${response.statusCode}.`);
        }
        const type = contentType(response.headers);
        if (!SUPPORTED_CONTENT_TYPES.has(type)) {
          response.discard();
          throw new Error('The WebFetch content type is not supported.');
        }
        try {
          const chunks: Uint8Array[] = [];
          let byteCount = 0;
          for await (const chunk of response.body) {
            assertNotAborted(controller.signal);
            byteCount += chunk.byteLength;
            if (byteCount > this.maximumBytes)
              throw new Error('The WebFetch response is too large.');
            chunks.push(chunk);
          }
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
          );
          const readable = readableContent(decoded, type);
          const truncated = readable.content.length > this.maximumTextCharacters;
          return {
            url: url.toString(),
            title: readable.title,
            content: readable.content.slice(0, this.maximumTextCharacters),
            content_type: type,
            truncated,
          };
        } catch (error) {
          response.discard();
          throw error;
        }
      }
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
    }
  }
}

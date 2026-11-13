#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { basename, dirname, join } from 'node:path';
import { type as osType } from 'node:os';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeReplayValue } from './replay-decode.mjs';

const require = createRequire(import.meta.url);
const POSTHOG_DIST_DIR = dirname(require.resolve('posthog-js/dist/lazy-recorder.js'));
const STATIC_JS_NAME = /^[a-z0-9][a-z0-9._-]*\.js$/iu;
const INGESTION_PATHS = new Set(['/e/', '/i/v0/e/', '/s/', '/batch/']);
const CONTROL_PREFIX = '/__dnaforge_posthog/';

export function resolvePostHogStaticAsset(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/static/')) return null;
  const name = basename(pathname);
  if (!STATIC_JS_NAME.test(name)) return null;
  const assetPath = join(POSTHOG_DIST_DIR, name);
  if (!existsSync(assetPath)) return null;
  return assetPath;
}

export async function startPostHogTestCollector({
  port = 0,
  apiKey = 'dnaforge-e2e-key',
  flags = {},
  ledgerPath,
  allowedOrigin,
  allowLoopbackOrigins = false,
  onAllocated,
  onListening,
} = {}) {
  const requests = [];
  const traffic = [];
  const remoteConfig = createRemoteConfig();
  let rateLimitRemaining = 0;
  let rateLimitHeld = false;
  const sockets = new Set();
  let closePromise;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      if (isExpectedClientAbort(error) || res.destroyed) return;
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'collector_failed' });
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function handleRequest(req, res) {
    const receivedAtMonotonicMs = performance.now();
    const requestUrl = new URL(req.url ?? '/', 'http://collector.invalid');
    if (!applyCors(req, res, allowedOrigin, allowLoopbackOrigins)) {
      traffic.push(createTrafficRecord(traffic.length, 'cors', req, requestUrl));
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }

    if (req.method === 'OPTIONS') {
      traffic.push(createTrafficRecord(traffic.length, 'cors', req, requestUrl));
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === `${CONTROL_PREFIX}health`) {
      traffic.push(createTrafficRecord(traffic.length, 'health', req, requestUrl));
      sendJson(res, 200, { ok: true, platform: osType(), requestCount: requests.length });
      return;
    }
    if (requestUrl.pathname === `${CONTROL_PREFIX}reset` && req.method === 'POST') {
      const cursor = requests.length;
      const trafficCursor = traffic.length;
      sendJson(res, 200, { cursor, trafficCursor });
      traffic.push(createTrafficRecord(traffic.length, 'control', req, requestUrl));
      return;
    }
    if (requestUrl.pathname === `${CONTROL_PREFIX}ledger`) {
      const after = parseNonNegativeInt(requestUrl.searchParams.get('after'));
      sendJson(res, 200, requests.slice(after).map(serializeRequest));
      traffic.push(createTrafficRecord(traffic.length, 'control', req, requestUrl));
      return;
    }
    if (requestUrl.pathname === `${CONTROL_PREFIX}traffic`) {
      const after = parseNonNegativeInt(requestUrl.searchParams.get('after'));
      sendJson(res, 200, traffic.slice(after).map(serializeRequest));
      traffic.push(createTrafficRecord(traffic.length, 'control', req, requestUrl));
      return;
    }

    if (requestUrl.pathname === `/array/${apiKey}/config.js`) {
      traffic.push(createTrafficRecord(traffic.length, 'asset', req, requestUrl));
      res.writeHead(200, assetHeaders('application/javascript; charset=utf-8'));
      res.end(createRemoteConfigScript(apiKey, remoteConfig));
      return;
    }
    if (requestUrl.pathname === `/array/${apiKey}/config`) {
      traffic.push(createTrafficRecord(traffic.length, 'asset', req, requestUrl));
      sendJson(res, 200, remoteConfig, assetHeaders('application/json; charset=utf-8'));
      return;
    }
    const staticAsset = resolvePostHogStaticAsset(requestUrl.pathname);
    if (staticAsset) {
      traffic.push(createTrafficRecord(traffic.length, 'asset', req, requestUrl));
      res.writeHead(200, assetHeaders('application/javascript; charset=utf-8'));
      res.end(readFileSync(staticAsset));
      return;
    }
    if (requestUrl.pathname === '/flags/' || requestUrl.pathname === '/flags') {
      const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      traffic.push(
        decodeProtocolRequest({
          ...createTrafficRecord(traffic.length, 'flags', req, requestUrl),
          raw,
        })
      );
      sendJson(res, 200, createFlagsResponse(flags));
      return;
    }

    if (INGESTION_PATHS.has(requestUrl.pathname) && req.method === 'POST') {
      const raw = await readBody(req);
      const record = decodeIngestionRequest({
        index: traffic.length,
        category: 'ingestion',
        receivedAtMonotonicMs,
        method: req.method,
        path: requestUrl.pathname,
        search: requestUrl.search,
        headers: { ...req.headers },
        raw,
      });
      const responseStatus = record.decodeError ? 400 : rateLimitHeld || rateLimitRemaining > 0 ? 429 : 200;
      if (responseStatus === 429 && rateLimitRemaining > 0) rateLimitRemaining -= 1;
      record.responseStatus = responseStatus;
      traffic.push(record);
      requests.push(record);
      if (ledgerPath) appendFileSync(ledgerPath, `${JSON.stringify(serializeRequest(record))}\n`, { mode: 0o600 });
      sendJson(
        res,
        responseStatus,
        record.decodeError
          ? { error: 'decode_failed' }
          : responseStatus === 429
            ? { error: 'rate_limited' }
            : { status: 1 },
        responseStatus === 429 ? { 'retry-after': '1' } : undefined
      );
      return;
    }

    traffic.push(createTrafficRecord(traffic.length, 'other', req, requestUrl));
    sendJson(res, 404, { error: 'not_found' });
  }

  try {
  onAllocated?.({ pid: process.pid });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('collector failed to bind TCP');
  onListening?.({ pid: process.pid, port: address.port });
  const url = `http://127.0.0.1:${address.port}`;

  return {
    observerClock: Object.freeze({ pid: process.pid, timeOrigin: performance.timeOrigin }),
    url,
    apiKey,
    cursor: () => requests.length,
    trafficCursor: () => traffic.length,
    requestsSince: (after = 0) => requests.slice(after),
    rateLimitNext: (count = 1) => {
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error('rate-limit count must be an integer from 1 to 100');
      }
      rateLimitRemaining += count;
    },
    holdRateLimit: () => {
      rateLimitHeld = true;
      return () => { rateLimitHeld = false; };
    },
    trafficSince: (after = 0) => traffic.slice(after),
    waitForTrafficQuiet: (options = {}) => waitForTrafficQuiet(traffic, options),
    eventsSince: (after = 0) =>
      requests.slice(after).flatMap((request) => request.events.map((event) => event.value)),
    waitForEvent: (eventOrPredicate, options = {}) =>
      waitForEvent(requests, eventOrPredicate, options),
    waitForAcceptedEvent: (eventOrPredicate, options = {}) =>
      waitForEvent(requests, eventOrPredicate, { ...options, acceptedOnly: true }),
    expectNoEvent: (eventOrPredicate, options = {}) =>
      expectNoEvent(requests, eventOrPredicate, options),
    findLeaks: (sentinels, options = {}) => findLeaks(requests, traffic, sentinels, options),
    volume: (options = {}) => calculateVolume(requests, options),
    trafficSummary: (options = {}) => calculateTrafficSummary(traffic, options),
    close: () => {
      closePromise ??= closeServer(server, sockets);
      return closePromise;
    },
  };
  } catch (error) {
    try {
      await closeServer(server, sockets);
    } catch (cleanupError) {
      throw Object.assign(new AggregateError([error, cleanupError],
        'Collector startup cleanup unresolved'), { ownedCollector: { pid: process.pid } });
    }
    throw error;
  }
}

function createTrafficRecord(index, category, req, requestUrl) {
  return {
    index,
    category,
    method: req.method ?? 'GET',
    path: requestUrl.pathname,
    search: requestUrl.search,
    headers: { ...req.headers },
    raw: Buffer.alloc(0),
    transportDecoded: Buffer.alloc(0),
    parsed: null,
    events: [],
    nestedReplay: [],
    decodeError: '',
    responseStatus: 0,
  };
}

function createRemoteConfig() {
  return {
    config: {
      supportedCompression: ['gzip-js', 'base64'],
      sessionRecording: {
        sampleRate: '1',
        minimumDurationMilliseconds: 0,
        recordCanvas: false,
        networkPayloadCapture: { recordBody: false, recordHeaders: false },
        scriptConfig: { script: 'lazy-recorder' },
      },
    },
    siteApps: [],
  };
}

function createRemoteConfigScript(apiKey, config) {
  return `window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {};\nwindow._POSTHOG_REMOTE_CONFIG[${JSON.stringify(apiKey)}] = ${JSON.stringify(config)};\n`;
}

function createFlagsResponse(flags) {
  return {
    featureFlags: { ...flags },
    featureFlagPayloads: {},
    flags: Object.fromEntries(
      Object.entries(flags).map(([key, value]) => [
        key,
        { key, enabled: value !== false, variant: typeof value === 'string' ? value : undefined },
      ])
    ),
  };
}

function decodeIngestionRequest(request) {
  const record = decodeProtocolRequest(request);

  if (!record.decodeError) {
    record.events = extractEvents(record.parsed).map((value) => ({
      requestIndex: request.index,
      value,
    }));
    for (const event of record.events) {
      if (event.value.event === '$snapshot') {
        try {
          record.nestedReplay.push(...decodeReplayValue(event.value.properties?.$snapshot_data));
        } catch (error) {
          record.decodeError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  return record;
}

function decodeProtocolRequest(request) {
  const record = {
    ...request,
    transportDecoded: Buffer.alloc(0),
    parsed: null,
    events: [],
    nestedReplay: [],
    decodeError: '',
  };

  try {
    const contentEncoding = headerValue(request.headers['content-encoding']);
    const hasGzipMagic = request.raw[0] === 0x1f && request.raw[1] === 0x8b;
    let decoded = request.raw;
    if (contentEncoding === 'gzip' || hasGzipMagic || request.search.includes('compression=gzip-js')) {
      decoded = gunzipSync(request.raw);
    } else if (request.search.includes('compression=base64')) {
      decoded = Buffer.from(request.raw.toString('utf8'), 'base64');
    }

    const contentType = headerValue(request.headers['content-type']);
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(decoded.toString('utf8'));
      const data = params.get('data');
      if (data === null) {
        if (request.category === 'flags') {
          record.transportDecoded = decoded;
          return record;
        }
        throw new Error('form body is missing data');
      }
      decoded = decodeFormData(data);
    }

    record.transportDecoded = decoded;
    if (decoded.byteLength > 0) record.parsed = JSON.parse(decoded.toString('utf8'));
  } catch (error) {
    record.decodeError = error instanceof Error ? error.message : String(error);
  }

  return record;
}

function decodeFormData(data) {
  const direct = Buffer.from(data, 'utf8');
  try {
    JSON.parse(direct.toString('utf8'));
    return direct;
  } catch {
    const decoded = Buffer.from(data, 'base64');
    JSON.parse(decoded.toString('utf8'));
    return decoded;
  }
}

function extractEvents(parsed) {
  if (Array.isArray(parsed)) return parsed.flatMap(extractEvents);
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed.batch)) return parsed.batch.flatMap(extractEvents);
  if (typeof parsed.event === 'string' && isRecord(parsed.properties)) return [parsed];
  return [];
}


async function waitForEvent(
  requests,
  eventOrPredicate,
  { after = 0, timeoutMs = 5_000, acceptedOnly = false } = {}
) {
  const predicate = eventPredicate(eventOrPredicate);
  const deadline = Date.now() + timeoutMs;
  do {
    const match = requests
      .slice(after)
      .filter(
        (request) =>
          !acceptedOnly || (request.responseStatus >= 200 && request.responseStatus < 300)
      )
      .flatMap((request) => request.events)
      .map((event) => event.value)
      .find(predicate);
    if (match) return match;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for analytics event after request cursor ${after}`);
}

async function expectNoEvent(
  requests,
  eventOrPredicate,
  { after = 0, quietMs = 300 } = {}
) {
  const predicate = eventPredicate(eventOrPredicate);
  const deadline = Date.now() + quietMs;
  do {
    const match = requests
      .slice(after)
      .flatMap((request) => request.events)
      .map((event) => event.value)
      .find(predicate);
    if (match) {
      const diagnostic = JSON.stringify({
        event: match.event,
        properties: match.properties ?? null,
      });
      throw new Error(`unexpected analytics event ${diagnostic}`);
    }
    await delay(5);
  } while (Date.now() < deadline);
}

async function waitForTrafficQuiet(
  traffic,
  { quietMs = 4_000, timeoutMs = 10_000 } = {}
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const summarize = (records) => records.map((record) => ({
    index: record.index,
    category: record.category,
    path: record.path,
    status: record.responseStatus,
    events: record.events.map((event) => event.value.event),
  }));
  const initialTraffic = summarize(traffic.slice(-3));
  const updates = [];
  let observedLength = traffic.length;
  let quietDeadline = Date.now() + quietMs;
  do {
    if (traffic.length !== observedLength) {
      updates.push({
        elapsedMs: Date.now() - startedAt,
        traffic: summarize(traffic.slice(observedLength)),
      });
      if (updates.length > 16) updates.shift();
      observedLength = traffic.length;
      quietDeadline = Date.now() + quietMs;
    }
    if (Date.now() >= quietDeadline) return observedLength;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(
    `analytics traffic did not stay quiet for ${quietMs}ms before timeout; ` +
      `observed ${observedLength} requests; ` +
      JSON.stringify({ initialTraffic, updates })
  );
}

export function isReplayPayload(parsed) {
  if (Array.isArray(parsed)) return parsed.some((entry) => isReplayPayload(entry));
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.event === '$snapshot' || parsed.event === '$snapshot_item') return true;
  if (Array.isArray(parsed.batch)) return parsed.batch.some((entry) => isReplayPayload(entry));
  return false;
}

function findLeaks(
  requests,
  traffic,
  sentinels,
  { after = 0, trafficAfter = 0, ignoreReplay = false } = {}
) {
  const leaks = [];
  for (const request of traffic.slice(trafficAfter)) {
    if (ignoreReplay && isReplayPayload(request.parsed)) continue;
    const layers = [
      ['wire', `${request.raw.toString('utf8')}\n${request.raw.toString('latin1')}`],
      ...(request.category === 'ingestion'
        ? []
        : [
            ['transport_decoded', request.transportDecoded.toString('utf8')],
            ['parsed', request.parsed === null ? '' : JSON.stringify(request.parsed)],
          ]),
    ];
    for (const sentinel of sentinels) {
      for (const [layer, text] of layers) {
        const offset = text.indexOf(sentinel);
        if (offset >= 0) {
          leaks.push({ sentinel, layer, requestIndex: request.index, offset });
        }
      }
    }
  }
  for (const request of requests.slice(after)) {
    if (ignoreReplay && (isReplayPayload(request.parsed) || request.nestedReplay.length > 0)) {
      continue;
    }
    const nestedReplayValues = request.nestedReplay.map((entry) => entry.value);
    const layers = [
      ['transport_decoded', request.transportDecoded.toString('utf8')],
      ['parsed', request.parsed === null ? '' : JSON.stringify(request.parsed)],
      ['nested_rrweb', JSON.stringify(nestedReplayValues)],
    ];
    for (const sentinel of sentinels) {
      for (const [layer, text] of layers) {
        const offset = text.indexOf(sentinel);
        if (offset >= 0) {
          leaks.push({
            sentinel,
            layer,
            requestIndex: request.index,
            offset,
            ...(layer === 'nested_rrweb'
              ? { nestedPath: findStringPath(nestedReplayValues, sentinel) }
              : {}),
          });
        }
      }
    }
  }
  return leaks;
}

function findStringPath(candidate, sentinel, path = '$') {
  if (typeof candidate === 'string') return candidate.includes(sentinel) ? path : null;
  if (Array.isArray(candidate)) {
    for (let index = 0; index < candidate.length; index += 1) {
      const match = findStringPath(candidate[index], sentinel, `${path}[${index}]`);
      if (match) return match;
    }
    return null;
  }
  if (!isRecord(candidate)) return null;
  for (const [key, value] of Object.entries(candidate)) {
    const match = findStringPath(value, sentinel, `${path}.${key}`);
    if (match) return match;
  }
  return null;
}

function calculateTrafficSummary(traffic, { after = 0 } = {}) {
  const selected = traffic.slice(after);
  const byCategory = {};
  for (const request of selected) {
    byCategory[request.category] = (byCategory[request.category] ?? 0) + 1;
  }
  return {
    requestCount: selected.length,
    rawBytes: selected.reduce((sum, request) => sum + request.raw.byteLength, 0),
    byCategory,
  };
}

function calculateVolume(requests, { after = 0 } = {}) {
  const selected = requests.slice(after);
  return {
    requestCount: selected.length,
    eventCount: selected.reduce((sum, request) => sum + request.events.length, 0),
    replayRequestCount: selected.filter((request) => request.path === '/s/').length,
    rawBytes: selected.reduce((sum, request) => sum + request.raw.byteLength, 0),
    decodedBytes: selected.reduce(
      (sum, request) => sum + request.transportDecoded.byteLength,
      0
    ),
    replayDecodedBytes: selected.reduce(
      (sum, request) =>
        sum + request.nestedReplay.reduce((inner, entry) => inner + entry.bytes, 0),
      0
    ),
  };
}

function serializeRequest(request) {
  return {
    index: request.index,
    receivedAtMonotonicMs: request.receivedAtMonotonicMs,
    category: request.category,
    method: request.method,
    path: request.path,
    search: request.search,
    headers: request.headers,
    rawBase64: request.raw.toString('base64'),
    transportDecodedBase64: request.transportDecoded.toString('base64'),
    parsed: request.parsed,
    nestedReplay: request.nestedReplay,
    decodeError: request.decodeError,
    responseStatus: request.responseStatus,
  };
}

function eventPredicate(eventOrPredicate) {
  if (typeof eventOrPredicate === 'function') return eventOrPredicate;
  return (event) => event.event === eventOrPredicate;
}

function isLoopbackHttpOrigin(origin) {
  try {
    const url = new URL(origin);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function applyCors(req, res, configuredOrigin, allowLoopbackOrigins = false) {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;

  const sameOrigin = `http://${headerValue(req.headers.host)}`;
  const allowedOrigin =
    allowLoopbackOrigins && isLoopbackHttpOrigin(origin) ? origin : configuredOrigin || sameOrigin;
  if (origin !== allowedOrigin) return false;

  res.setHeader('access-control-allow-origin', allowedOrigin);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,content-encoding');
  res.setHeader('vary', 'Origin');
  return true;
}

function assetHeaders(contentType) {
  return {
    'content-type': contentType,
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-store',
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function closeServer(server, sockets = new Set()) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      for (const socket of sockets) socket.destroy();
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
  });
}

function isExpectedClientAbort(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')
  );
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseNonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const portArg = process.argv.find((argument) => argument.startsWith('--port='));
  const keyArg = process.argv.find((argument) => argument.startsWith('--api-key='));
  const collector = await startPostHogTestCollector({
    port: portArg ? Number(portArg.slice('--port='.length)) : 0,
    apiKey: keyArg ? keyArg.slice('--api-key='.length) : undefined,
  });
  console.log(JSON.stringify({ url: collector.url, apiKey: collector.apiKey }));
  const stop = async () => {
    await collector.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

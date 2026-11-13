#!/usr/bin/env node
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8791;

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { port: DEFAULT_PORT, journal: null, pidFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--journal') out.journal = argv[++i];
    else if (a === '--pid-file') out.pidFile = argv[++i];
  }
  if (!Number.isInteger(out.port) || out.port < 0) {
    throw new Error(`invalid --port: ${out.port}`);
  }
  return out;
}

export function createJournal() {
  return { startedAt: new Date().toISOString(), requests: [] };
}

export function recordRequest(journal, entry) {
  journal.requests.push({
    ...entry,
    receivedAt: new Date().toISOString(),
  });
}

export function summarizeJournal(journal) {
  const beacons = journal.requests
    .filter((r) => r.path === '/api/diagnostics/install-beacon')
    .map((r) => r.body?.event)
    .filter(Boolean);
  const uploads = journal.requests
    .filter((r) => r.path === '/api/diagnostics/upload')
    .map((r) => r.body?.kind)
    .filter(Boolean);
  return { beacons, uploads, count: journal.requests.length };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function persistJournal(journalPath, journal) {
  if (!journalPath) return;
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
}

export function startMockDiagnosticsServer(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const journalPath = opts.journal ? resolve(opts.journal) : null;
  const journal = createJournal();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...summarizeJournal(journal) }));
      return;
    }

    if (req.method === 'GET' && path === '/journal') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(journal));
      return;
    }

    if (req.method === 'POST' && path === '/reset') {
      journal.requests.length = 0;
      journal.startedAt = new Date().toISOString();
      persistJournal(journalPath, journal);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (
      req.method === 'POST' &&
      (path === '/api/diagnostics/install-beacon' || path === '/api/diagnostics/upload')
    ) {
      let raw = '';
      let body = null;
      try {
        raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      recordRequest(journal, { method: 'POST', path, body, raw });
      persistJournal(journalPath, journal);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : port;
      const baseUrl = `http://127.0.0.1:${boundPort}`;
      resolveListen({
        baseUrl,
        port: boundPort,
        journal,
        journalPath,
        summarize: () => summarizeJournal(journal),
        reset: () => {
          journal.requests.length = 0;
          journal.startedAt = new Date().toISOString();
          persistJournal(journalPath, journal);
        },
        stop: () =>
          new Promise((resolveStop, rejectStop) => {
            server.close((err) => (err ? rejectStop(err) : resolveStop()));
          }),
      });
    });
  });
}

async function main() {
  const args = parseArgs();
  const server = await startMockDiagnosticsServer({
    port: args.port,
    journal: args.journal,
  });
  if (args.pidFile) {
    mkdirSync(dirname(resolve(args.pidFile)), { recursive: true });
    writeFileSync(args.pidFile, String(process.pid), 'utf8');
  }
  console.log(`[mock-diagnostics] listening on ${server.baseUrl}`);
  if (server.journalPath) {
    console.log(`[mock-diagnostics] journal → ${server.journalPath}`);
  }

  const shutdown = async () => {
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirect =
  Boolean(process.argv[1]) &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('/mock-diagnostics-server.mjs') ||
    process.argv[1].endsWith('\\mock-diagnostics-server.mjs'));

if (isDirect) {
  main().catch((err) => {
    console.error('[mock-diagnostics] failed:', err);
    process.exit(1);
  });
}

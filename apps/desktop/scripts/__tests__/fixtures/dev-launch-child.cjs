#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const { createHash } = require('node:crypto');
const path = require('node:path');

const appDir = process.cwd();
const controlPath = path.join(appDir, 'launch-control.json');
const recordPath = path.join(appDir, 'launch-child.json');
const rendererPort = Number(process.env.DESKTOP_DEV_PORT);
const debugPort = Number(process.env.DESKTOP_DEBUG_PORT);
const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'));
const rendererUrl = `http://127.0.0.1:${rendererPort}/`;
const sockets = new Set();

function send(socket, value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = payload.length;
  else {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

const renderer = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>DNAForge</title><div id="root"></div>');
});
const debug = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url !== '/json/list') {
    res.statusCode = 404;
    res.end('{}');
    return;
  }
  res.end(
    JSON.stringify([
      {
        id: 'dev-stack-product-window',
        type: 'page',
        url: rendererUrl,
        webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}/devtools/page/dev-stack-product-window`,
      },
    ])
  );
});
debug.on('upgrade', (req, socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  const accept = createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  let pending = Buffer.alloc(0);
  socket.on('data', (bytes) => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = Boolean(pending[1] & 0x80);
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        socket.destroy();
        return;
      }
      if (pending.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? pending.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      pending = pending.subarray(offset + length);
      if (mask)
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        continue;
      }
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      const current = control();
      fs.appendFileSync(path.join(appDir, 'cdp-requests.jsonl'), JSON.stringify(message) + '\n');
      if (message.method === 'Runtime.evaluate') {
        if (
          !message.params?.expression?.includes('startup') ||
          !message.params.expression.includes('getState')
        ) {
          send(socket, {
            id: message.id,
            result: { exceptionDetails: { text: 'Missing startup.getState probe' } },
          });
          continue;
        }
        send(socket, {
          id: message.id,
          result: {
            result: {
              type: 'object',
              value: {
                loadId: current.loadId ?? 'dev-stack-current-load',
                pageLoaded: Boolean(current.pageLoaded),
                shellReady: Boolean(current.shellReady),
              },
            },
          },
        });
      } else send(socket, { id: message.id, result: {} });
    }
  });
});

Promise.all([
  new Promise((resolve) => renderer.listen(rendererPort, '127.0.0.1', resolve)),
  new Promise((resolve) => debug.listen(debugPort, '127.0.0.1', resolve)),
]).then(() => {
  const cache = path.join(appDir, 'node_modules/.vite/deps/cache-sentinel.js');
  fs.writeFileSync(
    `${recordPath}.tmp`,
    JSON.stringify({
      pid: process.pid,
      args: process.argv.slice(2),
      cache: fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : null,
    })
  );
  fs.renameSync(`${recordPath}.tmp`, recordPath);
  if (control().exitCode) process.exit(control().exitCode);
});

process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  renderer.close();
  debug.close(() => process.exit(0));
});

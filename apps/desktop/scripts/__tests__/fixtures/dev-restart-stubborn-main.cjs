#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');

const [role, portText, rendererPortText, recordPath] = process.argv.slice(2);
const signals = [];
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify([{ type: 'page', url: `http://127.0.0.1:${rendererPortText}/` }]));
});
server.listen(Number(portText), '127.0.0.1', () => {
  fs.writeFileSync(
    `${recordPath}.tmp`,
    JSON.stringify({ pid: process.pid, cwd: process.cwd(), role, port: Number(portText) })
  );
  fs.renameSync(`${recordPath}.tmp`, recordPath);
});
process.on('SIGTERM', () => {
  signals.push('SIGTERM');
  fs.writeFileSync(
    `${recordPath}.signals.tmp`,
    JSON.stringify({ pid: process.pid, ignored: signals })
  );
  fs.renameSync(`${recordPath}.signals.tmp`, `${recordPath}.signals`);
});

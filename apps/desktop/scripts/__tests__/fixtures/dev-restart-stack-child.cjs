#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(150);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function writeAtomic(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

async function main() {
  if (process.argv[2] === 'exec') {
    const config = JSON.parse(fs.readFileSync(process.env.DEV_STACK_RESTART_CONFIG, 'utf8'));
    const ports = await Promise.all(
      Object.entries(config.ports).map(async ([role, port]) => ({
        role,
        port,
        bound: await listening(port),
      }))
    );
    writeAtomic(path.join(process.cwd(), 'replacement-boundary.json'), {
      pid: process.pid,
      oldAlive: Object.entries(config.oldPids).filter(([, pid]) => alive(pid)),
      ports,
      unrelatedAlive: alive(config.unrelatedPid),
      unrelatedListening: await listening(config.unrelatedPort),
    });
    require(process.env.DEV_STACK_SUCCESS_FIXTURE);
    return;
  }

  const [role, portText, rendererPortText, recordPath] = process.argv.slice(2);
  const port = Number(portText);
  const server = http.createServer((req, res) => {
    if (role === 'main') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ type: 'page', url: `http://127.0.0.1:${rendererPortText}/` }]));
    } else if (role === 'renderer') {
      res.statusCode = 503;
      res.end('old renderer is stale');
    } else res.end(`dev-stack-${role}`);
  });
  server.listen(port, '127.0.0.1', () => {
    writeAtomic(recordPath, { pid: process.pid, cwd: process.cwd(), role, port });
  });
  process.on('SIGTERM', () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

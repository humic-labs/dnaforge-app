import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createTcpServer, connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const { devServerNetwork } = createRequire(import.meta.url)('../lib/dev-server-network.cjs');

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function canConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') resolve(false);
      else reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Local connection timed out'));
    });
  });
}

test('renderer and separate HMR listeners accept loopback and refuse the Mac LAN address', async () => {
  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((item) => item && item.family === 'IPv4' && !item.internal)?.address;
  assert.ok(lanAddress, 'A local non-loopback interface is required to verify network isolation');
  const hmrPort = await unusedPort();
  const server = await createServer({
    configFile: false,
    publicDir: false,
    server: devServerNetwork('0', String(hmrPort)),
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(address.address, '127.0.0.1');
    assert.equal(await canConnect('127.0.0.1', address.port), true);
    assert.equal(await canConnect('127.0.0.1', hmrPort), true);
    assert.equal(await canConnect(lanAddress, address.port), false);
    assert.equal(await canConnect(lanAddress, hmrPort), false);
  } finally {
    await server.close();
  }
});

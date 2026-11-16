const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { test } = require('node:test');
const { waitForStoppedPorts } = require('./dev-single-instance-guard.cjs');

async function listener(t) {
  const server = createServer((socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('waits for a signaled listener to finish closing before reporting teardown', async (t) => {
  const server = await listener(t);
  const sweep = [['renderer', server.address().port]];
  const close = setTimeout(() => server.close(), 150);
  t.after(() => clearTimeout(close));
  assert.deepEqual(await waitForStoppedPorts(sweep, undefined, 2000), []);
  assert.equal(server.listening, false);
});

test('reports a listener that stays bound and leaves it running', async (t) => {
  const server = await listener(t);
  const sweep = [['unrelated', server.address().port]];
  assert.deepEqual(await waitForStoppedPorts(sweep, undefined, 100), sweep);
  assert.equal(server.listening, true);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acquireVerifiedArchive, ensureDugiteRuntime } = require('./lib/dugite-runtime.cjs');

const quietLogger = Object.freeze({
  log() {},
  warn() {},
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tempDirectory(t, prefix = 'dugite-runtime-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function archiveEntry(bytes) {
  return {
    name: 'dugite-native-fixture.tar.gz',
    url: 'https://downloads.example.test/dugite-native-fixture.tar.gz',
    checksum: sha256(bytes),
  };
}

test('archive acquisition retries transient HTTP failures and atomically caches verified bytes', async (t) => {
  const cacheDir = tempDirectory(t);
  const bytes = Buffer.from('verified dugite archive');
  const entry = archiveEntry(bytes);
  const statuses = [500, 502, 200];
  const delays = [];
  let calls = 0;

  const result = await acquireVerifiedArchive({
    entry,
    cacheDir,
    maxAttempts: 4,
    fetchImpl: async () => {
      const status = statuses[calls++];
      return new Response(status === 200 ? bytes : 'temporary failure', { status });
    },
    sleep: async (delayMs) => delays.push(delayMs),
    logger: quietLogger,
  });

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(readFileSync(result.archivePath), bytes);
  assert.equal(delays.length, 2);
  assert.ok(delays.every((delay) => delay > 0));
});

test('archive acquisition does not retry a terminal HTTP response', async (t) => {
  const cacheDir = tempDirectory(t);
  const bytes = Buffer.from('unused');
  let calls = 0;

  await assert.rejects(
    acquireVerifiedArchive({
      entry: archiveEntry(bytes),
      cacheDir,
      maxAttempts: 4,
      fetchImpl: async () => {
        calls += 1;
        return new Response('not found', { status: 404 });
      },
      sleep: async () => assert.fail('404 must not be retried'),
      logger: quietLogger,
    }),
    (error) => error?.code === 'DUGITE_DOWNLOAD_HTTP' && error?.status === 404
  );

  assert.equal(calls, 1);
});

test('archive acquisition exhausts bounded retries and still fails closed on persistent HTTP 500', async (t) => {
  const cacheDir = tempDirectory(t);
  const bytes = Buffer.from('unused');
  const delays = [];
  let calls = 0;

  await assert.rejects(
    acquireVerifiedArchive({
      entry: archiveEntry(bytes),
      cacheDir,
      maxAttempts: 4,
      fetchImpl: async () => {
        calls += 1;
        return new Response('upstream unavailable', { status: 500 });
      },
      sleep: async (delayMs) => delays.push(delayMs),
      logger: quietLogger,
    }),
    (error) => error?.code === 'DUGITE_DOWNLOAD_HTTP' && error?.status === 500
  );

  assert.equal(calls, 4);
  assert.equal(delays.length, 3);
  assert.equal(existsSync(join(cacheDir, 'dugite-native-fixture.tar.gz')), false);
});

test('archive acquisition rejects checksum mismatch without caching or retrying it', async (t) => {
  const cacheDir = tempDirectory(t);
  const expected = Buffer.from('expected bytes');
  let calls = 0;

  await assert.rejects(
    acquireVerifiedArchive({
      entry: archiveEntry(expected),
      cacheDir,
      maxAttempts: 4,
      fetchImpl: async () => {
        calls += 1;
        return new Response('tampered bytes', { status: 200 });
      },
      sleep: async () => assert.fail('integrity failures must not be retried'),
      logger: quietLogger,
    }),
    (error) => error?.code === 'DUGITE_ARCHIVE_CHECKSUM'
  );

  assert.equal(calls, 1);
  assert.equal(existsSync(join(cacheDir, 'dugite-native-fixture.tar.gz')), false);
});

test('archive acquisition evicts a corrupt cache entry and reuses a valid one without network', async (t) => {
  const cacheDir = tempDirectory(t);
  const bytes = Buffer.from('verified archive');
  const entry = archiveEntry(bytes);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, entry.name), 'corrupt cache');
  let calls = 0;

  const repaired = await acquireVerifiedArchive({
    entry,
    cacheDir,
    fetchImpl: async () => {
      calls += 1;
      return new Response(bytes, { status: 200 });
    },
    sleep: async () => {},
    logger: quietLogger,
  });
  assert.equal(repaired.cacheHit, false);
  assert.equal(calls, 1);

  const reused = await acquireVerifiedArchive({
    entry,
    cacheDir,
    fetchImpl: async () => assert.fail('valid cache must avoid the network'),
    logger: quietLogger,
  });
  assert.equal(reused.cacheHit, true);
  assert.equal(reused.attempts, 0);
});

test('runtime provisioning writes a bound receipt and a matching runtime is a network-free fast path', async (t) => {
  const root = tempDirectory(t);
  const dugiteRoot = join(root, 'node_modules', 'dugite');
  const cacheDir = join(root, 'cache');
  const bytes = Buffer.from('fixture archive');
  const entry = archiveEntry(bytes);
  mkdirSync(join(dugiteRoot, 'script'), { recursive: true });
  writeFileSync(
    join(dugiteRoot, 'package.json'),
    JSON.stringify({ name: 'dugite', version: '3.2.2' })
  );
  writeFileSync(
    join(dugiteRoot, 'script', 'embedded-git.json'),
    JSON.stringify({ 'linux-x64': entry })
  );
  let fetches = 0;
  let extractions = 0;
  let verifications = 0;
  const verifyRuntime = async ({ gitRoot }) => {
    verifications += 1;
    const gitPath = join(gitRoot, 'bin', 'git');
    const gitSha256 = sha256(readFileSync(gitPath));
    return {
      gitPath,
      gitRelativePath: 'bin/git',
      gitSha256,
      gitVersion: 'git version 2.53.0',
      executionVerified: true,
      binaryDescription: 'fixture x64 binary',
    };
  };
  const options = {
    dugiteRoot,
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => {
      fetches += 1;
      return new Response(bytes, { status: 200 });
    },
    extractArchive: async (_archivePath, destination) => {
      extractions += 1;
      mkdirSync(join(destination, 'bin'), { recursive: true });
      writeFileSync(join(destination, 'bin', 'git'), 'fixture git binary');
    },
    verifyRuntime,
    sleep: async () => {},
    logger: quietLogger,
  };

  const installed = await ensureDugiteRuntime(options);
  assert.equal(installed.provisioned, true);
  assert.equal(installed.receipt.schema, 'dnaforge.dugite-runtime.v1');
  assert.equal(installed.receipt.dugiteVersion, '3.2.2');
  assert.equal(installed.receipt.archiveSha256, entry.checksum);
  assert.equal(fetches, 1);
  assert.equal(extractions, 1);

  const reused = await ensureDugiteRuntime({
    ...options,
    fetchImpl: async () => assert.fail('a verified runtime must not download again'),
    extractArchive: async () => assert.fail('a verified runtime must not extract again'),
  });
  assert.equal(reused.provisioned, false);
  assert.equal(fetches, 1);
  assert.equal(extractions, 1);
  assert.equal(verifications, 2);
});

test('runtime provisioning publishes no success receipt when extracted Git fails verification', async (t) => {
  const root = tempDirectory(t);
  const dugiteRoot = join(root, 'node_modules', 'dugite');
  const bytes = Buffer.from('fixture archive');
  const entry = archiveEntry(bytes);
  mkdirSync(join(dugiteRoot, 'script'), { recursive: true });
  writeFileSync(
    join(dugiteRoot, 'package.json'),
    JSON.stringify({ name: 'dugite', version: '3.2.2' })
  );
  writeFileSync(
    join(dugiteRoot, 'script', 'embedded-git.json'),
    JSON.stringify({ 'linux-x64': entry })
  );
  mkdirSync(join(dugiteRoot, 'git', 'bin'), { recursive: true });
  writeFileSync(join(dugiteRoot, 'git', 'bin', 'git'), 'previous verified runtime');

  await assert.rejects(
    ensureDugiteRuntime({
      dugiteRoot,
      cacheDir: join(root, 'cache'),
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async () => new Response(bytes, { status: 200 }),
      extractArchive: async (_archivePath, destination) => {
        mkdirSync(join(destination, 'bin'), { recursive: true });
        writeFileSync(join(destination, 'bin', 'git'), 'wrong architecture');
      },
      verifyRuntime: async () => {
        const error = new Error('expected x64, found arm64');
        error.code = 'DUGITE_GIT_ARCH';
        throw error;
      },
      sleep: async () => {},
      logger: quietLogger,
    }),
    (error) => error?.code === 'DUGITE_GIT_ARCH'
  );

  assert.equal(existsSync(join(dugiteRoot, 'git', '.dnaforge-runtime.json')), false);
  assert.equal(
    readFileSync(join(dugiteRoot, 'git', 'bin', 'git'), 'utf8'),
    'previous verified runtime'
  );
});

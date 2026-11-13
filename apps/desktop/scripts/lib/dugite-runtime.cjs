const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  constants: fsConstants,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} = require('node:fs');
const {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { describeNativeBinary } = require('./native-binary.cjs');

const RECEIPT_SCHEMA = 'dnaforge.dugite-runtime.v1';
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 90_000;
const DEFAULT_LOCK_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_STALE_LOCK_MS = 12 * 60_000;
const RECEIPT_FILE = '.dnaforge-runtime.json';

class DugiteRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'DugiteRuntimeError';
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

function normalizeArch(arch) {
  const aliases = {
    amd64: 'x64',
    x86_64: 'x64',
    aarch64: 'arm64',
    x86: 'ia32',
    i386: 'ia32',
    i686: 'ia32',
  };
  const normalized = String(arch ?? '')
    .trim()
    .toLowerCase();
  return aliases[normalized] ?? normalized;
}

function defaultCacheDir({ env = process.env, platform = process.platform } = {}) {
  if (env.DUGITE_CACHE_DIR?.trim()) return path.resolve(env.DUGITE_CACHE_DIR.trim());
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || os.tmpdir(), 'DNAForge', 'dugite-cache');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'DNAForge', 'dugite');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'dnaforge', 'dugite');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function validateManifestEntry(entry, targetKey) {
  if (!entry || typeof entry !== 'object') {
    throw new DugiteRuntimeError(
      'DUGITE_UNSUPPORTED_TARGET',
      `Dugite does not publish an embedded Git runtime for ${targetKey}.`
    );
  }
  const url = new URL(entry.url);
  if (url.protocol !== 'https:') {
    throw new DugiteRuntimeError(
      'DUGITE_MANIFEST_URL',
      `Dugite manifest URL for ${targetKey} must use HTTPS.`
    );
  }
  const name = String(entry.name || path.posix.basename(url.pathname));
  if (!name || name !== path.basename(name) || name.includes('..')) {
    throw new DugiteRuntimeError(
      'DUGITE_MANIFEST_NAME',
      `Dugite manifest archive name for ${targetKey} is unsafe.`
    );
  }
  const checksum = String(entry.checksum ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(checksum)) {
    throw new DugiteRuntimeError(
      'DUGITE_MANIFEST_CHECKSUM',
      `Dugite manifest checksum for ${targetKey} is not a SHA-256 digest.`
    );
  }
  return Object.freeze({ name, url: url.href, checksum });
}

function isTransientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function retryAfterMs(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return undefined;
  if (/^\d+$/u.test(value.trim())) return Math.min(Number(value.trim()) * 1000, 15_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), 15_000);
}

function retryDelayMs(attempt, requestedDelay, random = Math.random) {
  if (Number.isFinite(requestedDelay)) return Math.max(0, Math.min(requestedDelay, 15_000));
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);
  return base + Math.floor(random() * 251);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.part-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function withFileLock(
  lockPath,
  task,
  {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
    sleep = delay,
    logger = console,
  } = {}
) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + lockTimeoutMs;
  let handle;

  while (!handle) {
    let candidate;
    try {
      candidate = await open(lockPath, 'wx', 0o600);
      await candidate.writeFile(
        `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`
      );
      handle = candidate;
    } catch (error) {
      if (candidate) {
        await candidate.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (error?.code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleLockMs) {
        logger.warn(`[ensure-dugite-git] Removing stale provisioning lock: ${lockPath}`);
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new DugiteRuntimeError(
          'DUGITE_LOCK_TIMEOUT',
          `Timed out waiting for another Dugite provisioner: ${lockPath}`
        );
      }
      await sleep(250);
    }
  }

  try {
    return await task();
  } finally {
    await handle.close().catch(() => undefined);
    const contents = await readFile(lockPath, 'utf8').catch(() => '');
    if (contents.includes(token)) await rm(lockPath, { force: true });
  }
}

async function verifiedCacheHit(archivePath, checksum, logger) {
  if (!existsSync(archivePath)) return false;
  const actual = await sha256File(archivePath).catch(() => null);
  if (actual === checksum) return true;
  logger.warn(
    `[ensure-dugite-git] Discarding corrupt cached archive ${archivePath} ` +
      `(expected ${checksum}, received ${actual ?? 'unreadable'}).`
  );
  await rm(archivePath, { force: true });
  return false;
}

async function fetchArchiveAttempt({ entry, partPath, fetchImpl, attemptTimeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
  timer.unref?.();
  let response;
  try {
    try {
      response = await fetchImpl(entry.url, {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'DNAForge-Dugite-Provisioner',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (cause) {
      throw new DugiteRuntimeError(
        'DUGITE_DOWNLOAD_NETWORK',
        `Could not download ${entry.url}: ${cause?.message || cause}`,
        { cause, retryable: true }
      );
    }

    if (!response.ok) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new DugiteRuntimeError(
        'DUGITE_DOWNLOAD_HTTP',
        `Received HTTP ${response.status} while downloading ${entry.url}.`,
        {
          status: response.status,
          retryable: isTransientHttpStatus(response.status),
          retryAfterMs: retryAfterMs(response),
        }
      );
    }
    if (!response.body) {
      throw new DugiteRuntimeError(
        'DUGITE_DOWNLOAD_BODY',
        `Download response for ${entry.url} had no body.`,
        { retryable: true }
      );
    }

    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partPath, { flags: 'wx' }));
    } catch (cause) {
      throw new DugiteRuntimeError(
        'DUGITE_DOWNLOAD_STREAM',
        `Download stream failed for ${entry.url}: ${cause?.message || cause}`,
        { cause, retryable: true }
      );
    }

    const actual = await sha256File(partPath);
    if (actual !== entry.checksum) {
      throw new DugiteRuntimeError(
        'DUGITE_ARCHIVE_CHECKSUM',
        `Dugite archive checksum mismatch: expected ${entry.checksum}, received ${actual}.`,
        { retryable: false }
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function acquireVerifiedArchive({
  entry: rawEntry,
  cacheDir,
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  sleep = delay,
  random = Math.random,
  logger = console,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  const entry = validateManifestEntry(rawEntry, 'requested target');
  if (typeof fetchImpl !== 'function') {
    throw new DugiteRuntimeError(
      'DUGITE_FETCH_UNAVAILABLE',
      'This Node runtime has no fetch implementation.'
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new DugiteRuntimeError(
      'DUGITE_RETRY_POLICY',
      'Dugite maxAttempts must be between 1 and 10.'
    );
  }
  await mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, entry.name);
  if (await verifiedCacheHit(archivePath, entry.checksum, logger)) {
    return { archivePath, attempts: 0, cacheHit: true };
  }

  return withFileLock(
    `${archivePath}.lock`,
    async () => {
      if (await verifiedCacheHit(archivePath, entry.checksum, logger)) {
        return { archivePath, attempts: 0, cacheHit: true };
      }

      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const partPath = `${archivePath}.part-${process.pid}-${randomUUID()}`;
        try {
          logger.log(
            `[ensure-dugite-git] Downloading verified archive ` +
              `(attempt ${attempt}/${maxAttempts}): ${entry.url}`
          );
          await fetchArchiveAttempt({ entry, partPath, fetchImpl, attemptTimeoutMs });
          await rename(partPath, archivePath);
          return { archivePath, attempts: attempt, cacheHit: false };
        } catch (error) {
          lastError = error;
          await rm(partPath, { force: true }).catch(() => undefined);
          if (!error?.retryable || attempt === maxAttempts) throw error;
          const waitMs = retryDelayMs(attempt, error.retryAfterMs, random);
          logger.warn(
            `[ensure-dugite-git] Transient download failure (${error.code}); retrying in ${waitMs} ms.`
          );
          await sleep(waitMs);
        }
      }
      throw lastError;
    },
    { lockTimeoutMs, sleep, logger }
  );
}

function safeArchivePath(root, archiveName) {
  const normalized = String(archiveName ?? '').replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new DugiteRuntimeError(
      'DUGITE_ARCHIVE_PATH',
      `Dugite archive contains an unsafe path: ${archiveName}`
    );
  }
  const destination = path.resolve(root, ...normalized.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (destination !== path.resolve(root) && !destination.startsWith(prefix)) {
    throw new DugiteRuntimeError(
      'DUGITE_ARCHIVE_PATH',
      `Dugite archive path escapes the extraction root: ${archiveName}`
    );
  }
  return destination;
}

async function extractTarGz(archivePath, destination, { dugiteRoot } = {}) {
  let tarStream;
  try {
    const resolved = require.resolve('tar-stream', { paths: [dugiteRoot, __dirname] });
    tarStream = require(resolved);
  } catch (cause) {
    throw new DugiteRuntimeError(
      'DUGITE_EXTRACTOR_MISSING',
      "Dugite's tar-stream dependency is unavailable; reinstall dependencies.",
      { cause }
    );
  }

  await mkdir(destination, { recursive: true });
  const extractor = tarStream.extract();
  extractor.on('entry', (header, stream, next) => {
    (async () => {
      const outputPath = safeArchivePath(destination, header.name);
      switch (header.type) {
        case 'directory':
          await mkdir(outputPath, { recursive: true, mode: header.mode });
          stream.resume();
          break;
        case 'file':
          await mkdir(path.dirname(outputPath), { recursive: true });
          await pipeline(stream, createWriteStream(outputPath, { mode: header.mode ?? 0o644 }));
          if (header.mode !== undefined) await chmod(outputPath, header.mode);
          break;
        case 'symlink': {
          await mkdir(path.dirname(outputPath), { recursive: true });
          const linkName = String(header.linkname ?? '');
          const resolvedTarget = path.resolve(path.dirname(outputPath), linkName);
          const rootPrefix = `${path.resolve(destination)}${path.sep}`;
          if (
            !linkName ||
            path.posix.isAbsolute(linkName) ||
            path.win32.isAbsolute(linkName) ||
            (resolvedTarget !== path.resolve(destination) && !resolvedTarget.startsWith(rootPrefix))
          ) {
            throw new DugiteRuntimeError(
              'DUGITE_ARCHIVE_LINK',
              `Dugite archive contains an unsafe symlink: ${header.name} -> ${linkName}`
            );
          }
          await symlink(linkName, outputPath);
          stream.resume();
          break;
        }
        default:
          throw new DugiteRuntimeError(
            'DUGITE_ARCHIVE_ENTRY',
            `Dugite archive contains unsupported entry type ${header.type}: ${header.name}`
          );
      }
    })().then(next, (error) => extractor.destroy(error));
  });

  try {
    await pipeline(createReadStream(archivePath), createGunzip(), extractor);
  } catch (cause) {
    if (cause instanceof DugiteRuntimeError) throw cause;
    throw new DugiteRuntimeError(
      'DUGITE_ARCHIVE_EXTRACT',
      `Could not extract the verified Dugite archive: ${cause?.message || cause}`,
      { cause }
    );
  }
}

function findFileByName(root, name) {
  if (!existsSync(root)) return null;
  const entries = require('node:fs').readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return fullPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFileByName(path.join(root, entry.name), name);
    if (found) return found;
  }
  return null;
}

function findBundledGit(gitRoot, platform) {
  const candidates =
    platform === 'win32'
      ? [
          path.join(gitRoot, 'cmd', 'git.exe'),
          path.join(gitRoot, 'bin', 'git.exe'),
          path.join(gitRoot, 'mingw64', 'bin', 'git.exe'),
        ]
      : [path.join(gitRoot, 'bin', 'git')];
  return (
    candidates.find((candidate) => existsSync(candidate)) ||
    findFileByName(gitRoot, platform === 'win32' ? 'git.exe' : 'git')
  );
}

async function verifyBundledGit({
  gitRoot,
  platform,
  arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  execute = spawnSync,
} = {}) {
  const gitPath = findBundledGit(gitRoot, platform);
  if (!gitPath) {
    throw new DugiteRuntimeError(
      'DUGITE_GIT_MISSING',
      `Verified archive extraction produced no bundled Git under ${gitRoot}.`
    );
  }
  if (platform !== 'win32') {
    await access(gitPath, fsConstants.X_OK).catch((cause) => {
      throw new DugiteRuntimeError(
        'DUGITE_GIT_NOT_EXECUTABLE',
        `Bundled Git is not executable: ${gitPath}`,
        { cause }
      );
    });
  }
  let binaryDescription;
  try {
    binaryDescription = describeNativeBinary(gitPath, { platform, arch });
  } catch (cause) {
    throw new DugiteRuntimeError(
      'DUGITE_GIT_ARCH',
      `Bundled Git architecture verification failed for ${platform}/${arch}: ${cause.message}`,
      { cause }
    );
  }

  let gitVersion = null;
  let executionVerified = false;
  if (platform === hostPlatform && arch === normalizeArch(hostArch)) {
    const result = execute(gitPath, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    });
    if (result.error || result.signal || result.status !== 0) {
      throw new DugiteRuntimeError(
        'DUGITE_GIT_EXECUTION',
        `Bundled Git could not execute successfully: ${
          result.error?.message || result.signal || result.stderr || `exit ${result.status}`
        }`
      );
    }
    gitVersion = String(result.stdout ?? '').trim();
    if (!/^git version \d+\.\d+/u.test(gitVersion)) {
      throw new DugiteRuntimeError(
        'DUGITE_GIT_VERSION',
        `Bundled Git returned an invalid version response: ${gitVersion || '<empty>'}`
      );
    }
    executionVerified = true;
  }

  return {
    gitPath,
    gitRelativePath: path.relative(gitRoot, gitPath).split(path.sep).join('/'),
    gitSha256: await sha256File(gitPath),
    gitVersion,
    executionVerified,
    binaryDescription,
  };
}

function receiptMetadataMatches(receipt, expected) {
  return (
    receipt?.schema === RECEIPT_SCHEMA &&
    receipt?.dugiteVersion === expected.dugiteVersion &&
    receipt?.platform === expected.platform &&
    receipt?.arch === expected.arch &&
    receipt?.sourceUrl === expected.entry.url &&
    receipt?.archiveName === expected.entry.name &&
    receipt?.archiveSha256 === expected.entry.checksum
  );
}

async function reusableRuntime({ gitRoot, expected, verifyRuntime, logger }) {
  const receiptPath = path.join(gitRoot, RECEIPT_FILE);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch {
    return null;
  }
  if (!receiptMetadataMatches(receipt, expected)) return null;
  try {
    const verification = await verifyRuntime({
      gitRoot,
      platform: expected.platform,
      arch: expected.arch,
    });
    if (
      verification.gitRelativePath !== receipt.gitRelativePath ||
      verification.gitSha256 !== receipt.gitSha256 ||
      verification.gitVersion !== receipt.gitVersion ||
      verification.executionVerified !== receipt.executionVerified ||
      verification.binaryDescription !== receipt.binaryDescription
    ) {
      logger.warn(
        '[ensure-dugite-git] Existing runtime does not match its receipt; reprovisioning.'
      );
      return null;
    }
    return { receipt, verification };
  } catch (error) {
    logger.warn(
      `[ensure-dugite-git] Existing runtime verification failed (${error.code || error.message}); reprovisioning.`
    );
    return null;
  }
}

function loadDugiteMetadata(dugiteRoot, platform, arch) {
  const packagePath = path.join(dugiteRoot, 'package.json');
  const manifestPath = path.join(dugiteRoot, 'script', 'embedded-git.json');
  let packageJson;
  let manifest;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    throw new DugiteRuntimeError(
      'DUGITE_PACKAGE_MISSING',
      `Dugite package metadata is unavailable under ${dugiteRoot}; run pnpm install first.`,
      { cause }
    );
  }
  if (packageJson.name !== 'dugite' || typeof packageJson.version !== 'string') {
    throw new DugiteRuntimeError(
      'DUGITE_PACKAGE_INVALID',
      'Installed Dugite package metadata is invalid.'
    );
  }
  const targetKey = `${platform}-${arch}`;
  return {
    dugiteVersion: packageJson.version,
    entry: validateManifestEntry(manifest[targetKey], targetKey),
  };
}

function resolveDugiteRoot(repoRoot) {
  try {
    return path.dirname(require.resolve('dugite/package.json', { paths: [repoRoot] }));
  } catch (cause) {
    throw new DugiteRuntimeError(
      'DUGITE_PACKAGE_MISSING',
      `Dugite is not installed from ${repoRoot}; run pnpm install first.`,
      { cause }
    );
  }
}

async function ensureDugiteRuntime({
  repoRoot = path.resolve(__dirname, '..', '..', '..', '..'),
  dugiteRoot = resolveDugiteRoot(repoRoot),
  platform = process.platform,
  arch = process.arch,
  cacheDir,
  fetchImpl = globalThis.fetch,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  sleep = delay,
  random = Math.random,
  logger = console,
  extractArchive = extractTarGz,
  verifyRuntime = verifyBundledGit,
  verifyOnly = false,
} = {}) {
  const targetArch = normalizeArch(arch);
  const { dugiteVersion, entry } = loadDugiteMetadata(dugiteRoot, platform, targetArch);
  const expected = { dugiteVersion, platform, arch: targetArch, entry };
  const gitRoot = path.join(dugiteRoot, 'git');
  const existing = await reusableRuntime({ gitRoot, expected, verifyRuntime, logger });
  if (existing) {
    return {
      provisioned: false,
      cacheHit: true,
      receipt: existing.receipt,
      receiptPath: path.join(gitRoot, RECEIPT_FILE),
    };
  }
  if (verifyOnly) {
    throw new DugiteRuntimeError(
      'DUGITE_RUNTIME_UNVERIFIED',
      `No verified Dugite runtime is installed for ${platform}/${targetArch}.`
    );
  }

  const resolvedCacheDir = cacheDir || defaultCacheDir({ platform });
  const archive = await acquireVerifiedArchive({
    entry,
    cacheDir: resolvedCacheDir,
    fetchImpl,
    maxAttempts,
    attemptTimeoutMs,
    sleep,
    random,
    logger,
  });

  return withFileLock(
    path.join(dugiteRoot, '.dnaforge-runtime.lock'),
    async () => {
      const afterWait = await reusableRuntime({ gitRoot, expected, verifyRuntime, logger });
      if (afterWait) {
        return {
          provisioned: false,
          cacheHit: archive.cacheHit,
          receipt: afterWait.receipt,
          receiptPath: path.join(gitRoot, RECEIPT_FILE),
        };
      }

      const stage = await mkdtemp(path.join(dugiteRoot, '.dnaforge-git-stage-'));
      let stageMoved = false;
      try {
        await extractArchive(archive.archivePath, stage, { dugiteRoot });
        const verification = await verifyRuntime({
          gitRoot: stage,
          platform,
          arch: targetArch,
        });
        const receipt = {
          schema: RECEIPT_SCHEMA,
          dugiteVersion,
          platform,
          arch: targetArch,
          sourceUrl: entry.url,
          archiveName: entry.name,
          archiveSha256: entry.checksum,
          gitRelativePath: verification.gitRelativePath,
          gitSha256: verification.gitSha256,
          gitVersion: verification.gitVersion,
          executionVerified: verification.executionVerified,
          binaryDescription: verification.binaryDescription,
        };
        await atomicWriteJson(path.join(stage, RECEIPT_FILE), receipt);

        const backup = path.join(dugiteRoot, `.dnaforge-git-backup-${process.pid}-${randomUUID()}`);
        const hadExisting = existsSync(gitRoot);
        if (hadExisting) await rename(gitRoot, backup);
        try {
          await rename(stage, gitRoot);
          stageMoved = true;
        } catch (error) {
          if (hadExisting && existsSync(backup))
            await rename(backup, gitRoot).catch(() => undefined);
          throw error;
        }
        await rm(backup, { recursive: true, force: true });
        return {
          provisioned: true,
          cacheHit: archive.cacheHit,
          attempts: archive.attempts,
          receipt,
          receiptPath: path.join(gitRoot, RECEIPT_FILE),
        };
      } finally {
        if (!stageMoved) await rm(stage, { recursive: true, force: true });
      }
    },
    { sleep, logger }
  );
}

module.exports = {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DugiteRuntimeError,
  RECEIPT_SCHEMA,
  acquireVerifiedArchive,
  atomicWriteJson,
  defaultCacheDir,
  ensureDugiteRuntime,
  extractTarGz,
  findBundledGit,
  isTransientHttpStatus,
  normalizeArch,
  sha256File,
  verifyBundledGit,
};

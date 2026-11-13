import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { manifest } from '@waypoint/codex-app-server-contract';

const execFileAsync = promisify(execFile);

export type CodexAppServerResolveErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'NOT_VERIFIED'
  | 'NOT_EXECUTABLE'
  | 'NOT_A_FILE'
  | 'PATH_ESCAPE'
  | 'ASAR_PACKED'
  | 'DIGEST_MISMATCH'
  | 'PACKAGE_JSON_MISSING'
  | 'VERSION_MISMATCH';

export class CodexAppServerResolveError extends Error {
  constructor(
    readonly code: CodexAppServerResolveErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CodexAppServerResolveError';
  }
}

export interface ResolvedCodexAppServerBinary {
  path: string;
  version: string;
  versionOutput: string;
  triple: string;
  packageVersion: string;
  sha256: string;
}

export interface ResolveCodexAppServerOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  isPackaged?: boolean;
  searchRoots?: string[];
  resourcesPath?: string;
}

function targetKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function sha256FileAsync(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

function isPosixExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    const { mode } = statSync(filePath);
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function verifyNotAsar(filePath: string): void {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('app.asar') || normalized.endsWith('.asar')) {
    throw new CodexAppServerResolveError(
      'ASAR_PACKED',
      `Codex App Server binary cannot run from an ASAR archive: ${filePath}`
    );
  }
}

function verifyNoPathEscape(realBinary: string, realRoot: string): void {
  const withSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (!realBinary.startsWith(withSep) && realBinary !== realRoot) {
    throw new CodexAppServerResolveError(
      'PATH_ESCAPE',
      `Codex App Server binary resolves outside its packaged root: ${realBinary} not under ${realRoot}`
    );
  }
}

function resolveRootAndBinary(
  target: (typeof manifest)['supportedTargets'][string],
  options: ResolveCodexAppServerOptions
): { root: string; binary: string } {
  const binaryName = path.basename(target.codexBinaryPathInPackage);

  if (options.isPackaged) {
    const resourcesPath = options.resourcesPath;
    if (!resourcesPath) {
      throw new CodexAppServerResolveError(
        'UNSUPPORTED_PLATFORM',
        'Packaged App Server resolution requires a resourcesPath'
      );
    }
    const root = path.resolve(resourcesPath, 'binaries', 'codex-app-server');
    const binary = path.resolve(root, target.triple, 'bin', binaryName);
    return { root, binary };
  }

  const defaultSearchRoots = [process.cwd(), path.resolve(process.cwd(), '..', '..')];
  const searchRoots = options.searchRoots?.map((r) => path.resolve(r)) ?? defaultSearchRoots;

  for (const root of searchRoots) {
    const binary = path.resolve(
      root,
      'node_modules',
      target.aliasPackageName,
      target.codexBinaryPathInPackage
    );
    if (existsSync(binary)) {
      return { root: path.resolve(root, 'node_modules', target.aliasPackageName), binary };
    }
  }

  const first = searchRoots[0] ?? process.cwd();
  const root = path.resolve(first, 'node_modules', target.aliasPackageName);
  const binary = path.resolve(root, target.codexBinaryPathInPackage);
  return { root, binary };
}

function verifyPackageJson(
  binaryPath: string,
  target: (typeof manifest)['supportedTargets'][string]
): void {
  const packageJsonPath = path.resolve(path.dirname(binaryPath), '..', 'codex-package.json');
  if (!existsSync(packageJsonPath)) {
    throw new CodexAppServerResolveError(
      'PACKAGE_JSON_MISSING',
      `Codex App Server package metadata is missing: ${packageJsonPath}`
    );
  }
  const actual = sha256File(packageJsonPath);
  if (actual !== target.codexPackageJsonSha256) {
    throw new CodexAppServerResolveError(
      'DIGEST_MISMATCH',
      `Codex App Server package metadata digest mismatch: expected ${target.codexPackageJsonSha256}, got ${actual}`
    );
  }
}

async function verifyPackageJsonAsync(
  binaryPath: string,
  target: (typeof manifest)['supportedTargets'][string]
): Promise<void> {
  const packageJsonPath = path.resolve(path.dirname(binaryPath), '..', 'codex-package.json');
  if (!existsSync(packageJsonPath)) {
    throw new CodexAppServerResolveError(
      'PACKAGE_JSON_MISSING',
      `Codex App Server package metadata is missing: ${packageJsonPath}`
    );
  }
  const actual = await sha256FileAsync(packageJsonPath);
  if (actual !== target.codexPackageJsonSha256) {
    throw new CodexAppServerResolveError(
      'DIGEST_MISMATCH',
      `Codex App Server package metadata digest mismatch: expected ${target.codexPackageJsonSha256}, got ${actual}`
    );
  }
}

function verifyTargetResources(
  root: string,
  target: (typeof manifest)['supportedTargets'][string],
  options: ResolveCodexAppServerOptions
): string {
  const packagePrefix = `vendor/${target.triple}/`;
  let verifiedBinaryDigest: string | null = null;
  for (const resource of target.resources) {
    const relative = options.isPackaged
      ? resource.pathInPackage.slice(packagePrefix.length)
      : resource.pathInPackage;
    if (options.isPackaged && !resource.pathInPackage.startsWith(packagePrefix)) {
      throw new CodexAppServerResolveError(
        'PATH_ESCAPE',
        `Codex App Server resource is outside ${packagePrefix}: ${resource.pathInPackage}`
      );
    }
    const candidate = options.isPackaged
      ? path.resolve(root, target.triple, relative)
      : path.resolve(root, relative);
    if (!existsSync(candidate)) {
      throw new CodexAppServerResolveError(
        'NOT_A_FILE',
        `Codex App Server resource is missing: ${candidate}`
      );
    }
    const realResource = realpathSync(candidate);
    verifyNoPathEscape(realResource, realpathSync(root));
    if (!statSync(realResource).isFile()) {
      throw new CodexAppServerResolveError(
        'NOT_A_FILE',
        `Codex App Server resource is not a regular file: ${realResource}`
      );
    }
    if (resource.executable && options.platform !== 'win32' && !isPosixExecutable(realResource)) {
      throw new CodexAppServerResolveError(
        'NOT_EXECUTABLE',
        `Codex App Server resource is not executable: ${realResource}`
      );
    }
    const actual = sha256File(realResource);
    if (actual !== resource.sha256) {
      throw new CodexAppServerResolveError(
        'DIGEST_MISMATCH',
        `Codex App Server resource digest mismatch: expected ${resource.sha256}, got ${actual}`
      );
    }
    if (resource.pathInPackage === target.codexBinaryPathInPackage) {
      if (actual !== target.codexBinarySha256) {
        throw new CodexAppServerResolveError(
          'DIGEST_MISMATCH',
          `Codex App Server binary digest mismatch: expected ${target.codexBinarySha256}, got ${actual}`
        );
      }
      verifiedBinaryDigest = actual;
    }
  }
  if (verifiedBinaryDigest === null) {
    throw new CodexAppServerResolveError(
      'NOT_VERIFIED',
      `Codex App Server resource inventory does not include ${target.codexBinaryPathInPackage}`
    );
  }
  return verifiedBinaryDigest;
}

async function verifyTargetResourcesAsync(
  root: string,
  target: (typeof manifest)['supportedTargets'][string],
  options: ResolveCodexAppServerOptions
): Promise<string> {
  const packagePrefix = `vendor/${target.triple}/`;
  let verifiedBinaryDigest: string | null = null;
  for (const resource of target.resources) {
    const relative = options.isPackaged
      ? resource.pathInPackage.slice(packagePrefix.length)
      : resource.pathInPackage;
    if (options.isPackaged && !resource.pathInPackage.startsWith(packagePrefix)) {
      throw new CodexAppServerResolveError(
        'PATH_ESCAPE',
        `Codex App Server resource is outside ${packagePrefix}: ${resource.pathInPackage}`
      );
    }
    const candidate = options.isPackaged
      ? path.resolve(root, target.triple, relative)
      : path.resolve(root, relative);
    if (!existsSync(candidate)) {
      throw new CodexAppServerResolveError(
        'NOT_A_FILE',
        `Codex App Server resource is missing: ${candidate}`
      );
    }
    const realResource = realpathSync(candidate);
    verifyNoPathEscape(realResource, realpathSync(root));
    if (!statSync(realResource).isFile()) {
      throw new CodexAppServerResolveError(
        'NOT_A_FILE',
        `Codex App Server resource is not a regular file: ${realResource}`
      );
    }
    if (resource.executable && options.platform !== 'win32' && !isPosixExecutable(realResource)) {
      throw new CodexAppServerResolveError(
        'NOT_EXECUTABLE',
        `Codex App Server resource is not executable: ${realResource}`
      );
    }
    const actual = await sha256FileAsync(realResource);
    if (actual !== resource.sha256) {
      throw new CodexAppServerResolveError(
        'DIGEST_MISMATCH',
        `Codex App Server resource digest mismatch: expected ${resource.sha256}, got ${actual}`
      );
    }
    if (resource.pathInPackage === target.codexBinaryPathInPackage) {
      if (actual !== target.codexBinarySha256) {
        throw new CodexAppServerResolveError(
          'DIGEST_MISMATCH',
          `Codex App Server binary digest mismatch: expected ${target.codexBinarySha256}, got ${actual}`
        );
      }
      verifiedBinaryDigest = actual;
    }
  }
  if (verifiedBinaryDigest === null) {
    throw new CodexAppServerResolveError(
      'NOT_VERIFIED',
      `Codex App Server resource inventory does not include ${target.codexBinaryPathInPackage}`
    );
  }
  return verifiedBinaryDigest;
}

function verifyExecutable(binaryPath: string, platform: NodeJS.Platform): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(binaryPath);
  } catch (cause) {
    throw new CodexAppServerResolveError(
      'NOT_A_FILE',
      `Codex App Server binary is missing: ${binaryPath}`
    );
  }

  if (!stat.isFile()) {
    throw new CodexAppServerResolveError(
      'NOT_A_FILE',
      `Codex App Server path is not a regular file: ${binaryPath}`
    );
  }

  if (platform === 'win32') {
    if (!binaryPath.toLowerCase().endsWith('.exe')) {
      throw new CodexAppServerResolveError(
        'NOT_EXECUTABLE',
        `Codex App Server Windows binary must have .exe extension: ${binaryPath}`
      );
    }
  } else if (!isPosixExecutable(binaryPath)) {
    throw new CodexAppServerResolveError(
      'NOT_EXECUTABLE',
      `Codex App Server binary is not executable: ${binaryPath}`
    );
  }
}

export function resolveCodexAppServerBinary(
  options: ResolveCodexAppServerOptions = {}
): ResolvedCodexAppServerBinary {
  const platform = options.platform ?? (process.platform as NodeJS.Platform);
  const arch = options.arch ?? process.arch;
  const key = targetKey(platform, arch);
  const target = manifest.supportedTargets[key];

  if (target === undefined) {
    throw new CodexAppServerResolveError(
      'UNSUPPORTED_PLATFORM',
      `Codex App Server is not supported on ${key}`
    );
  }

  if (!target.verified) {
    throw new CodexAppServerResolveError(
      'NOT_VERIFIED',
      `Codex App Server is not verified for ${key} in this manifest`
    );
  }

  const { root, binary } = resolveRootAndBinary(target, options);

  if (!existsSync(binary)) {
    throw new CodexAppServerResolveError(
      'NOT_A_FILE',
      `Codex App Server binary is missing at ${binary}`
    );
  }

  const realRoot = realpathSync(root);
  const realBinary = realpathSync(binary);

  verifyNotAsar(realBinary);
  verifyNoPathEscape(realBinary, realRoot);
  verifyExecutable(realBinary, platform);
  verifyPackageJson(realBinary, target);
  const sha256 = verifyTargetResources(root, target, { ...options, platform });

  return {
    path: realBinary,
    version: manifest.codexAppServerVersion,
    versionOutput: manifest.binaryVersionOutput,
    triple: target.triple,
    packageVersion: target.npmPackageVersion,
    sha256,
  };
}

export async function resolveCodexAppServerBinaryAsync(
  options: ResolveCodexAppServerOptions = {}
): Promise<ResolvedCodexAppServerBinary> {
  const platform = options.platform ?? (process.platform as NodeJS.Platform);
  const arch = options.arch ?? process.arch;
  const key = targetKey(platform, arch);
  const target = manifest.supportedTargets[key];
  if (target === undefined) {
    throw new CodexAppServerResolveError(
      'UNSUPPORTED_PLATFORM',
      `Codex App Server is not supported on ${key}`
    );
  }
  if (!target.verified) {
    throw new CodexAppServerResolveError(
      'NOT_VERIFIED',
      `Codex App Server is not verified for ${key} in this manifest`
    );
  }
  const { root, binary } = resolveRootAndBinary(target, options);
  if (!existsSync(binary)) {
    throw new CodexAppServerResolveError(
      'NOT_A_FILE',
      `Codex App Server binary is missing at ${binary}`
    );
  }
  const realRoot = realpathSync(root);
  const realBinary = realpathSync(binary);
  verifyNotAsar(realBinary);
  verifyNoPathEscape(realBinary, realRoot);
  verifyExecutable(realBinary, platform);
  await verifyPackageJsonAsync(realBinary, target);
  const sha256 = await verifyTargetResourcesAsync(root, target, { ...options, platform });
  return {
    path: realBinary,
    version: manifest.codexAppServerVersion,
    versionOutput: manifest.binaryVersionOutput,
    triple: target.triple,
    packageVersion: target.npmPackageVersion,
    sha256,
  };
}

const WINDOWS_VERSION_ENV_KEYS = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'COMSPEC',
  'PATHEXT',
] as const;

export function buildCodexAppServerVersionCheckEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform as NodeJS.Platform
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { PATH: '' };
  if (platform !== 'win32') return childEnv;

  const hostEntries = Object.entries(hostEnv);
  for (const name of WINDOWS_VERSION_ENV_KEYS) {
    const match = hostEntries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (typeof match?.[1] === 'string' && match[1].length > 0) {
      childEnv[name] = match[1];
    }
  }
  return childEnv;
}

export async function verifyCodexAppServerVersion(
  binary: ResolvedCodexAppServerBinary,
  timeoutMs = 10_000
): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync(binary.path, ['--version'], {
      timeout: timeoutMs,
      env: buildCodexAppServerVersionCheckEnv(),
    });
    stdout = result.stdout;
  } catch (cause) {
    throw new CodexAppServerResolveError(
      'VERSION_MISMATCH',
      `Codex App Server version check failed to run: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  const trimmed = stdout.trim();
  if (trimmed !== binary.versionOutput) {
    throw new CodexAppServerResolveError(
      'VERSION_MISMATCH',
      `Codex App Server version mismatch: expected ${binary.versionOutput}, got ${trimmed}`
    );
  }
}

import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

import { assertWorkspaceShape } from '../../db/scan-workspace-shape';
import type {
  CreateSampleWorkspaceInstanceRequest,
  SampleWorkspaceInstanceResult,
  SampleWorkspaceManifest,
} from '../../shared/sample-workspace-ipc';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { SAMPLE_WORKSPACE_TEMPLATE_IDS } from '../../shared/sample-workspace-ipc';

const SAMPLE_WORKSPACE_MARKER = '.dnaforge-sample-workspace.json';
const SAMPLE_WORKSPACE_DIR = 'Sample Workspaces';

interface SampleWorkspaceFactoryPaths {
  userDataPath: string;
  resourcesRootPath: string;
}

interface SampleWorkspaceMarker {
  templateId: string;
  version: string;
  createdAt: number;
  manifest: SampleWorkspaceManifest;
}

const inFlight = new Map<string, Promise<SampleWorkspaceInstanceResult>>();
const importSources = new Map<string, string>();

export async function resolveAppCreatedSampleWorkspaceSource(
  path: string
): Promise<{ rootPath: string; displayName: string } | null> {
  const canonical = await realpath(path).catch(() => null);
  const displayName = canonical === null ? undefined : importSources.get(canonical);
  return canonical !== null && displayName !== undefined
    ? { rootPath: canonical, displayName }
    : null;
}

export function resolveSampleWorkspaceResourceRoot(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.isPackaged) {
    return join(input.resourcesPath, 'sample-workspaces');
  }
  const candidates = [
    join(input.appPath, 'resources/sample-workspaces'),
    resolve(input.appPath, '../../resources/sample-workspaces'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function createSampleWorkspaceInstanceWithLock(
  request: CreateSampleWorkspaceInstanceRequest,
  paths: SampleWorkspaceFactoryPaths
): Promise<SampleWorkspaceInstanceResult> {
  const mode = request.mode ?? 'reuse';
  const key = `${request.templateId}:${mode}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = createSampleWorkspaceInstance(request, paths)
    .then(async (instance) => {
      importSources.set(await realpath(instance.rootPath), instance.displayName);
      return instance;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export async function createSampleWorkspaceInstance(
  request: CreateSampleWorkspaceInstanceRequest,
  paths: SampleWorkspaceFactoryPaths
): Promise<SampleWorkspaceInstanceResult> {
  assertKnownTemplateId(request.templateId);

  const templateRoot = join(paths.resourcesRootPath, request.templateId);
  const resourcesRootReal = await realpath(paths.resourcesRootPath).catch(() => {
    throw new Error(`Sample workspace resources not found at ${paths.resourcesRootPath}`);
  });
  const templateRootReal = await realpath(templateRoot).catch(() => {
    throw new Error(
      `Sample workspace template "${request.templateId}" was not found at ${templateRoot}`
    );
  });
  assertDescendant(templateRootReal, resourcesRootReal);

  const manifest = await readManifest(join(templateRoot, 'manifest.json'));
  if (manifest.templateId !== request.templateId) {
    throw new Error(
      `Sample workspace manifest id mismatch: expected ${request.templateId}, got ${manifest.templateId}`
    );
  }
  assertSafeVersion(manifest.version);
  validateManifestAssets(manifest);

  const sourceWorkspacePath = join(templateRoot, 'workspace');
  await assertDirectory(sourceWorkspacePath, `Sample workspace payload missing`);

  const destinationBase = destinationBaseFor(paths.userDataPath, manifest, request.mode ?? 'reuse');
  assertDescendant(resolve(destinationBase), resolve(paths.userDataPath));

  if ((request.mode ?? 'reuse') === 'reuse') {
    const existing = await existingInstance(destinationBase, manifest);
    if (existing) return existing;
    await rm(destinationBase, { recursive: true, force: true });
  }

  const destinationParent = dirname(destinationBase);
  await mkdir(destinationParent, { recursive: true });

  const tempDir = join(
    destinationParent,
    `.tmp-${basename(destinationBase)}-${process.pid}-${Date.now()}`
  );
  await rm(tempDir, { recursive: true, force: true });

  try {
    await mkdir(tempDir, { recursive: true });
    await copyDirectoryNoSymlinks(
      sourceWorkspacePath,
      join(tempDir, 'workspace'),
      templateRootReal
    );
    assertWorkspaceShape(join(tempDir, 'workspace'), 'Sample workspace template');

    const marker: SampleWorkspaceMarker = {
      templateId: manifest.templateId,
      version: manifest.version,
      createdAt: Date.now(),
      manifest,
    };
    await writeFile(join(tempDir, SAMPLE_WORKSPACE_MARKER), JSON.stringify(marker, null, 2));

    try {
      await rename(tempDir, destinationBase);
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === 'EEXIST' &&
        (request.mode ?? 'reuse') === 'reuse'
      ) {
        await rm(tempDir, { recursive: true, force: true });
        const raced = await existingInstance(destinationBase, manifest);
        if (raced) return raced;
      }
      throw err;
    }

    const created = await existingInstance(destinationBase, manifest);
    if (!created) {
      throw new Error(`Sample workspace copy did not produce a valid marker at ${destinationBase}`);
    }
    return created;
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export function __resetSampleWorkspaceInflightForTests(): void {
  inFlight.clear();
  importSources.clear();
}

async function existingInstance(
  destinationBase: string,
  manifest: SampleWorkspaceManifest
): Promise<SampleWorkspaceInstanceResult | null> {
  const markerPath = join(destinationBase, SAMPLE_WORKSPACE_MARKER);
  const rootPath = join(destinationBase, 'workspace');
  try {
    const [markerRaw] = await Promise.all([
      readFile(markerPath, 'utf8'),
      assertDirectory(rootPath, `Sample workspace payload missing`),
    ]);
    const marker = JSON.parse(markerRaw) as SampleWorkspaceMarker;
    if (marker.templateId !== manifest.templateId || marker.version !== manifest.version) {
      return null;
    }
    return {
      id: `sample:${manifest.templateId}:${manifest.version}`,
      templateId: manifest.templateId,
      version: manifest.version,
      displayName: manifest.displayName,
      rootPath,
      markerPath,
      manifest,
      writable: true,
      createdAt: marker.createdAt,
    };
  } catch {
    return null;
  }
}

function destinationBaseFor(
  userDataPath: string,
  manifest: SampleWorkspaceManifest,
  mode: 'reuse' | 'fresh'
): string {
  const base = join(userDataPath, SAMPLE_WORKSPACE_DIR, manifest.templateId);
  if (mode === 'reuse') {
    return join(base, manifest.version);
  }
  return join(base, `${manifest.version}-fresh-${Date.now()}`);
}

async function readManifest(manifestPath: string): Promise<SampleWorkspaceManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as SampleWorkspaceManifest;
  if (
    !parsed ||
    typeof parsed.templateId !== 'string' ||
    typeof parsed.version !== 'string' ||
    typeof parsed.displayName !== 'string' ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error(`Invalid sample workspace manifest: ${manifestPath}`);
  }
  return parsed;
}

function validateManifestAssets(manifest: SampleWorkspaceManifest): void {
  for (const asset of manifest.assets) {
    if (
      !asset ||
      typeof asset.id !== 'string' ||
      typeof asset.label !== 'string' ||
      typeof asset.path !== 'string'
    ) {
      throw new Error(`Invalid sample workspace asset in ${manifest.templateId}`);
    }
    validateRelativePath(asset.path);
  }
}

function validateRelativePath(path: string): void {
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Sample workspace asset path must be relative: ${path}`);
  }
  if (path.includes('\\')) {
    throw new Error(`Sample workspace asset path must use forward slashes: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Sample workspace asset path cannot traverse directories: ${path}`);
  }
}

async function copyDirectoryNoSymlinks(
  sourceDir: string,
  destinationDir: string,
  templateRootReal: string
): Promise<void> {
  const files: { sourcePath: string; destinationPath: string }[] = [];

  async function collectDirectory(source: string, destination: string): Promise<void> {
    const sourceReal = await realpath(source);
    assertDescendant(sourceReal, templateRootReal);
    await mkdir(destination, { recursive: true });

    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const entryStat = await lstat(sourcePath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Sample workspace template cannot contain symlinks: ${sourcePath}`);
      }
      if (entry.isDirectory()) {
        await collectDirectory(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        files.push({ sourcePath, destinationPath });
      } else {
        throw new Error(`Unsupported sample workspace template entry: ${sourcePath}`);
      }
    }
  }

  await collectDirectory(sourceDir, destinationDir);
  let nextFile = 0;
  let failed = false;
  let failure: unknown;
  async function copyNextFile(): Promise<void> {
    while (!failed) {
      const file = files[nextFile++];
      if (!file) return;
      try {
        await copyFile(file.sourcePath, file.destinationPath);
      } catch (error) {
        if (!failed) {
          failure = error;
          failed = true;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, files.length) }, copyNextFile));
  if (failed) throw failure;
}

async function assertDirectory(path: string, message: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (!s?.isDirectory()) {
    throw new Error(`${message}: ${path}`);
  }
}

function assertKnownTemplateId(templateId: string): void {
  if (
    !SAMPLE_WORKSPACE_TEMPLATE_IDS.includes(
      templateId as (typeof SAMPLE_WORKSPACE_TEMPLATE_IDS)[number]
    )
  ) {
    throw new Error(`Unknown sample workspace template: ${templateId}`);
  }
}

function assertSafeVersion(version: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error(`Invalid sample workspace version: ${version}`);
  }
}

function assertDescendant(child: string, parent: string): void {
  const childResolved = resolve(child);
  const parentResolved = resolve(parent);
  if (!isPathInsideBoundary(childResolved, parentResolved)) {
    throw new Error(`Path escapes allowed root: ${childResolved}`);
  }
}

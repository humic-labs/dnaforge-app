import {
  beginProjectLifecycle,
  bindProjectLifecycle,
  releaseProjectLifecycle,
} from './workspace-telemetry';
import { platform } from '../../platform';
import { isDesktopRuntime } from '../../utils/environment';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { OpenWorkspaceOptions, WorkspaceInstance, WorkspaceSource } from './types';
import { isManagedWorkspacesEnabled } from './managed-workspaces-flag';
import { reportUnconvertedSequenceFiles } from './unconverted-sequence-notice';
import { createTrackedEmptyWorkspace } from './workspace-created-telemetry';
import {
  soleReadableProjectRoot,
  soleWritableProjectRoot,
} from '../../shared/project-root-selection';
import { normalizePathForBoundary, pathIsAtOrUnder } from '../../shared/path-boundary';
import { recordSampleRegistrationBreadcrumb } from '../../lib/renderer-breadcrumbs';

export interface OpenWorkspaceContext {
  openFile?: (request: {
    filePath: string;
    label: string;
    signal?: AbortSignal;
  }) => Promise<unknown> | unknown;
  onWorkspaceCommitted?: (input: {
    instance: WorkspaceInstance;
    options: OpenWorkspaceOptions;
  }) => Promise<void> | void;
}

export interface OpenWorkspaceResult {
  instance: WorkspaceInstance;
  openedAssetPath?: string;
  assetOpenError?: string;
  superseded?: boolean;
}

let nextOpenRequest = 0;
let latestForegroundRequest = 0;
let latestCommittedReplace = 0;
let foregroundPresentation: AbortController | undefined;

export async function openWorkspaceFromSource(
  source: WorkspaceSource,
  options: OpenWorkspaceOptions = {},
  context: OpenWorkspaceContext = {}
): Promise<OpenWorkspaceResult> {
  const request = ++nextOpenRequest;
  const lifecycle = beginProjectLifecycle({
    source:
      source.kind === 'empty'
        ? 'empty'
        : source.kind === 'sample-template'
          ? 'sample'
          : source.kind === 'local-folder'
            ? options.inPlace || !isManagedWorkspacesEnabled()
              ? 'local'
              : 'managed_import'
            : 'unknown',
    mode: options.replaceCurrent ? 'replace' : 'add',
    intent: options.telemetrySource ?? 'unknown',
  });
  const before = useWorkspaceStore.getState();
  const originalRoots = new Map(
    before.folders.map((root) => [normalizePathForBoundary(root.path), root])
  );
  const background = options.telemetrySource === 'automatic_sample';
  const presentation = new AbortController();
  if (!background) {
    foregroundPresentation?.abort();
    foregroundPresentation = presentation;
    latestForegroundRequest = request;
  }
  let publishingSelection = false;
  let materializedRoots = new Set<string>();
  const removedRoots = new Set<string>();
  const collapsedRoots = new Set<string>();
  let selectionChanged = false;
  const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
    if (
      !publishingSelection &&
      (state.selectedPath !== previous.selectedPath ||
        state.revealRequestId !== previous.revealRequestId)
    ) {
      selectionChanged = true;
      presentation.abort();
    }
    if (state.expandedPaths !== previous.expandedPaths) {
      for (const path of previous.expandedPaths) {
        if (state.expandedPaths.has(path)) continue;
        const key = normalizePathForBoundary(path);
        collapsedRoots.add(key);
        if (materializedRoots.has(key)) {
          selectionChanged = true;
          presentation.abort();
        }
      }
    }
    if (state.folders !== previous.folders) {
      const currentRoots = new Set(
        state.folders.map((root) => normalizePathForBoundary(root.path))
      );
      for (const root of previous.folders) {
        const key = normalizePathForBoundary(root.path);
        if (!currentRoots.has(key)) {
          removedRoots.add(key);
          if (materializedRoots.has(key)) presentation.abort();
        }
      }
    }
  });
  const ownsPresentation = () =>
    !background &&
    request === latestForegroundRequest &&
    !selectionChanged &&
    !presentation.signal.aborted;

  try {
    lifecycle.stage('materialization');
    const instance = await materializeWorkspaceSource(source, {
      onMinted: () => lifecycle.phase('minted'),
      importId: options.importId,
      inPlace: options.inPlace,
      sampleRegistrationId: source.kind === 'sample-template' ? lifecycle.operationId : undefined,
    });

    materializedRoots = new Set(
      instance.rootFolders.map((root) => normalizePathForBoundary(root.path))
    );
    lifecycle.authority(
      instance.rootFolders.every((root) => root.pinned)
        ? 'reference'
        : instance.rootFolders.some((root) => root.pinned)
          ? 'mixed'
          : 'writable'
    );
    if (options.addToRecents !== false) {
      lifecycle.stage('registration');
      await persistRecentRoots(
        instance.rootFolders,
        source.kind === 'sample-template' ? lifecycle.operationId : undefined
      );
      lifecycle.phase('registered');
    }

    if (
      request < latestCommittedReplace ||
      instance.rootFolders.some((root) => removedRoots.has(normalizePathForBoundary(root.path)))
    ) {
      lifecycle.phase('superseded');
      return { instance, superseded: true };
    }

    lifecycle.stage('mount');
    const current = useWorkspaceStore.getState();
    if (
      instance.rootFolders.some((root) =>
        current.folders.some(
          (folder) =>
            normalizePathForBoundary(folder.path) === normalizePathForBoundary(root.path) &&
            (folder.mountRequest ?? 0) > request
        )
      )
    ) {
      lifecycle.phase('superseded');
      return { instance, superseded: true };
    }
    const base = options.replaceCurrent
      ? current.folders.filter((root) => {
          const key = normalizePathForBoundary(root.path);
          const original = originalRoots.get(key);
          return (
            root.pinned ||
            !original ||
            root.mountRequest !== original.mountRequest ||
            removedRoots.has(key)
          );
        })
      : current.folders;
    const projectionInstance = {
      ...instance,
      rootFolders: instance.rootFolders.map((root) => {
        const key = normalizePathForBoundary(root.path);
        const original = originalRoots.get(key);
        const latest = current.folders.find(
          (folder) => normalizePathForBoundary(folder.path) === key
        );
        return original && latest && original.name !== latest.name
          ? { ...root, name: latest.name }
          : root;
      }),
    };
    const openedRoots = new Set(
      instance.rootFolders.map((root) => normalizePathForBoundary(root.path))
    );
    const projectedFolders = projectWorkspaceFolders(base, projectionInstance, false).map((root) =>
      openedRoots.has(normalizePathForBoundary(root.path))
        ? { ...root, mountRequest: request }
        : root
    );
    const retainedRoots = new Set(
      projectedFolders.map((root) => normalizePathForBoundary(root.path))
    );
    const expandedPaths = new Set(
      [...current.expandedPaths].filter((path) =>
        projectedFolders.some((root) => pathIsAtOrUnder(path, root.path))
      )
    );
    for (const root of instance.rootFolders) {
      if (!collapsedRoots.has(normalizePathForBoundary(root.path))) expandedPaths.add(root.path);
    }
    if (options.replaceCurrent) latestCommittedReplace = Math.max(latestCommittedReplace, request);
    for (const root of current.folders) {
      if (!retainedRoots.has(normalizePathForBoundary(root.path)))
        releaseProjectLifecycle(root.path);
    }
    for (const root of instance.rootFolders) bindProjectLifecycle(root.path, lifecycle);
    useWorkspaceStore.getState().commitMountedFolders({
      folders: projectedFolders,
      expandedPaths,
      activeWorkspaceFile: ownsPresentation()
        ? (instance.workspaceFilePath ?? current.activeWorkspaceFile)
        : current.activeWorkspaceFile,
    });

    lifecycle.phase('mounted');
    lifecycle.stage('selection');
    const preferredPath =
      ownsPresentation() &&
      (options.replaceCurrent ||
        options.makeCurrent ||
        !useWorkspaceStore.getState().workspaceSelection.path)
        ? ((options.makeCurrent
            ? soleWritableProjectRoot(instance.rootFolders)?.path
            : undefined) ??
          selectDefaultWorkspacePath(projectedFolders) ??
          undefined)
        : undefined;
    await useWorkspaceStore.getState().acceptMountedWorkspaceSelection(preferredPath);

    await context.onWorkspaceCommitted?.({ instance, options });
    const primaryRoot = soleReadableProjectRoot(instance.rootFolders)?.path;
    if (
      !primaryRoot ||
      !ownsPresentation() ||
      !retainedRoots.has(normalizePathForBoundary(primaryRoot))
    ) {
      lifecycle.phase('presentation_superseded');
      return { instance };
    }
    if (
      !useWorkspaceStore
        .getState()
        .folders.some(
          (root) => normalizePathForBoundary(root.path) === normalizePathForBoundary(primaryRoot)
        )
    )
      return { instance };

    lifecycle.stage('asset');
    const assetToReveal = options.revealAsset ?? options.openAsset;
    if (!assetToReveal) {
      useWorkspaceStore.getState().revealPath(primaryRoot);
      return { instance };
    }
    const revealPath = resolveWorkspaceAssetPath(primaryRoot, assetToReveal);
    const openPath = options.openAsset
      ? resolveWorkspaceAssetPath(primaryRoot, options.openAsset)
      : null;
    publishingSelection = true;
    try {
      useWorkspaceStore.getState().revealPath(revealPath);
    } finally {
      publishingSelection = false;
    }
    if (openPath && context.openFile) {
      try {
        await context.openFile({
          filePath: openPath,
          label: options.openAssetLabel ?? basenameForPath(openPath),
          signal: presentation.signal,
        });
        if (presentation.signal.aborted) {
          lifecycle.phase('presentation_superseded');
          return { instance };
        }
      } catch (error) {
        if (presentation.signal.aborted) {
          lifecycle.phase('presentation_superseded');
          return { instance };
        }
        lifecycle.phase('asset_failed');
        if (!options.allowOpenAssetFailure) throw error;
        return { instance, assetOpenError: error instanceof Error ? error.message : String(error) };
      }
    }
    return { instance, openedAssetPath: openPath ?? undefined };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    const refused =
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'PERMISSION_DENIED' ||
      (error instanceof Error && ['NotAllowedError', 'SecurityError'].includes(error.name)) ||
      ['workspace-file', 'git-clone', 'community-workspace'].includes(source.kind);
    lifecycle.phase(
      error instanceof Error && error.name === 'AbortError'
        ? 'cancelled'
        : refused
          ? 'refused'
          : 'failed'
    );
    throw error;
  } finally {
    unsubscribe();
    if (foregroundPresentation === presentation) foregroundPresentation = undefined;
  }
}

export interface MaterializeWorkspaceOptions {
  onMinted?: () => void;
  importId?: string;
  inPlace?: boolean;
  sampleRegistrationId?: string;
}

export async function materializeWorkspaceSource(
  source: WorkspaceSource,
  options: MaterializeWorkspaceOptions = {}
): Promise<WorkspaceInstance> {
  const { importId, inPlace } = options;
  switch (source.kind) {
    case 'local-folder': {
      const requestedPath = stripTrailingSlash(source.path);
      let path = requestedPath;
      if (isDesktopRuntime()) {
        const stat = await platform().fs.stat(requestedPath);
        if (!stat.isDirectory) throw new Error('Project root must be a directory');
        path = stripTrailingSlash(stat.canonicalPath);
      }
      let displayName = source.name?.trim() || basenameForPath(path);
      if (isManagedWorkspacesEnabled() && !inPlace) {
        const managed = await platform().workspace.importManaged({
          sourcePath: path,
          importId,
          ...(source.name ? { displayName } : {}),
        });
        reportUnconvertedSequenceFiles(managed.unconvertedSequenceFiles);
        return {
          id: `managed:${managed.workspaceUuid}`,
          displayName: managed.displayName,
          rootFolders: [
            {
              path: managed.repoPath,
              name: managed.displayName,
              ...(source.pinned ? { pinned: true } : {}),
            },
          ],
          source,
          writable: !source.pinned,
          createdAt: managed.createdAt,
        };
      }
      const fs = platform().fs;
      const rootPath =
        typeof fs?.canonicalPath === 'function'
          ? stripTrailingSlash(await fs.canonicalPath(path))
          : path;
      let pinned = source.pinned;
      path = rootPath;
      if (isDesktopRuntime()) {
        const project = await platform().workspace.resolveProjectRoot({
          path,
          ...(source.name ? { name: source.name.trim() } : {}),
          ...(source.pinned ? { access: 'reference' as const } : {}),
        });
        path = project.rootPath;
        displayName = project.displayName;
        pinned = project.access === 'reference';
      }
      return {
        id: `local-folder:${path}`,
        displayName,
        rootFolders: [{ path, name: displayName, ...(pinned ? { pinned: true } : {}) }],
        source,
        writable: !pinned,
        createdAt: Date.now(),
      };
    }
    case 'empty': {
      const created = await createTrackedEmptyWorkspace({ name: source.name });
      options.onMinted?.();
      return {
        id: `empty:${created.rootPath}`,
        displayName: created.displayName,
        rootFolders: [{ path: created.rootPath, name: created.displayName }],
        source,
        writable: true,
        createdAt: created.createdAt,
      };
    }
    case 'sample-template': {
      const sample = await observeSampleRegistration(
        'createSampleInstance',
        options.sampleRegistrationId,
        () =>
          platform().workspace.createSampleInstance({
            templateId: source.templateId,
            mode: source.mode ?? 'reuse',
          })
      );
      if (isManagedWorkspacesEnabled()) {
        const managed = await observeSampleRegistration(
          'importManaged',
          options.sampleRegistrationId,
          () =>
            platform().workspace.importManaged({
              sourcePath: sample.rootPath,
              displayName: sample.displayName,
              importId,
            })
        );
        return {
          id: `managed:${managed.workspaceUuid}`,
          displayName: sample.displayName,
          rootFolders: [{ path: managed.repoPath, name: sample.displayName }],
          source,
          writable: true,
          createdAt: managed.createdAt,
        };
      }
      return {
        id: sample.id,
        displayName: sample.displayName,
        rootFolders: [{ path: sample.rootPath, name: sample.displayName }],
        source,
        writable: sample.writable,
        createdAt: sample.createdAt,
      };
    }
    case 'workspace-file':
      throw new Error('Saved project-file sources are not implemented yet.');
    case 'git-clone':
      throw new Error('Git clone project sources are not implemented yet.');
    case 'community-workspace':
      throw new Error('Community project sources are not implemented yet.');
    default:
      assertNever(source);
  }
}

export function projectWorkspaceFolders(
  existingFolders: WorkspaceFolder[],
  instance: WorkspaceInstance,
  replaceCurrent: boolean,
  now = Date.now()
): WorkspaceFolder[] {
  const pinned = existingFolders.filter((folder) => folder.pinned);
  const base = replaceCurrent ? pinned : [...existingFolders];
  const folders = [...base];

  for (const root of instance.rootFolders) {
    const normalizedRoot = normalizePathForBoundary(root.path);
    const existingIndex = folders.findIndex(
      (folder) => normalizePathForBoundary(folder.path) === normalizedRoot
    );
    const rootName = root.name.trim() || basenameForPath(root.path);
    if (existingIndex >= 0) {
      const existing = folders[existingIndex];
      if (existing.name !== rootName || (root.pinned && !existing.pinned)) {
        folders[existingIndex] = {
          ...existing,
          name: rootName,
          ...(root.pinned ? { pinned: true } : {}),
        };
      }
      continue;
    }
    folders.push({
      path: root.path,
      name: rootName,
      addedAt: now,
      ...(root.pinned ? { pinned: true } : {}),
    });
  }

  return folders;
}

export function selectDefaultWorkspacePath(folders: WorkspaceFolder[]): string | null {
  return soleWritableProjectRoot(folders)?.path ?? null;
}

export function resolveWorkspaceAssetPath(rootPath: string, openAsset: string): string {
  const safeAsset = validateWorkspaceRelativePath(openAsset);
  return `${stripTrailingSlash(rootPath)}/${safeAsset}`;
}

export function validateWorkspaceRelativePath(openAsset: string): string {
  const trimmed = openAsset.trim();
  if (!trimmed) {
    throw new Error('Project asset path is required.');
  }
  if (trimmed.includes('\0')) {
    throw new Error('Project asset path cannot contain null bytes.');
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`Project asset path must be relative: ${openAsset}`);
  }
  if (trimmed.includes('\\')) {
    throw new Error(`Project asset path must use forward slashes: ${openAsset}`);
  }

  const segments = trimmed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Project asset path cannot traverse directories: ${openAsset}`);
  }
  return segments.join('/');
}

export function basenameForPath(path: string): string {
  const normalized = stripTrailingSlash(path);
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
}

async function persistRecentRoots(
  roots: WorkspaceInstance['rootFolders'],
  sampleRegistrationId: string | undefined
): Promise<void> {
  for (const root of roots) {
    await observeSampleRegistration('ensureWorkspaceOwner', sampleRegistrationId, () =>
      platform().db.ensureWorkspaceOwner(root.path, root.pinned ? 'reference' : undefined, {
        name: root.name || basenameForPath(root.path),
        recordOpen: true,
      })
    );
  }
}

async function observeSampleRegistration<T>(
  method: 'createSampleInstance' | 'importManaged' | 'ensureWorkspaceOwner',
  correlation: string | undefined,
  request: () => Promise<T>
): Promise<T> {
  if (!correlation || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(correlation))
    return request();
  let startedAt: number;
  try {
    startedAt = performance.now();
  } catch {
    return request();
  }
  const record = (phase: 'start' | 'completed' | 'error'): void => {
    try {
      recordSampleRegistrationBreadcrumb({
        method,
        correlation,
        phase,
        duration_ms: performance.now() - startedAt,
      });
    } catch {}
  };
  record('start');
  try {
    const result = await request();
    record('completed');
    return result;
  } catch (error) {
    record('error');
    throw error;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported project source: ${JSON.stringify(value)}`);
}

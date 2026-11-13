import type {
  ProjectLifecyclePhase,
  ProjectLifecycleSource,
  ProjectLifecycleStage,
  ProjectOpenMode,
  ProjectAuthority,
} from '../../shared/project-lifecycle-telemetry';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import type { OpenWorkspaceOptions, WorkspaceInstance } from './types';
import { trackRendererEvent } from '../../lib/analytics';
import type { SafeFileCountBucket, SafeWorkspaceKind } from '@waypoint/analytics-policy';

type WorkspaceSource = NonNullable<OpenWorkspaceOptions['telemetrySource']>;

interface CommittedWorkspaceOpen {
  rootPath: string;
  workspaceSource: WorkspaceSource;
  workspaceKind: SafeWorkspaceKind;
  deliveryId?: string;
}

const indexedFileCounts = new Map<string, number>();
const pendingOpens = new Map<string, CommittedWorkspaceOpen[]>();
const observedDeliveryIds = new Set<string>();

export function observeCommittedWorkspaceOpen(input: CommittedWorkspaceOpen): void {
  if (input.deliveryId) {
    if (observedDeliveryIds.has(input.deliveryId)) return;
    observedDeliveryIds.add(input.deliveryId);
  }
  const fileCount = indexedFileCounts.get(input.rootPath);
  if (fileCount !== undefined) {
    emitWorkspaceOpened(input, fileCount);
    return;
  }
  const pending = pendingOpens.get(input.rootPath) ?? [];
  pending.push(input);
  pendingOpens.set(input.rootPath, pending);
}

export function observeWorkspaceSetPath(
  rootPath: string,
  deliveryId: string | undefined,
  context: unknown
): void {
  const isManagedSync = context === 'managed_sync';
  observeCommittedWorkspaceOpen({
    rootPath,
    workspaceSource: isManagedSync ? 'sync' : 'startup_arg',
    workspaceKind: isManagedSync ? 'managed' : 'folder',
    deliveryId,
  });
}

export function recordWorkspaceIndex(rootPath: string, fileCount: number): void {
  const safeCount = Number.isInteger(fileCount) && fileCount >= 0 ? fileCount : 0;
  indexedFileCounts.set(rootPath, safeCount);
  const pending = pendingOpens.get(rootPath) ?? [];
  pendingOpens.delete(rootPath);
  for (const open of pending) emitWorkspaceOpened(open, safeCount);
}

export function workspaceOpenObservation(
  instance: WorkspaceInstance,
  options: OpenWorkspaceOptions
): CommittedWorkspaceOpen | null {
  const rootPath = instance.rootFolders[0]?.path;
  if (!rootPath) return null;
  return {
    rootPath,
    workspaceSource: options.telemetrySource ?? 'unknown',
    workspaceKind: workspaceKind(instance),
  };
}

function workspaceKind(instance: WorkspaceInstance): SafeWorkspaceKind {
  if (instance.id.startsWith('managed:')) return 'managed';
  if (instance.source.kind === 'git-clone') return 'git';
  if (instance.source.kind === 'local-folder' || instance.source.kind === 'empty') return 'folder';
  return 'unknown';
}

function emitWorkspaceOpened(input: CommittedWorkspaceOpen, fileCount: number): void {
  trackRendererEvent('workspace_opened', {
    feature_area: 'workspace',
    workspace_source: input.workspaceSource,
    workspace_kind: input.workspaceKind,
    file_count_bucket: bucketFileCount(fileCount),
    file_count: fileCount,
  });
}

function bucketFileCount(count: number): SafeFileCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  if (count <= 100) return '21_100';
  return '100_plus';
}

export function __resetWorkspaceTelemetryForTests(): void {
  lifecycleStoreSubscription?.();
  lifecycleStoreSubscription = undefined;
  currentProjectLifecycles.clear();
  indexedFileCounts.clear();
  pendingOpens.clear();
  observedDeliveryIds.clear();
}

export function observeSampleAssetOpen(source: WorkspaceSource): boolean {
  try {
    trackRendererEvent('sample_project_opened', {
      feature_area: 'project',
      workspace_source: source,
    });
  } catch {}
  return source === 'sample_selection';
}

export interface ProjectLifecycle {
  readonly operationId: string | undefined;
  authority(value: ProjectAuthority): void;
  stage(value: ProjectLifecycleStage): void;
  phase(value: ProjectLifecyclePhase): void;
}

const currentProjectLifecycles = new Map<string, ProjectLifecycle>();
let lifecycleStoreSubscription: (() => void) | undefined;

export function beginProjectLifecycle(input: {
  source: ProjectLifecycleSource;
  mode: ProjectOpenMode;
  intent: WorkspaceSource;
}): ProjectLifecycle {
  let operationId: string | undefined;
  try {
    operationId = crypto.randomUUID();
  } catch {}
  const phases = new Set<ProjectLifecyclePhase>();
  let authority: ProjectAuthority = 'unknown';
  let stage: ProjectLifecycleStage = 'acceptance';
  const lifecycle: ProjectLifecycle = {
    operationId,
    authority: (value) => {
      authority = value;
    },
    stage: (value) => {
      stage = value;
    },
    phase: (value) => {
      if (phases.has(value)) return;
      phases.add(value);
      if (!operationId) return;
      try {
        trackRendererEvent('project_lifecycle_observed', {
          feature_area: 'workspace',
          operation_id: operationId,
          occurred_at_ms: Date.now(),
          project_phase: value,
          project_source: input.source,
          project_open_mode: input.mode,
          project_stage:
            value === 'indexed' || value === 'index_failed'
              ? 'index'
              : value.startsWith('tree_')
                ? 'tree'
                : value === 'registered'
                  ? 'registration'
                  : value === 'mounted' || value === 'restored'
                    ? 'mount'
                    : value === 'minted'
                      ? 'materialization'
                      : stage,
          workspace_source: input.intent,
          project_authority: authority,
        });
      } catch {}
    },
  };
  lifecycle.phase('accepted');
  return lifecycle;
}

export function bindProjectLifecycle(root: string, lifecycle: ProjectLifecycle): void {
  lifecycleStoreSubscription ??= useWorkspaceStore.subscribe((state, previous) => {
    if (state.folders === previous.folders) return;
    const retained = new Set(state.folders.map((folder) => normalizePathForBoundary(folder.path)));
    for (const folder of previous.folders) {
      if (!retained.has(normalizePathForBoundary(folder.path)))
        releaseProjectLifecycle(folder.path);
    }
  });
  const key = normalizePathForBoundary(root);
  const previous = currentProjectLifecycles.get(key);
  if (previous && previous !== lifecycle) previous.phase('superseded');
  currentProjectLifecycles.set(key, lifecycle);
}

export function captureProjectLifecycle(root: string): ProjectLifecycle | undefined {
  return currentProjectLifecycles.get(normalizePathForBoundary(root));
}

export function observeProjectLifecyclePhase(
  root: string,
  lifecycle: ProjectLifecycle | undefined,
  phase: ProjectLifecyclePhase
): void {
  if (lifecycle && captureProjectLifecycle(root) === lifecycle) {
    const mounted = useWorkspaceStore
      .getState()
      .folders.some(
        (folder) => normalizePathForBoundary(folder.path) === normalizePathForBoundary(root)
      );
    if (!mounted) {
      releaseProjectLifecycle(root);
      return;
    }
    lifecycle.phase(phase);
  }
}

export function releaseProjectLifecycle(root: string): void {
  const key = normalizePathForBoundary(root);
  currentProjectLifecycles.get(key)?.phase('superseded');
  currentProjectLifecycles.delete(key);
}

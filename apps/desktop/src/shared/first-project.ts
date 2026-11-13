export const DEFAULT_PROJECT_DISPLAY_NAME = 'My Project';

export interface OriginalDefaultProject {
  workspaceId: number;
  repoUuid: string;
  rootPath: string;
  displayName: string;
  createdAt: number;
}

export interface IdentifyOriginalDefaultProjectRequest {
  workspaceId: number;
  repoUuid: string;
}

export type OriginalDefaultProjectResolution =
  | {
      status: 'ready';
      project: OriginalDefaultProject;
      evidence: 'stored-identity' | 'legacy-default-path' | 'legacy-backup';
    }
  | {
      status: 'unresolved';
      reason:
        | 'identity-not-recorded'
        | 'invalid-identity'
        | 'conflicting-evidence'
        | 'evidence-unreadable'
        | 'project-missing'
        | 'project-archived'
        | 'project-trashed'
        | 'project-read-only'
        | 'project-unavailable';
      message: string;
    };

export type FirstProjectEnsurePhase = 'idle' | 'creating' | 'awaiting-library';

export function needsOriginalProjectIdentification(
  resolution: OriginalDefaultProjectResolution
): boolean {
  return (
    resolution.status === 'unresolved' &&
    ['identity-not-recorded', 'conflicting-evidence', 'evidence-unreadable'].includes(
      resolution.reason
    )
  );
}

export function resolveOriginalProjectRecovery(
  resolution: OriginalDefaultProjectResolution | undefined,
  unassignedRecoveryRequired: boolean
): 'clear' | 'identify' | 'restore' {
  if (!unassignedRecoveryRequired || !resolution || resolution.status === 'ready') return 'clear';
  return needsOriginalProjectIdentification(resolution) ? 'identify' : 'restore';
}

export type FirstProjectEnsureDecision = {
  phase: FirstProjectEnsurePhase;
  action: 'create' | 'mount' | 'wait';
};

export function resolveFirstProjectEnsure(
  phase: FirstProjectEnsurePhase,
  activeProjectExists: boolean
): FirstProjectEnsureDecision {
  if (activeProjectExists) {
    return { phase: 'idle', action: 'mount' };
  }
  if (phase === 'idle') {
    return { phase: 'creating', action: 'create' };
  }
  return { phase, action: 'wait' };
}

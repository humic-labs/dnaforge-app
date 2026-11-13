import type {
  JobsSidebarCollectionObservation,
  JobsSidebarHistorySummary,
  JobsSidebarScope,
  JobsSidebarSnapshot,
} from './presentation';

export interface JobsSnapshotSource {
  readonly label: string;
  readonly snapshot: JobsSidebarSnapshot;
}

export interface FederatedJobsPresentationOptions {
  readonly nowMs: number;
}

function aggregateObservedAt(sources: readonly JobsSnapshotSource[]): number | undefined {
  const observed = sources.flatMap(({ snapshot }) =>
    snapshot.collectionObservation.observedAtMs === undefined
      ? []
      : [snapshot.collectionObservation.observedAtMs]
  );
  return observed.length > 0 ? Math.min(...observed) : undefined;
}

function collectionObservation(
  sources: readonly JobsSnapshotSource[]
): JobsSidebarCollectionObservation {
  const unavailable = sources.filter(
    ({ snapshot }) => snapshot.collectionObservation.state === 'unavailable'
  );
  const observedAtMs = aggregateObservedAt(sources);
  if (unavailable.length > 0) {
    const reason = unavailable
      .map(
        ({ label, snapshot }) =>
          `${label}: ${snapshot.collectionObservation.reason ?? 'status is unavailable'}`
      )
      .join(' · ');
    return {
      state: 'unavailable',
      ...(observedAtMs !== undefined ? { observedAtMs } : {}),
      reason,
      ...(unavailable.some(({ snapshot }) => snapshot.collectionObservation.canReconnect)
        ? { canReconnect: true }
        : {}),
    };
  }

  const connecting = sources.filter(
    ({ snapshot }) => snapshot.collectionObservation.state === 'connecting'
  );
  if (connecting.length > 0) {
    const reasons = connecting.flatMap(({ label, snapshot }) =>
      snapshot.collectionObservation.reason
        ? [`${label}: ${snapshot.collectionObservation.reason}`]
        : []
    );
    return {
      state: 'connecting',
      ...(observedAtMs !== undefined ? { observedAtMs } : {}),
      ...(reasons.length > 0 ? { reason: reasons.join(' · ') } : {}),
    };
  }

  return {
    state: 'current',
    ...(observedAtMs !== undefined ? { observedAtMs } : {}),
  };
}

function historySummary(
  sources: readonly JobsSnapshotSource[]
): JobsSidebarHistorySummary | undefined {
  const summaries = sources.map(({ snapshot }) => snapshot.historySummary);
  if (summaries.some((summary) => summary === undefined)) return undefined;
  return summaries.reduce<JobsSidebarHistorySummary>(
    (combined, summary) => ({
      operationCount: combined.operationCount + (summary?.operationCount ?? 0),
      activeCount: combined.activeCount + (summary?.activeCount ?? 0),
      terminalCount: combined.terminalCount + (summary?.terminalCount ?? 0),
      historyComplete: combined.historyComplete && (summary?.historyComplete ?? false),
    }),
    { operationCount: 0, activeCount: 0, terminalCount: 0, historyComplete: true }
  );
}

function scopes(sources: readonly JobsSnapshotSource[]): readonly JobsSidebarScope[] | undefined {
  const byId = new Map<string, JobsSidebarScope>();
  for (const { snapshot } of sources) {
    for (const scope of snapshot.scopes ?? []) byId.set(scope.id, scope);
  }
  return byId.size > 0 ? [...byId.values()] : undefined;
}

export function combineJobsSnapshots(
  sources: readonly JobsSnapshotSource[],
  options: FederatedJobsPresentationOptions
): JobsSidebarSnapshot {
  const combinedHistory = historySummary(sources);
  const combinedScopes = scopes(sources);
  const selectedScopeId = sources.find(({ snapshot }) => snapshot.selectedScopeId !== undefined)
    ?.snapshot.selectedScopeId;
  return {
    nowMs: options.nowMs,
    collectionObservation: collectionObservation(sources),
    jobs: sources.flatMap(({ snapshot }) => snapshot.jobs),
    ...(combinedHistory ? { historySummary: combinedHistory } : {}),
    ...(combinedScopes ? { scopes: combinedScopes } : {}),
    ...(selectedScopeId !== undefined ? { selectedScopeId } : {}),
  };
}

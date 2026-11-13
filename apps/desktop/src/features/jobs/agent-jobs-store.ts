import {
  cancelAgentJobOperationsAgentJobsJobIdDelete,
  listAgentJobsOperationsAgentJobsGet,
  type AgentJobSummary,
} from '@waypoint/api-client';
import { create } from 'zustand';

import { configureSidecarApiClient } from '../../services/sidecar-session';
import type { AgentJobRecord } from './agent-jobs-presentation';

export interface AgentJobsState {
  jobs: AgentJobRecord[];
  jobCount: number;
  activeCount: number;
  terminalCount: number;
  historyComplete: boolean;
  loading: boolean;
  error: string | null;
  observedAtMs: number | null;
  collectionStale: boolean;
  refresh(): Promise<void>;
  cancel(actionId: string): Promise<void>;
  invalidateRuntime(): void;
  resetForTests(): void;
}

function agentJob(record: AgentJobSummary): AgentJobRecord {
  return {
    ...record,
    completed_at: record.completed_at ?? null,
    error_code: record.error_code ?? null,
    agent_identity: {
      ...record.agent_identity,
      label: record.agent_identity.label ?? null,
      kind: record.agent_identity.kind ?? null,
    },
  };
}

async function loadAgentJobs(): Promise<{
  jobs: AgentJobRecord[];
  jobCount: number;
  activeCount: number;
  terminalCount: number;
  historyComplete: boolean;
}> {
  await configureSidecarApiClient('Agent jobs');
  const response = await listAgentJobsOperationsAgentJobsGet({ limit: 200, offset: 0 });
  if (response.status !== 200) throw new Error('Could not load agent jobs.');
  return {
    jobs: response.data.jobs.map(agentJob),
    jobCount: response.data.job_count,
    activeCount: response.data.active_count,
    terminalCount: response.data.terminal_count,
    historyComplete: response.data.history_complete,
  };
}

export const useAgentJobsStore = create<AgentJobsState>((set, get) => {
  let runtimeGeneration = 0;
  let requestSequence = 0;
  let pendingStops = 0;
  return {
    jobs: [],
    jobCount: 0,
    activeCount: 0,
    terminalCount: 0,
    historyComplete: true,
    loading: false,
    error: null,
    observedAtMs: null,
    collectionStale: true,

    async refresh() {
      const runtime = runtimeGeneration;
      const request = ++requestSequence;
      set({ loading: true });
      try {
        const collection = await loadAgentJobs();
        if (runtime !== runtimeGeneration || request !== requestSequence) return;
        if (pendingStops > 0) {
          set({ loading: false, collectionStale: true });
          return;
        }
        set({
          ...collection,
          loading: false,
          error: null,
          collectionStale: false,
          observedAtMs: Date.now(),
        });
      } catch (error) {
        if (runtime !== runtimeGeneration || request !== requestSequence) return;
        set({
          loading: false,
          collectionStale: true,
          error: error instanceof Error ? error.message : 'Could not load agent jobs.',
        });
      }
    },

    async cancel(actionId) {
      const runtime = runtimeGeneration;
      pendingStops += 1;
      requestSequence += 1;
      set({ loading: false, collectionStale: true });
      try {
        await configureSidecarApiClient('Agent jobs');
        if (runtime !== runtimeGeneration)
          throw new Error('Jobs runtime changed. Refresh Jobs before requesting Stop.');
        const response = await cancelAgentJobOperationsAgentJobsJobIdDelete(actionId);
        if (response.status !== 204) throw new Error('Could not stop the agent job.');
        if (runtime !== runtimeGeneration)
          throw new Error(
            'Jobs runtime changed before the Stop acknowledgment could be shown. Refresh Jobs.'
          );
      } catch (error) {
        if (runtime === runtimeGeneration) {
          pendingStops -= 1;
          requestSequence += 1;
          set({ loading: false, collectionStale: true });
        }
        throw error;
      }
      pendingStops -= 1;
      requestSequence += 1;
      set({ loading: false, collectionStale: true });

      await get().refresh();
    },

    invalidateRuntime() {
      runtimeGeneration += 1;
      requestSequence += 1;
      pendingStops = 0;
      set({ loading: false, error: null, collectionStale: true });
    },

    resetForTests() {
      runtimeGeneration += 1;
      requestSequence += 1;
      pendingStops = 0;
      set({
        jobs: [],
        jobCount: 0,
        activeCount: 0,
        terminalCount: 0,
        historyComplete: true,
        loading: false,
        error: null,
        observedAtMs: null,
        collectionStale: true,
      });
    },
  };
});

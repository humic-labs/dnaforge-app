import { userMessageWithValues, userMessageValue, toUserMessage } from '@waypoint/user-messages';
import { useComputeJobsStore } from './jobs-store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useToastStore } from '../../stores/toast-store';
import type { ComputeJobTerminalEvent } from '../../shared/compute-jobs-ipc';
import { platform } from '../../platform';

export interface ComputeJobTerminalAdapterDeps {
  refreshJobs: () => void;
  notify: (event: ComputeJobTerminalEvent, onImport: () => void) => void;
  importJob: (event: ComputeJobTerminalEvent) => Promise<void>;
}

function describe(event: ComputeJobTerminalEvent): string {
  return event.label ?? `${event.toolId} on ${event.provider}`;
}

export function defaultDeps(): ComputeJobTerminalAdapterDeps {
  return {
    refreshJobs: () => {
      void useComputeJobsStore.getState().refresh();
    },
    notify: (event, onImport) => {
      useToastStore.getState().addRichToast({
        definition: 'compute-job-ready',
        message: userMessageWithValues(
          'notice.value-finished-on-value-import-it-into-your-workspace',
          {
            value0: userMessageValue(toUserMessage(describe(event), 'operation.failed')),
            value1: userMessageValue(event.provider),
          }
        ),
        actions: [{ label: 'Import', onClick: onImport }],
      });
    },
    importJob: async (event) => {
      const { importCompletedJob } = await import('./predict-structure');
      await importCompletedJob(
        {
          provider: event.provider,
          remoteId: event.remoteId,
          toolId: event.toolId,
          workspaceRoot: event.workspaceRoot,
          label: event.label,
        },
        useWorkspaceStore.getState().folders
      );
    },
  };
}

export function handleComputeJobTerminal(
  event: ComputeJobTerminalEvent,
  deps: ComputeJobTerminalAdapterDeps
): void {
  deps.refreshJobs();
  if (event.state !== 'completed' || !event.remoteId) return;
  deps.notify(event, () => {
    void deps.importJob(event).finally(() => deps.refreshJobs());
  });
}

export function installComputeJobTerminalAdapter(
  deps: ComputeJobTerminalAdapterDeps = defaultDeps()
): () => void {
  let unsubscribe: (() => void) | undefined;
  try {
    const bridge = platform();
    if (bridge?.on) {
      unsubscribe = bridge.on('compute:jobTerminal', (...args: unknown[]) => {
        handleComputeJobTerminal(args[0] as ComputeJobTerminalEvent, deps);
      });
    }
  } catch {}
  return () => unsubscribe?.();
}

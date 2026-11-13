import { userMessage } from '@waypoint/user-messages';
import { useEffect, useRef } from 'react';
import { useToastStore } from '../../stores/toast-store';
import type { BenchlingMigrationStatusSnapshot } from './useBenchlingMigrationStatus';
import type { BenchlingMigrationRunView } from '../../shared/benchling-migration-ipc';

type NotifiableState = 'unlocked' | 'action_required';

function isNotifiableState(state: string | undefined): state is NotifiableState {
  return state === 'unlocked' || state === 'action_required';
}

export function useBenchlingMigrationNotifications(
  snapshot: BenchlingMigrationStatusSnapshot,
  onOpenMigrationSettings: () => void,
  completedRun: BenchlingMigrationRunView | null = null
): void {
  const openMigrationSettingsRef = useRef(onOpenMigrationSettings);
  openMigrationSettingsRef.current = onOpenMigrationSettings;

  useEffect(() => {
    const run = snapshot.run ?? completedRun;
    if (!run || !isNotifiableState(run.state)) {
      useToastStore.getState().clearToastGroup('migration-result');
      return;
    }
    const notificationId = `${run.id}:${run.linkedItemRecovery?.attemptId ?? 'initial'}`;
    const completed = run.state === 'unlocked';
    if (completed && run.linkedItemRecovery && run.linkedItemRecovery.state !== 'completed') {
      useToastStore.getState().clearToastGroup('migration-result');
      return;
    }
    useToastStore.getState().addRichToast({
      definition: 'migration-result',
      variant: completed ? 'success' : 'warning',
      key: `${notificationId}:${run.state}`,
      message: completed
        ? userMessage('notice.benchling-import-is-ready-open-it-to-review-the-result')
        : userMessage('notice.benchling-migration-needs-attention-before-it-can-continue'),
      actions: [
        {
          label: 'View migration',
          onClick: () => openMigrationSettingsRef.current(),
        },
      ],
    });
  }, [snapshot.run, completedRun]);
}

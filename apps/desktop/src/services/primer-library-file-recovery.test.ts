import { beforeEach, expect, it, vi } from 'vitest';
import { useToastStore } from '../stores/toast-store';
import { reportPrimerRecoveryInventory } from './workspace-reconcile-report';

vi.mock('../features/primers/public/primer-recovery-report', () => ({
  getLatestPrimerRecoveryInventory: () => null,
}));
beforeEach(() => useToastStore.getState().clearToasts());
it('offers one persistent file recovery action for existing unassigned library rows without calling them lost', () => {
  reportPrimerRecoveryInventory({
    schema: 'dnaforge.primer-recovery-inventory/v1',
    recordedAt: 1,
    entries: [
      {
        id: 'existing-primer',
        name: 'POP5_R',
        source: 'legacy',
        workspaceId: null,
        projectUuid: null,
        status: 'legacy-library',
      },
    ],
  });
  const notices = useToastStore
    .getState()
    .toasts.filter((toast) => toast.definition === 'primer-library-file-recovery');
  expect(notices).toHaveLength(1);
  expect(notices[0].duration).toBe(0);
  expect(notices[0].actions?.map((action) => action.label)).toEqual([
    'Save library primers as files',
  ]);
  expect(notices[0].message).toContain('stored only in this application');
  expect(
    useToastStore.getState().toasts.some((toast) => toast.definition === 'primer-recovery-failed')
  ).toBe(false);
});

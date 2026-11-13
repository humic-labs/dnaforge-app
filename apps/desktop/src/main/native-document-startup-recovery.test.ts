// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { NativeDocumentStartupRecovery } from './native-document-startup-recovery';
import { createProfileBoundNativeDocumentOwnerId } from './native-document-owner-identity';
import type {
  NativeDocumentRecoveryOutcome,
  PendingNativeDocumentAction,
} from './native-document-recovery';

const profile = 'a'.repeat(64);
const ownerId = createProfileBoundNativeDocumentOwnerId(profile);
function action(
  id: string,
  previousOwner = createProfileBoundNativeDocumentOwnerId(profile)
): PendingNativeDocumentAction {
  return {
    id,
    operation_id: `operation-${id}`,
    operation_kind: 'annotation',
    action: 'apply_to_document',
    actor_kind: 'human',
    actor_id: 'original-human',
    channel: 'managed_cli',
    recorded_at: 1,
    outcome: 'document_admitted',
    details_json: {
      native_owner_instance_id: previousOwner,
      target_document_id: 'doc',
      request_sha256: `sha256:${'b'.repeat(64)}`,
    },
  };
}
function setup() {
  const owner = {
    pending: vi.fn(async (_cursor?: string) => ({
      native_owner_instance_id: ownerId,
      actions: [action('a')],
      next_action_id: null as string | null,
    })),
    recover: vi.fn(
      async (_action: PendingNativeDocumentAction): Promise<NativeDocumentRecoveryOutcome> => ({
        settlement: { status: 'blocked', reason: 'No write intent.' },
      })
    ),
  };
  const ready = vi.fn<() => Promise<() => boolean>>(async () => () => true);
  const report = vi.fn();
  return {
    owner,
    ready,
    report,
    coordinator: new NativeDocumentStartupRecovery({
      owner,
      nativeOwnerInstanceId: ownerId,
      profileKey: profile,
      ready,
      report,
    }),
  };
}

it('observes only predecessors from the locked profile, preserving the original action', async () => {
  const f = setup();
  const predecessor = action('a');
  f.owner.pending.mockResolvedValue({
    native_owner_instance_id: ownerId,
    actions: [
      predecessor,
      action('b', ownerId),
      action('c', 'legacy-owner'),
      action('d', createProfileBoundNativeDocumentOwnerId('c'.repeat(64))),
    ],
    next_action_id: null,
  });
  await f.coordinator.request();
  expect(f.owner.recover.mock.calls).toEqual([[predecessor]]);
  expect(f.report).toHaveBeenCalledWith({
    observed: 1,
    unresolved: 0,
    skipped: 3,
    failed: 0,
    complete: true,
  });
});

it('refuses automatic recovery when the current owner is not bound to the locked profile', async () => {
  const f = setup();
  const coordinator = new NativeDocumentStartupRecovery({
    ...f,
    nativeOwnerInstanceId: 'external-owner',
    profileKey: profile,
  });
  await coordinator.request();
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.owner.pending).not.toHaveBeenCalled();
});

it('does not inspect a file after the service generation changes during discovery', async () => {
  const f = setup();
  let current = true;
  f.ready.mockImplementation(async () => () => current);
  f.owner.pending.mockImplementation(async () => {
    current = false;
    return { native_owner_instance_id: ownerId, actions: [action('a')], next_action_id: null };
  });
  await f.coordinator.request();
  expect(f.owner.recover).not.toHaveBeenCalled();
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ complete: false }));
});

it('coalesces pending enrollment changes and stops accepting recovery on close', async () => {
  const f = setup();
  const first = f.coordinator.request();
  const latest = f.coordinator.request();
  await Promise.all([first, latest]);
  expect(f.owner.recover).toHaveBeenCalledTimes(1);
  await f.coordinator.close();
  await f.coordinator.request();
  expect(f.owner.recover).toHaveBeenCalledTimes(1);
});

it('closes without waiting for a service that never became ready', async () => {
  const f = setup();
  f.ready.mockImplementation(() => new Promise(() => {}));
  const request = f.coordinator.request();
  await Promise.resolve();
  expect(f.ready).toHaveBeenCalledTimes(1);
  await f.coordinator.close();
  await request;
  expect(f.owner.pending).not.toHaveBeenCalled();
});

it('reports an unresolved observation and continues to another predecessor after one refusal', async () => {
  const f = setup();
  f.owner.pending.mockResolvedValue({
    native_owner_instance_id: ownerId,
    actions: [action('a'), action('b')],
    next_action_id: null,
  });
  f.owner.recover.mockRejectedValueOnce(new Error('Workspace not enrolled.'));
  f.owner.recover.mockResolvedValueOnce({
    settlement: { status: 'outcome-unresolved', reason: 'External changes.' },
  });
  await f.coordinator.request();
  expect(f.report).toHaveBeenCalledWith({
    observed: 1,
    unresolved: 1,
    skipped: 0,
    failed: 1,
    complete: true,
  });
});

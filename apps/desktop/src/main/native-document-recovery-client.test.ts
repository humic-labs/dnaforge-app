// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { NativeDocumentRecoveryClient } from './native-document-recovery-client';
import type { PendingNativeDocumentAction } from './native-document-recovery';
import type { SidecarFetch } from './sidecar-request-auth';

function action(id = 'action-1'): PendingNativeDocumentAction {
  return {
    id,
    operation_id: 'op-1',
    operation_kind: 'annotation',
    action: 'apply_to_document',
    actor_kind: 'agent',
    actor_id: 'agent-1',
    channel: 'agent',
    recorded_at: 4,
    outcome: 'document_admitted',
    details_json: {
      native_owner_instance_id: 'old-owner',
      target_document_id: 'doc-1',
      request_sha256: `sha256:${'a'.repeat(64)}`,
    },
  };
}

function client(body: unknown) {
  const fetch = vi.fn<SidecarFetch>(async () => Response.json(body));
  return {
    fetch,
    owner: new NativeDocumentRecoveryClient({ nativeOwnerInstanceId: 'new-owner', fetch }),
  };
}

it('reads one bounded private page with the exact action cursor', async () => {
  const f = client({
    native_owner_instance_id: 'new-owner',
    actions: [action('action-2')],
    next_action_id: null,
  });
  expect((await f.owner.pending('action-1')).actions).toEqual([action('action-2')]);
  expect(f.fetch.mock.calls[0]?.[0]).toBe(
    '/internal/managed-documents/pending?limit=32&after_action_id=action-1'
  );
  expect(f.fetch).toHaveBeenCalledOnce();
});

it.each([
  { native_owner_instance_id: 'foreign-owner', actions: [action()], next_action_id: null },
  {
    native_owner_instance_id: 'new-owner',
    actions: [action(), action()],
    next_action_id: 'action-1',
  },
  {
    native_owner_instance_id: 'new-owner',
    actions: [{ ...action(), outcome: 'document_writing' }],
    next_action_id: null,
  },
  { native_owner_instance_id: 'new-owner', actions: [action()], next_action_id: 'unseen-action' },
])('refuses malformed, repeated or foreign-owner pending evidence', async (body) => {
  await expect(client(body).owner.pending()).rejects.toThrow();
});

it('confirms an observation while retaining the exact original actor and action', async () => {
  const original = action();
  const settlement = {
    status: 'blocked' as const,
    reason: 'The old owner ended before write permission.',
  };
  const record = {
    ...original,
    outcome: 'document_blocked',
    details_json: {
      ...original.details_json,
      settlement,
      recovered_by_native_owner_instance_id: 'new-owner',
    },
  };
  const f = client({ status: 'recorded', record });
  await f.owner.recover(original, settlement);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0]?.[0]).toBe('/internal/managed-documents/actions/action-1/recovery');
  const changed = client({ status: 'recorded', record: { ...record, actor_id: 'new-agent' } });
  await expect(changed.owner.recover(original, settlement)).rejects.toThrow(/receipt/i);
});

it('never retries a missing recovery acknowledgement or accepts permission as settlement', async () => {
  const f = client({ status: 'permitted', record: action() });
  await expect(f.owner.recover(action(), { status: 'blocked' })).rejects.toThrow();
  expect(f.fetch).toHaveBeenCalledOnce();
  f.fetch.mockRejectedValue(new Error('response lost'));
  await expect(f.owner.recover(action(), { status: 'blocked' })).rejects.toThrow('response lost');
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

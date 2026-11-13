import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useOrganizationRecordSync } from './useOrganizationRecordSync';
import { LIMS_REGISTRY_CHANGED_EVENT } from '../../events';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  changed: vi.fn(),
  review: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('../../../../platform', () => ({
  platform: () => ({
    cloudSync: {
      getOrganizationRegistryRecordSyncStatus: mocks.status,
      onOrganizationRegistryChanged: mocks.changed,
      getOrganizationRegistrySavedRecordReview: mocks.review,
      resolveOrganizationRegistrySavedRecord: mocks.resolve,
    },
  }),
}));
vi.mock('../../../../stores/auth-store', () => {
  const state = { state: { status: 'signed-in', session: { accountId: 'account-a' } } };
  return {
    useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
beforeEach(() => {
  mocks.status.mockReset();
  mocks.review.mockReset();
  mocks.resolve.mockReset();
  mocks.changed.mockReset().mockReturnValue(() => {});
  mocks.status.mockResolvedValue({ ok: true, accountId: 'account-a', status: null });
});
afterEach(cleanup);

it('keeps an older local identity readable without sending an invalid organization request', async () => {
  const { result } = renderHook(() => useOrganizationRecordSync('dev-sequence-metadata-legacy'));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await result.current.refresh();
    await result.current.synchronize();
  });
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.changed).not.toHaveBeenCalled();
  expect(result.current.error).toBeNull();
  expect(result.current.status).toBeNull();
});

it('retires an in-flight organization result when moving to an older local identity', async () => {
  let finish!: (value: unknown) => void;
  mocks.status.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const id = '10000000-0000-4000-8000-000000000001';
  const { result, rerender } = renderHook(({ entityId }) => useOrganizationRecordSync(entityId), {
    initialProps: { entityId: id },
  });
  await waitFor(() => expect(mocks.status).toHaveBeenCalledWith(id));
  rerender({ entityId: 'legacy-local-sequence' });
  await act(async () => {
    finish({ ok: true, accountId: 'account-a', status: { entityId: id, status: 'synced' } });
  });
  expect(result.current.status).toBeNull();
  expect(result.current.error).toBeNull();
  expect(mocks.status).toHaveBeenCalledTimes(1);
});

function organizationReview() {
  const entity = {
    id: '10000000-0000-4000-8000-000000000001',
    kind: 'sequence',
    schemaId: 'schema-entity-sequence',
    schemaRevisionId: 'schema-entity-sequence-v1',
    name: 'Saved sequence',
    registryId: null,
    fields: {},
    registrationStatus: 'tracked',
    domainStatus: null,
    workspaceId: 1,
    actor: 'test',
    eventSeq: 2,
    tombstone: true,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: 2,
  };
  const orgId = '20000000-0000-4000-8000-000000000002';
  const review = {
    accountId: 'account-a',
    orgId,
    entityId: entity.id,
    sourceRevision: 'a'.repeat(64),
    localEventSeq: 1,
    organizationRevision: 2,
    local: { ...entity, archived: false },
    organization: { ...entity, archived: true },
  };
  mocks.status.mockResolvedValue({
    ok: true,
    accountId: 'account-a',
    status: {
      orgId,
      entityId: entity.id,
      homeWorkspaceId: '30000000-0000-4000-8000-000000000003',
      acknowledgedRevision: 1,
      baseRevision: 1,
      baseProvenance: 'receipt',
      status: 'remote_changes',
      mutationId: '40000000-0000-4000-8000-000000000004',
      message: null,
    },
  });
  mocks.review.mockResolvedValue({ ok: true, review });
  return { entity, orgId, review };
}

it.each(['mounted', 'closed'] as const)(
  'invalidates Registry after confirmed resolution with the record view %s',
  async (view) => {
    const { entity, orgId, review } = organizationReview();
    const pending = Promise.withResolvers<{
      ok: true;
      entity: typeof entity;
      replayed: boolean;
    }>();
    mocks.resolve.mockReturnValue(pending.promise);
    const changed = vi.fn();
    window.addEventListener(LIMS_REGISTRY_CHANGED_EVENT, changed);
    try {
      const { result, unmount } = renderHook(() => useOrganizationRecordSync(entity.id));
      await waitFor(() => expect(result.current.review).not.toBeNull());
      let application: Promise<unknown> = Promise.resolve();
      await act(async () => {
        application = result.current.resolve('use_remote');
      });
      expect(mocks.resolve).toHaveBeenCalledWith(orgId, {
        entityId: entity.id,
        resolutionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        choice: 'use_remote',
        sourceRevision: review.sourceRevision,
      });
      expect(changed).not.toHaveBeenCalled();
      if (view === 'closed') unmount();
      await act(async () => {
        pending.resolve({ ok: true, entity, replayed: false });
        await application;
      });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(LIMS_REGISTRY_CHANGED_EVENT, changed);
    }
  }
);

it.each(['refused', 'wrong identity'] as const)(
  'does not invalidate Registry for a %s resolution result',
  async (outcome) => {
    const { entity } = organizationReview();
    mocks.resolve.mockResolvedValue(
      outcome === 'refused'
        ? { ok: false, code: 'ACCESS_DENIED', message: 'The home is read-only.' }
        : {
            ok: true,
            entity: { ...entity, id: '50000000-0000-4000-8000-000000000005' },
            replayed: false,
          }
    );
    const changed = vi.fn();
    window.addEventListener(LIMS_REGISTRY_CHANGED_EVENT, changed);
    try {
      const { result } = renderHook(() => useOrganizationRecordSync(entity.id));
      await waitFor(() => expect(result.current.review).not.toBeNull());
      await act(async () => {
        expect(await result.current.resolve('use_remote')).toBeNull();
      });
      expect(changed).not.toHaveBeenCalled();
      expect(result.current.error).toBeTruthy();
    } finally {
      window.removeEventListener(LIMS_REGISTRY_CHANGED_EVENT, changed);
    }
  }
);

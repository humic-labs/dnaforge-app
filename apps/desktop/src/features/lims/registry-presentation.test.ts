// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { observeRegistryPresentation, useLimsOverlayStore } from './lims-overlay-store';
import { presentRegistryEntity, navigateToRegistryEntity } from './registry-presentation';
const commands = vi.hoisted(() => ({ dispatch: vi.fn(), mounted: true }));
vi.mock('../../commands/mounted-command-registry', () => ({
  getMountedCommandRegistry: () =>
    commands.mounted ? { dispatchCommand: commands.dispatch } : null,
}));
vi.mock('../../shared/registry-events', () => ({ requestRegistryOpen: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  commands.mounted = true;
  commands.dispatch.mockReset().mockReturnValue({ handled: true, blocked: false });
  useLimsOverlayStore.setState(useLimsOverlayStore.getInitialState());
});
afterEach(() => {
  vi.useRealTimers();
});
it('waits for the exact presented entity instead of accepting event dispatch or another entity', async () => {
  const pending = presentRegistryEntity({
    entityId: 'exact-record',
    fallbackSearch: 'Duplicate name',
  });
  const requestId = useLimsOverlayStore.getState().registryRequest!.requestId;
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  expect(
    useLimsOverlayStore.getState().completeRegistryRequest(requestId, 'another-record', 'presented')
  ).toBe(false);
  await Promise.resolve();
  expect(finished).toBe(false);
  useLimsOverlayStore.getState().consumeRegistryRequest(requestId);
  expect(
    useLimsOverlayStore.getState().completeRegistryRequest(requestId, 'exact-record', 'presented')
  ).toBe(true);
  await expect(pending).resolves.toEqual({ entityId: 'exact-record', status: 'presented' });
  expect(vi.getTimerCount()).toBe(0);
});
it('settles superseded requests without consuming or cancelling the newer selection', async () => {
  const pending = presentRegistryEntity({
    entityId: 'old-record',
    fallbackSearch: 'Duplicate name',
  });
  const oldId = useLimsOverlayStore.getState().registryRequest!.requestId;
  const newId = useLimsOverlayStore
    .getState()
    .requestRegistryEntity('human-record', 'Duplicate name');
  await expect(pending).resolves.toEqual({ entityId: 'old-record', status: 'superseded' });
  expect(
    useLimsOverlayStore.getState().completeRegistryRequest(oldId, 'old-record', 'presented')
  ).toBe(false);
  expect(useLimsOverlayStore.getState().registryRequest).toMatchObject({
    requestId: newId,
    entityId: 'human-record',
  });
  expect(vi.getTimerCount()).toBe(0);
});
it('refuses a missing presentation and invalidates its late completion at the deadline', async () => {
  const pending = presentRegistryEntity({ entityId: 'absent-view', fallbackSearch: 'Missing' }, 50);
  const requestId = useLimsOverlayStore.getState().registryRequest!.requestId;
  await vi.advanceTimersByTimeAsync(50);
  await expect(pending).resolves.toEqual({ entityId: 'absent-view', status: 'timeout' });
  expect(useLimsOverlayStore.getState().registryRequest).toBeNull();
  expect(
    useLimsOverlayStore.getState().completeRegistryRequest(requestId, 'absent-view', 'presented')
  ).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('propagates a refused native load as failure', async () => {
  const pending = presentRegistryEntity({ entityId: 'missing-record', fallbackSearch: 'Missing' });
  const requestId = useLimsOverlayStore.getState().registryRequest!.requestId;
  useLimsOverlayStore.getState().completeRegistryRequest(requestId, 'missing-record', 'failed');
  await expect(pending).resolves.toEqual({ entityId: 'missing-record', status: 'failed' });
  expect(vi.getTimerCount()).toBe(0);
});

it('navigates through the mounted shell and waits for the real Registry request acknowledgment', async () => {
  const pending = navigateToRegistryEntity({
    entityId: 'native-strain',
    fallbackSearch: 'Duplicate name',
  });
  expect(commands.dispatch).toHaveBeenCalledWith(
    'app.showRegistry',
    expect.objectContaining({ source: 'agent' })
  );
  const request = useLimsOverlayStore.getState().registryRequest!;
  useLimsOverlayStore
    .getState()
    .completeRegistryRequest(request.requestId, request.entityId, 'presented');
  await expect(pending).resolves.toEqual({ entityId: 'native-strain', status: 'presented' });
});
it('refuses unavailable or blocked shell navigation before creating a presentation request', async () => {
  commands.mounted = false;
  await expect(
    navigateToRegistryEntity({ entityId: 'native-strain', fallbackSearch: 'Duplicate name' })
  ).resolves.toMatchObject({ status: 'app-not-ready' });
  commands.mounted = true;
  commands.dispatch.mockReturnValue({ handled: false, blocked: true });
  await expect(
    navigateToRegistryEntity({ entityId: 'native-strain', fallbackSearch: 'Duplicate name' })
  ).resolves.toMatchObject({ status: 'blocked' });
  expect(useLimsOverlayStore.getState().registryRequest).toBeNull();
});

it('accepts the shared Registry owner confirmation only for the exact requested record', async () => {
  const pending = presentRegistryEntity(
    { entityId: 'native-record', fallbackSearch: 'Same name' },
    50
  );
  const request = useLimsOverlayStore.getState().registryRequest!;
  useLimsOverlayStore.getState().consumeRegistryRequest(request.requestId);
  observeRegistryPresentation(request, { kind: 'record', entityId: 'another-record' });
  expect(useLimsOverlayStore.getState().registryRequestResult?.status).toBe('pending');
  observeRegistryPresentation(request, { kind: 'record', entityId: 'native-record' });
  await vi.advanceTimersByTimeAsync(50);
  await expect(pending).resolves.toEqual({ entityId: 'native-record', status: 'presented' });
  expect(vi.getTimerCount()).toBe(0);
});

it('settles native cancellation after the panel has consumed the Registry request', async () => {
  const pending = presentRegistryEntity(
    { entityId: 'cancelled-record', fallbackSearch: 'Record' },
    50
  );
  const request = useLimsOverlayStore.getState().registryRequest!;
  useLimsOverlayStore.getState().consumeRegistryRequest(request.requestId);
  observeRegistryPresentation(request, { kind: 'cancelled' });
  await vi.advanceTimersByTimeAsync(50);
  await expect(pending).resolves.toEqual({ entityId: 'cancelled-record', status: 'superseded' });
  observeRegistryPresentation(request, { kind: 'record', entityId: 'cancelled-record' });
  expect(useLimsOverlayStore.getState().registryRequestResult?.status).toBe('superseded');
  expect(vi.getTimerCount()).toBe(0);
});

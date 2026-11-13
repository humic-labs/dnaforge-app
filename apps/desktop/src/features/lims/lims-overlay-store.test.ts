// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeRegistryPresentation, useLimsOverlayStore } from './lims-overlay-store';
import { requestRegistryEntity } from './public/registry-presentation';

describe('useLimsOverlayStore Registry requests', () => {
  beforeEach(() => {
    useLimsOverlayStore.setState(useLimsOverlayStore.getInitialState());
  });

  it('consumes a handled request so it cannot replay after a panel remount', () => {
    requestRegistryEntity('oligo-1', 'M13 forward');
    const requestId = useLimsOverlayStore.getState().registryRequest!.requestId;

    useLimsOverlayStore.getState().consumeRegistryRequest(requestId);

    expect(useLimsOverlayStore.getState().registryRequest).toBeNull();
  });

  it('never reuses a consumed request identity', () => {
    const first = useLimsOverlayStore.getState().requestRegistryEntity('first-record', 'First');
    useLimsOverlayStore.getState().consumeRegistryRequest(first);
    const second = useLimsOverlayStore.getState().requestRegistryEntity('second-record', 'Second');
    expect(second).toBeGreaterThan(first);
  });

  it('preserves organization navigation and its presentation observer in the same request', () => {
    const observed = vi.fn();
    const requestId = useLimsOverlayStore.getState().requestRegistryEntity('org-record', 'Record', {
      organizationId: 'org-id',
      action: 'claim',
      onPresentation: observed,
    });
    const request = useLimsOverlayStore.getState().registryRequest;
    expect(request).toMatchObject({
      requestId,
      entityId: 'org-record',
      organizationId: 'org-id',
      action: 'claim',
    });
    expect(
      useLimsOverlayStore.getState().completeRegistryRequest(requestId, 'wrong-record', 'presented')
    ).toBe(false);
    expect(observed).not.toHaveBeenCalled();
    expect(
      useLimsOverlayStore.getState().completeRegistryRequest(requestId, 'org-record', 'presented')
    ).toBe(true);
    expect(observed).toHaveBeenCalledExactlyOnceWith({ kind: 'record', entityId: 'org-record' });
  });

  it('acknowledges only the exact pending request and presented entity', () => {
    const store = useLimsOverlayStore.getState();
    const first = store.requestRegistryEntity('first-record', 'Same name');
    expect(store.completeRegistryRequest(first, 'wrong-record', 'presented')).toBe(false);
    const second = store.requestRegistryEntity('second-record', 'Same name');
    expect(store.completeRegistryRequest(first, 'first-record', 'presented')).toBe(false);
    expect(useLimsOverlayStore.getState().registryRequestResult).toMatchObject({
      requestId: second,
      entityId: 'second-record',
      status: 'pending',
    });
    expect(store.completeRegistryRequest(second, 'second-record', 'presented')).toBe(true);
  });

  it('does not let completion of an older request consume a newer one', () => {
    requestRegistryEntity('oligo-1', 'M13 forward');
    const olderRequestId = useLimsOverlayStore.getState().registryRequest!.requestId;
    requestRegistryEntity('oligo-2', 'M13 reverse');

    useLimsOverlayStore.getState().consumeRegistryRequest(olderRequestId);

    expect(useLimsOverlayStore.getState().registryRequest).toMatchObject({
      entityId: 'oligo-2',
      fallbackSearch: 'M13 reverse',
    });
  });

  it('does not recycle a consumed request identity for a later target', () => {
    const store = useLimsOverlayStore.getState();
    requestRegistryEntity('PRIVATE_FIRST', 'first');
    const first = useLimsOverlayStore.getState().registryRequest;
    if (!first) throw new Error('expected first request');
    store.consumeRegistryRequest(first.requestId);
    requestRegistryEntity('PRIVATE_SECOND', 'second');
    store.consumeRegistryRequest(first.requestId);
    expect(useLimsOverlayStore.getState().registryRequest?.entityId).toBe('PRIVATE_SECOND');
  });

  it('settles a replaced pending request once without replacing the next observer', () => {
    const older = vi.fn();
    const newer = vi.fn();
    requestRegistryEntity('PRIVATE_FIRST', 'first', older);
    const first = useLimsOverlayStore.getState().registryRequest;
    if (!first) throw new Error('expected first request');
    requestRegistryEntity('PRIVATE_SECOND', 'second', newer);
    observeRegistryPresentation(first, { kind: 'record', entityId: 'PRIVATE_FIRST' });
    expect(older).toHaveBeenCalledExactlyOnceWith({ kind: 'superseded' });
    expect(newer).not.toHaveBeenCalled();
  });

  it('keeps optional observer exceptions outside request delivery', () => {
    requestRegistryEntity('PRIVATE_FIRST', 'first', () => {
      throw new Error('PRIVATE_OBSERVER_FAILURE');
    });
    const first = useLimsOverlayStore.getState().registryRequest;
    if (!first) throw new Error('expected first request');
    expect(() =>
      observeRegistryPresentation(first, { kind: 'record', entityId: 'PRIVATE_FIRST' })
    ).not.toThrow();
    expect(() => requestRegistryEntity('PRIVATE_SECOND', 'second')).not.toThrow();
    expect(useLimsOverlayStore.getState().registryRequest?.entityId).toBe('PRIVATE_SECOND');
  });
});

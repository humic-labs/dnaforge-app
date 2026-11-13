import { describe, expect, it, vi } from 'vitest';

import {
  installAssemblyAnnotationPolicyTestBridge,
  type AssemblyAnnotationPolicyBridgeTarget,
} from './assembly-annotation-policy-bridge';

describe('assembly annotation viewer-request test bridge', () => {
  it('commands the real viewer request boundary for mode and lane policy', () => {
    let policy: { isoformMode: 'canonical' | 'expanded'; laneLimit: 12 } = {
      isoformMode: 'canonical',
      laneLimit: 12,
    };
    const requestPolicy = vi.fn((next: typeof policy) => {
      policy = next;
    });
    const target = { __test: {} } as unknown as AssemblyAnnotationPolicyBridgeTarget;
    const cleanup = installAssemblyAnnotationPolicyTestBridge(target, {
      getPolicy: () => policy,
      getTransaction: () => ({
        committedPolicy: policy,
        requestedPolicy: policy,
        pendingRequestId: null,
        preparationState: 'idle',
      }),
      requestPolicy,
    });

    expect(target.__test?.setAssemblyAnnotationIsoformMode?.('expanded')).toEqual({
      isoformMode: 'expanded',
      laneLimit: 12,
    });
    expect(requestPolicy).toHaveBeenCalledWith({ isoformMode: 'expanded', laneLimit: 12 });
    expect(target.__test?.setAssemblyAnnotationLaneLimit?.(24)).toEqual({
      isoformMode: 'expanded',
      laneLimit: 24,
    });
    expect(requestPolicy).toHaveBeenLastCalledWith({ isoformMode: 'expanded', laneLimit: 24 });
    expect(target.__test?.getAssemblyAnnotationPolicyTransaction?.()).toEqual({
      committedPolicy: { isoformMode: 'expanded', laneLimit: 24 },
      requestedPolicy: { isoformMode: 'expanded', laneLimit: 24 },
      pendingRequestId: null,
      preparationState: 'idle',
    });
    expect(target.__test?.getAssemblyAnnotationMapperPolicy?.()).toEqual({
      isoformMode: 'expanded',
      laneLimit: 24,
    });

    cleanup();
    expect(target.__test?.setAssemblyAnnotationIsoformMode).toBeUndefined();
    expect(target.__test?.setAssemblyAnnotationLaneLimit).toBeUndefined();
    expect(target.__test?.getAssemblyAnnotationMapperPolicy).toBeUndefined();
    expect(target.__test?.getAssemblyAnnotationPolicyTransaction).toBeUndefined();
  });

  it('rejects invalid modes without committing them', () => {
    const requestPolicy = vi.fn();
    const target = { __test: {} } as unknown as AssemblyAnnotationPolicyBridgeTarget;
    installAssemblyAnnotationPolicyTestBridge(target, {
      getPolicy: () => ({ isoformMode: 'canonical', laneLimit: 8 }),
      getTransaction: () => ({
        committedPolicy: { isoformMode: 'canonical', laneLimit: 8 },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 8 },
        pendingRequestId: null,
        preparationState: 'idle',
      }),
      requestPolicy,
    });

    expect(target.__test?.setAssemblyAnnotationIsoformMode?.('invalid' as never)).toBeNull();
    expect(target.__test?.setAssemblyAnnotationLaneLimit?.(0)).toBeNull();
    expect(target.__test?.setAssemblyAnnotationLaneLimit?.(3.5)).toBeNull();
    expect(requestPolicy).not.toHaveBeenCalled();
  });

  it('restores an older controller only when it still owns the bridge methods', () => {
    const previousSetter = vi.fn(() => ({ isoformMode: 'canonical' as const, laneLimit: 4 }));
    const previousGetter = vi.fn(() => ({ isoformMode: 'canonical' as const, laneLimit: 4 }));
    const previousTransactionGetter = vi.fn(() => ({
      committedPolicy: { isoformMode: 'canonical' as const, laneLimit: 4 },
      requestedPolicy: { isoformMode: 'canonical' as const, laneLimit: 4 },
      pendingRequestId: null,
      preparationState: 'idle' as const,
    }));
    const target = {
      __test: {
        setAssemblyAnnotationIsoformMode: previousSetter,
        getAssemblyAnnotationMapperPolicy: previousGetter,
        getAssemblyAnnotationPolicyTransaction: previousTransactionGetter,
      },
    } as unknown as AssemblyAnnotationPolicyBridgeTarget;
    const cleanup = installAssemblyAnnotationPolicyTestBridge(target, {
      getPolicy: () => ({ isoformMode: 'expanded', laneLimit: 12 }),
      getTransaction: () => ({
        committedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
        requestedPolicy: { isoformMode: 'expanded', laneLimit: 12 },
        pendingRequestId: null,
        preparationState: 'idle',
      }),
      requestPolicy: vi.fn(),
    });

    cleanup();
    expect(target.__test?.setAssemblyAnnotationIsoformMode).toBe(previousSetter);
    expect(target.__test?.getAssemblyAnnotationMapperPolicy).toBe(previousGetter);
    expect(target.__test?.getAssemblyAnnotationPolicyTransaction).toBe(previousTransactionGetter);
  });

  it('does not resurrect an unmounted controller after out-of-order cleanup', () => {
    const target = { __test: {} } as unknown as AssemblyAnnotationPolicyBridgeTarget;
    const cleanupA = installAssemblyAnnotationPolicyTestBridge(target, {
      getPolicy: () => ({ isoformMode: 'canonical', laneLimit: 12 }),
      getTransaction: () => ({
        committedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
        requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
        pendingRequestId: null,
        preparationState: 'idle',
      }),
      requestPolicy: vi.fn(),
    });
    const cleanupB = installAssemblyAnnotationPolicyTestBridge(target, {
      getPolicy: () => ({ isoformMode: 'expanded', laneLimit: 8 }),
      getTransaction: () => ({
        committedPolicy: { isoformMode: 'expanded', laneLimit: 8 },
        requestedPolicy: { isoformMode: 'expanded', laneLimit: 8 },
        pendingRequestId: null,
        preparationState: 'idle',
      }),
      requestPolicy: vi.fn(),
    });

    cleanupA();
    expect(target.__test?.getAssemblyAnnotationMapperPolicy?.()).toEqual({
      isoformMode: 'expanded',
      laneLimit: 8,
    });

    cleanupB();
    expect(target.__test?.setAssemblyAnnotationIsoformMode).toBeUndefined();
    expect(target.__test?.setAssemblyAnnotationLaneLimit).toBeUndefined();
    expect(target.__test?.getAssemblyAnnotationMapperPolicy).toBeUndefined();
    expect(target.__test?.getAssemblyAnnotationPolicyTransaction).toBeUndefined();
  });
});

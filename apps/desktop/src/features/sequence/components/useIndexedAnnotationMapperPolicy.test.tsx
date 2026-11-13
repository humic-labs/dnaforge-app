import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { IndexedGenomeAnnotationMapperPolicy } from './AssemblyCompiledAnnotationTrack';
import type { AssemblyCompiledBroadRasterPolicyCommitReceiptV1 } from './assembly-compiled-broad-raster-loader';
import {
  useIndexedAnnotationMapperPolicy,
  type UseIndexedAnnotationMapperPolicyOptions,
} from './useIndexedAnnotationMapperPolicy';

const CANONICAL: IndexedGenomeAnnotationMapperPolicy = {
  isoformMode: 'canonical',
  laneLimit: 12,
};
const EXPANDED: IndexedGenomeAnnotationMapperPolicy = {
  isoformMode: 'expanded',
  laneLimit: 12,
};

function compiledReceipt(
  policy: IndexedGenomeAnnotationMapperPolicy,
  policyRequestId: number
): AssemblyCompiledBroadRasterPolicyCommitReceiptV1 {
  return {
    contract: 'assembly-compiled-broad-raster-policy-commit.v1',
    identityKey: 'test-identity',
    policyRequestId,
    policy,
    surfaceManifestFingerprint: 'surface',
    catalogReceiptSha256: 'catalog',
  };
}

function renderPolicyHook(overrides: Partial<UseIndexedAnnotationMapperPolicyOptions> = {}) {
  const commitAnnotationMapperPolicy = vi.fn();
  const onAnnotationMapperPolicyPreparationRequest = vi.fn();
  let nextRequestId = 1;
  const allocateAnnotationMapperPolicyRequestId = vi.fn(() => nextRequestId++);
  const requiredTrackTypes = ['mRNA'];
  const defaults: UseIndexedAnnotationMapperPolicyOptions = {
    annotationMapperPolicy: CANONICAL,
    maxSupportedFiniteLaneLimit: 64,
    commitAnnotationMapperPolicy,
    allocateAnnotationMapperPolicyRequestId,
    onAnnotationMapperPolicyPreparationRequest,
    rendererAssemblyPresent: true,
    prepackedAnnotationSceneCacheStatus: 'hit',
    compiledBroadSurfaceEnabled: true,
    getCompiledBroadRequiredTrackTypes: () => requiredTrackTypes,
  };
  const view = renderHook(
    (props: UseIndexedAnnotationMapperPolicyOptions) => useIndexedAnnotationMapperPolicy(props),
    { initialProps: { ...defaults, ...overrides } }
  );
  return {
    ...view,
    commitAnnotationMapperPolicy,
    onAnnotationMapperPolicyPreparationRequest,
    allocateAnnotationMapperPolicyRequestId,
    requiredTrackTypes,
    defaults: { ...defaults, ...overrides },
  };
}

describe('useIndexedAnnotationMapperPolicy', () => {
  it('fails an invalid policy command without committing or preparing', () => {
    const { result, commitAnnotationMapperPolicy, onAnnotationMapperPolicyPreparationRequest } =
      renderPolicyHook();

    act(() => {
      result.current.requestAnnotationMapperPolicy({ isoformMode: 'canonical', laneLimit: 0 });
    });

    expect(result.current.annotationPolicyTransaction).toEqual({
      status: 'failed',
      request: { requestId: 1, policy: { isoformMode: 'canonical', laneLimit: 0 } },
      reason: 'invalid-policy',
    });
    expect(result.current.pendingAnnotationMapperPolicy).toBeNull();
    expect(commitAnnotationMapperPolicy).not.toHaveBeenCalled();
    expect(onAnnotationMapperPolicyPreparationRequest).not.toHaveBeenCalled();

    act(() => {
      result.current.requestAnnotationMapperPolicy({ isoformMode: 'canonical', laneLimit: 1.5 });
    });
    expect(result.current.annotationPolicyTransaction).toMatchObject({
      status: 'failed',
      reason: 'invalid-policy',
      request: { requestId: 2, policy: { isoformMode: 'canonical', laneLimit: 1.5 } },
    });
  });

  it('no-ops a same-policy command and clears a stale preparing request', () => {
    const { result, commitAnnotationMapperPolicy, onAnnotationMapperPolicyPreparationRequest } =
      renderPolicyHook();

    act(() => {
      result.current.requestAnnotationMapperPolicy(CANONICAL);
    });

    expect(result.current.annotationPolicyTransaction).toEqual({ status: 'idle' });
    expect(result.current.pendingAnnotationMapperPolicy).toBeNull();
    expect(commitAnnotationMapperPolicy).not.toHaveBeenCalled();
    expect(onAnnotationMapperPolicyPreparationRequest).not.toHaveBeenCalled();

    act(() => {
      result.current.requestAnnotationMapperPolicy(EXPANDED);
    });
    expect(result.current.pendingAnnotationMapperPolicy).toEqual({
      requestId: 2,
      policy: EXPANDED,
    });

    act(() => {
      result.current.requestAnnotationMapperPolicy(CANONICAL);
    });
    expect(result.current.annotationPolicyTransaction).toEqual({ status: 'idle' });
    expect(result.current.pendingAnnotationMapperPolicy).toBeNull();
    expect(commitAnnotationMapperPolicy).not.toHaveBeenCalled();
    expect(onAnnotationMapperPolicyPreparationRequest).toHaveBeenCalledTimes(1);
    expect(onAnnotationMapperPolicyPreparationRequest).toHaveBeenCalledWith({
      status: 'clear',
      requestId: 2,
    });
  });

  it('does not start legacy raster prepare on the compiled-broad path', () => {
    const {
      result,
      rerender,
      commitAnnotationMapperPolicy,
      onAnnotationMapperPolicyPreparationRequest,
      defaults,
    } = renderPolicyHook({
      getCompiledBroadRequiredTrackTypes: () => ['mRNA', 'gene'],
    });

    act(() => {
      result.current.requestAnnotationMapperPolicy(EXPANDED);
    });

    expect(result.current.pendingAnnotationMapperPolicy).toEqual({
      requestId: 1,
      policy: EXPANDED,
    });
    expect(onAnnotationMapperPolicyPreparationRequest).not.toHaveBeenCalled();
    expect(commitAnnotationMapperPolicy).not.toHaveBeenCalled();
    expect(result.current.isCompiledBroadPolicyReceiptBarrierTrack(1, 'mRNA')).toBe(true);
    expect(result.current.isCompiledBroadPolicyReceiptBarrierTrack(1, 'gene')).toBe(true);

    act(() => {
      result.current.acknowledgeCompiledBroadPolicyReceipt('mRNA', compiledReceipt(EXPANDED, 1));
    });
    expect(commitAnnotationMapperPolicy).not.toHaveBeenCalled();
    expect(onAnnotationMapperPolicyPreparationRequest).not.toHaveBeenCalled();

    act(() => {
      result.current.acknowledgeCompiledBroadPolicyReceipt('gene', compiledReceipt(EXPANDED, 1));
    });
    expect(commitAnnotationMapperPolicy).toHaveBeenCalledTimes(1);
    expect(commitAnnotationMapperPolicy).toHaveBeenCalledWith(EXPANDED);
    expect(onAnnotationMapperPolicyPreparationRequest).not.toHaveBeenCalled();

    rerender({
      ...defaults,
      getCompiledBroadRequiredTrackTypes: () => ['mRNA', 'gene'],
      annotationMapperPolicy: EXPANDED,
    });
    expect(result.current.annotationPolicyTransaction).toEqual({ status: 'idle' });
    expect(onAnnotationMapperPolicyPreparationRequest).toHaveBeenCalledTimes(1);
    expect(onAnnotationMapperPolicyPreparationRequest).toHaveBeenCalledWith({
      status: 'clear',
      requestId: 1,
    });
  });

  it('starts legacy raster prepare only when compiled-broad is off', () => {
    const { result, onAnnotationMapperPolicyPreparationRequest, commitAnnotationMapperPolicy } =
      renderPolicyHook({ compiledBroadSurfaceEnabled: false });

    act(() => {
      result.current.requestAnnotationMapperPolicy(EXPANDED);
    });

    expect(result.current.pendingAnnotationMapperPolicy).toEqual({
      requestId: 1,
      policy: EXPANDED,
    });
    expect(onAnnotationMapperPolicyPreparationRequest).toHaveBeenCalledTimes(1);
    expect(onAnnotationMapperPolicyPreparationRequest).toHaveBeenCalledWith({
      status: 'prepare',
      request: { requestId: 1, policy: EXPANDED },
    });
    expect(commitAnnotationMapperPolicy).not.toHaveBeenCalled();
  });

  it('All → change limit → Genes completes with the current selected set, without another acknowledgement', () => {
    const view = renderPolicyHook({
      getCompiledBroadRequiredTrackTypes: () => ['mRNA', '3UTR', '5UTR', 'region'],
    });
    act(() => view.result.current.requestAnnotationMapperPolicy(EXPANDED));
    act(() =>
      view.result.current.acknowledgeCompiledBroadPolicyReceipt(
        'mRNA',
        compiledReceipt(EXPANDED, 1)
      )
    );
    expect(view.commitAnnotationMapperPolicy).not.toHaveBeenCalled();

    view.rerender({ ...view.defaults, getCompiledBroadRequiredTrackTypes: () => ['mRNA'] });

    expect(view.commitAnnotationMapperPolicy).toHaveBeenCalledExactlyOnceWith(EXPANDED);
    expect(view.result.current.isCompiledBroadPolicyReceiptBarrierTrack(1, '3UTR')).toBe(false);
    expect(view.onAnnotationMapperPolicyPreparationRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'prepare' })
    );
  });

  it('does not accept a removed track failure before the selection effect runs', () => {
    let selected = ['mRNA', '3UTR'];
    const view = renderPolicyHook({ getCompiledBroadRequiredTrackTypes: () => selected });
    act(() => view.result.current.requestAnnotationMapperPolicy(EXPANDED));
    selected = ['mRNA'];
    expect(view.result.current.isCompiledBroadPolicyReceiptBarrierTrack(1, '3UTR')).toBe(false);
    act(() =>
      view.result.current.acknowledgeCompiledBroadPolicyReceipt(
        'mRNA',
        compiledReceipt(EXPANDED, 1)
      )
    );
    expect(view.commitAnnotationMapperPolicy).toHaveBeenCalledExactlyOnceWith(EXPANDED);
  });

  it.each(['initially empty', 'hidden while pending'])(
    '%s selection stores the preference without an impossible wait',
    (journey) => {
      const view = renderPolicyHook({
        getCompiledBroadRequiredTrackTypes: () =>
          journey === 'initially empty' ? [] : ['mRNA', '3UTR'],
      });
      act(() => view.result.current.requestAnnotationMapperPolicy(EXPANDED));
      if (journey === 'hidden while pending') {
        view.rerender({ ...view.defaults, getCompiledBroadRequiredTrackTypes: () => [] });
      }
      expect(view.commitAnnotationMapperPolicy).toHaveBeenCalledExactlyOnceWith(EXPANDED);
      expect(view.result.current.annotationPolicyTransaction.status).toBe('idle');
      expect(view.result.current.pendingAnnotationMapperPolicy).toBeNull();
      act(() =>
        view.result.current.acknowledgeCompiledBroadPolicyReceipt(
          'mRNA',
          compiledReceipt(EXPANDED, 1)
        )
      );
      expect(view.commitAnnotationMapperPolicy).toHaveBeenCalledTimes(1);
    }
  );

  it('adds newly selected tracks to the pending barrier and ignores obsolete request receipts', () => {
    const view = renderPolicyHook({ getCompiledBroadRequiredTrackTypes: () => ['mRNA', '3UTR'] });
    act(() => view.result.current.requestAnnotationMapperPolicy(EXPANDED));
    act(() =>
      view.result.current.acknowledgeCompiledBroadPolicyReceipt(
        'mRNA',
        compiledReceipt(EXPANDED, 1)
      )
    );
    view.rerender({
      ...view.defaults,
      getCompiledBroadRequiredTrackTypes: () => ['mRNA', '3UTR', '5UTR'],
    });
    act(() =>
      view.result.current.acknowledgeCompiledBroadPolicyReceipt(
        '3UTR',
        compiledReceipt(EXPANDED, 1)
      )
    );
    act(() =>
      view.result.current.acknowledgeCompiledBroadPolicyReceipt(
        '5UTR',
        compiledReceipt(EXPANDED, 0)
      )
    );
    expect(view.commitAnnotationMapperPolicy).not.toHaveBeenCalled();
    act(() =>
      view.result.current.acknowledgeCompiledBroadPolicyReceipt(
        '5UTR',
        compiledReceipt(EXPANDED, 1)
      )
    );
    expect(view.commitAnnotationMapperPolicy).toHaveBeenCalledExactlyOnceWith(EXPANDED);
  });
});

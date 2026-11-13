import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import { emptyDesignRegion } from '../design/public/assembly-slots';
import { useAssemblyJourneyTelemetry } from './hooks/useAssemblyJourneyTelemetry';
import {
  assemblyInputObservation,
  assemblyComputeContext,
  assemblyValidationErrorClass,
  discardAssemblyReopen,
  observeVisibleAssemblyReopen,
  rememberAssemblyReopen,
} from './journey-telemetry';
import type { ReopenAcceptedAssemblyResult } from './accepted-reopen-workflow';
const calls = vi.hoisted(() => ({ observe: vi.fn((_input: Record<string, unknown>) => true) }));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction: calls.observe }));
const DESIGN = '550e8400-e29b-41d4-a716-446655440101';
const CONSTRUCT = '550e8400-e29b-41d4-a716-446655440102';
const VERSION = 'accepted-local-version';
const base = {
  id: DESIGN,
  constructId: CONSTRUCT,
  parentAcceptedAssemblyVersionId: VERSION,
  regions: [{ id: 'slot', ...emptyDesignRegion('Private source label') }],
};
const result: ReopenAcceptedAssemblyResult = {
  status: 'completed',
  idempotentReplay: false,
  constructId: CONSTRUCT,
  parentAcceptedAssemblyVersionId: VERSION,
  designId: DESIGN,
  draftPath: '/private/source/.forge/draft.json',
  resourceUri: 'private:workspace',
  openTabRequired: true,
};
beforeEach(() => {
  calls.observe.mockClear();
  discardAssemblyReopen(DESIGN);
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
});
describe('assembly structural journey receipts', () => {
  it('ignores placeholder and empty templates and honors physical digest ends', () => {
    expect(assemblyComputeContext({ regions: base.regions }, 'validate')).toMatchObject({
      assemblyMaterialRoute: 'none',
      pcrTemplateCount: 0,
    });
    const template = { ...base.regions[0], isPlaceholder: false, sequence: 'ACGT' };
    const digest = { ...template, rdOverhangs: { upstream: 'AAAA', downstream: 'TTTT' } };
    expect(assemblyComputeContext({ regions: [digest] }, 'run')).toMatchObject({
      assemblyMaterialRoute: 'digest',
      pcrTemplateCount: 0,
    });
    expect(
      assemblyComputeContext(
        { regions: [digest, template, { ...template, sequence: '' }] },
        'validate'
      )
    ).toEqual({
      assemblyComputeStage: 'draft_primers',
      assemblyMaterialRoute: 'mixed',
      pcrTemplateCount: 1,
      assemblyMethod: 'unknown',
    });
    expect(
      assemblyComputeContext({ regions: [template], assemblyMethod: 'goldengate' }, 'run')
        .assemblyMethod
    ).toBe('goldengate');
    expect(
      assemblyValidationErrorClass([
        { code: 'missing_overlap', severity: 'warning' },
        { code: 'goldengate_rd_enzyme_mismatch', severity: 'error' },
      ])
    ).toBe('validation_goldengate_rd_enzyme_mismatch');
    expect(assemblyValidationErrorClass([{ code: 'Has Spaces', severity: 'error' }])).toBe(
      'validation'
    );
  });

  it('distinguishes a placeholder, one filled part and two filled parts without publishing inputs', () => {
    const filled = {
      ...base.regions[0],
      isPlaceholder: false,
      sequence: 'ACGT',
      sourceSequenceName: 'Private source label',
    };
    expect(assemblyInputObservation(base)).toMatchObject({
      resultCount: 1,
      selectedCount: 0,
      status: 'needs_action',
      outcomeKind: 'input_required',
    });
    expect(assemblyInputObservation({ ...base, regions: [filled] })).toMatchObject({
      selectedCount: 1,
      status: 'needs_action',
    });
    const ready = assemblyInputObservation({
      ...base,
      regions: [filled, { ...filled, id: 'second' }],
    });
    expect(ready).toMatchObject({
      selectedCount: 2,
      status: 'ready',
      usableResult: false,
      valueDelivered: false,
    });
    expect(JSON.stringify(ready)).not.toMatch(/ACGT|Private source label|private\/source/);
  });
  it('keeps native reconstruction pending until exact construct and accepted version are observed', () => {
    rememberAssemblyReopen(result);
    expect(calls.observe).toHaveBeenCalledOnce();
    expect(calls.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcomeKind: 'display_pending', artifactCorrelationId: CONSTRUCT })
    );
    expect(observeVisibleAssemblyReopen({ ...base, constructId: 'another-construct' })).toBe(false);
    expect(
      observeVisibleAssemblyReopen({ ...base, parentAcceptedAssemblyVersionId: 'another-version' })
    ).toBe(false);
    expect(observeVisibleAssemblyReopen(base)).toBe(true);
    expect(observeVisibleAssemblyReopen(base)).toBe(false);
    expect(calls.observe).toHaveBeenCalledTimes(2);
    expect(calls.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcomeKind: 'reopened_confirmed',
        artifactCorrelationId: CONSTRUCT,
        status: 'viewed',
      })
    );
    expect(calls.observe.mock.calls[0][0].actionId).toBe(calls.observe.mock.calls[1][0].actionId);
    expect(JSON.stringify(calls.observe.mock.calls)).not.toMatch(
      /accepted-local-version|private\/source|private:workspace/
    );
  });
  it('does not confirm an inactive editor and suppresses unchanged part snapshots', () => {
    rememberAssemblyReopen(result);
    calls.observe.mockClear();
    const hook = renderHook(({ design }) => useAssemblyJourneyTelemetry(design), {
      initialProps: { design: base },
    });
    expect(calls.observe).not.toHaveBeenCalled();
    act(() => {
      useCanvasStore
        .getState()
        .openTab('main', { type: 'design', entityId: DESIGN, label: 'Private source label' });
    });
    expect(calls.observe).toHaveBeenCalledTimes(2);
    hook.rerender({ design: { ...base } });
    expect(calls.observe).toHaveBeenCalledTimes(2);
    hook.rerender({
      design: {
        ...base,
        regions: [{ ...base.regions[0], isPlaceholder: false, sequence: 'ACGT' }],
      },
    });
    expect(calls.observe).toHaveBeenCalledTimes(3);
    expect(calls.observe).toHaveBeenLastCalledWith(expect.objectContaining({ selectedCount: 1 }));
  });
  it('does not fabricate missing lineage or a receipt after canceled presentation', () => {
    rememberAssemblyReopen({ ...result, constructId: '' });
    expect(calls.observe).not.toHaveBeenCalled();
    rememberAssemblyReopen(result);
    discardAssemblyReopen(DESIGN);
    calls.observe.mockClear();
    expect(observeVisibleAssemblyReopen(base)).toBe(false);
    expect(calls.observe).not.toHaveBeenCalled();
  });
  it('does not make analytics availability a recovery failure', () => {
    calls.observe.mockImplementationOnce(() => {
      throw new Error('Private capture detail');
    });
    expect(() => rememberAssemblyReopen(result)).not.toThrow();
    expect(observeVisibleAssemblyReopen(base)).toBe(true);
  });
});

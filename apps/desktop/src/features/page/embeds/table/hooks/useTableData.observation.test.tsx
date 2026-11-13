// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTableData } from './useTableData';
import * as formulas from '../../../../../shared/notebook-model/table/utils/formulas';
import type { TableData } from '../types';
import type { TableOperationObservation } from '../../../../../shared/table-notebook-observation';

const authority = vi.hoisted(() => ({ ready: true, supported: true, throws: false }));
vi.mock('../../../../../lib/analytics', () => ({
  isAnalyticsCaptureReady: () => authority.ready,
  captureAnalyticsOptionalOrigin: () => {
    if (authority.throws) throw new Error('synthetic optional context lookup failure');
    return authority.supported
      ? {
          consentScope: '71400000-0000-4000-8000-000000000001',
          contextId: '71400000-0000-4000-8000-000000000002',
          processId: '71400000-0000-4000-8000-000000000003',
          classification: 'synthetic',
        }
      : null;
  },
}));

beforeEach(() => {
  authority.ready = true;
  authority.supported = true;
  authority.throws = false;
});
afterEach(() => vi.restoreAllMocks());
const initial = (): TableData => ({
  cells: [
    [
      { value: '2', type: 'number' },
      { value: '=A1+1', type: 'formula', computed: -999 },
      { value: '=B1+1', type: 'formula', computed: '#ERROR' },
    ],
  ],
});

describe('owning table evaluation remains observational', () => {
  it.each(['enabled', 'disabled', 'unsupported', 'lookup_failure'] as const)(
    'performs one product evaluation per accepted revision with %s collection',
    (mode) => {
      authority.ready = mode !== 'disabled';
      authority.supported = mode !== 'unsupported';
      authority.throws = mode === 'lookup_failure';
      const evaluate = vi.spyOn(formulas, 'evaluateTableRevision');
      const writes: Array<{
        attrs: TableData;
        observation?: TableOperationObservation;
        evaluationsBeforeRender: number;
      }> = [];
      const hook = renderHook(() => {
        const [data, setData] = useState(initial);
        return useTableData({
          data,
          observationSurface: 'inline',
          onUpdateAttrs: (attrs, observation) => {
            writes.push({
              attrs: attrs as TableData,
              observation,
              evaluationsBeforeRender: evaluate.mock.calls.length,
            });
            setData(attrs as TableData);
          },
        });
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(hook.result.current.displayCells[0][2].computed).toBe(4);
      act(() => hook.result.current.updateCell(0, 0, '20'));
      expect(writes).toHaveLength(1);
      expect(writes[0].evaluationsBeforeRender).toBe(mode === 'enabled' ? 2 : 1);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(hook.result.current.displayCells[0][2].computed).toBe(22);
      expect(writes[0].attrs.cells?.[0][2]).toEqual({
        value: '=B1+1',
        type: 'formula',
        computed: '#ERROR',
      });
      if (mode === 'enabled')
        expect(writes[0].observation?.calculation).toEqual({
          result: 'evaluated',
          evaluatedCount: 2,
          errorCount: 0,
          savedCount: 0,
          staleCount: 0,
          unavailableCount: 0,
        });
      else expect(writes[0].observation).toBeUndefined();
      act(() => hook.result.current.setColumnWidth(0, 200));
      expect(evaluate).toHaveBeenCalledTimes(2);
      hook.unmount();
    }
  );

  it('discards a refused pre-evaluation, retains history for retry, and never reuses it for a replacement source', () => {
    const evaluate = vi.spyOn(formulas, 'evaluateTableRevision');
    let refuse = true;
    const hook = renderHook(
      ({ data, epoch }) =>
        useTableData({
          data,
          historyEpoch: epoch,
          observationSurface: 'expanded',
          onUpdateAttrs: () => {
            if (refuse) throw new Error('synthetic source refusal');
          },
        }),
      { initialProps: { data: initial(), epoch: 1 } }
    );
    act(() =>
      expect(() => hook.result.current.updateCell(0, 0, '20')).toThrow('synthetic source refusal')
    );
    expect(hook.result.current.displayCells[0][2].computed).toBe(4);
    expect(hook.result.current.undo()).toBeNull();
    refuse = false;
    const replacement: TableData = {
      cells: [
        [
          { value: '8', type: 'number' },
          { value: '=A1+2', type: 'formula' },
        ],
      ],
    };
    hook.rerender({ data: replacement, epoch: 2 });
    expect(hook.result.current.displayCells[0][1].computed).toBe(10);
    expect(evaluate.mock.calls.at(-1)?.[0]).toBe(replacement.cells);
    expect(hook.result.current.undo()).toBeNull();
    hook.unmount();
  });
});

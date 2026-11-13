// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStructure3dStore } from '../store';
import type { HighlightGroup } from '../types';
import { useSavedSelectionEdit } from './useSavedSelectionEdit';

describe('useSavedSelectionEdit', () => {
  beforeEach(() => {
    useStructure3dStore.setState({
      expandedStructures: {},
      interactionState: {},
      selectionAnchor: {},
      selectionRangeBase: {},
    });
  });

  it('does not let a visible saved highlight hijack active residue selection clicks', () => {
    const updateAttrs = vi.fn();
    const highlightGroups: HighlightGroup[] = [
      {
        id: 'visible-selection',
        label: 'Visible selection',
        visible: true,
        selections: [{ chain: 'A', ranges: [[1, 1]] }],
      },
    ];

    const { result } = renderHook(() =>
      useSavedSelectionEdit({
        highlightGroups,
        structureId: 'struct-1',
        updateAttrs,
      })
    );

    act(() => {
      result.current.handleResidueSelect(
        {
          chain: 'A',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: '1_555',
          position: 3,
        },
        'replace'
      );
    });

    expect(updateAttrs).not.toHaveBeenCalled();
    expect(useStructure3dStore.getState().interactionState['struct-1']?.selected).toEqual([
      {
        chain: 'A',
        baseChain: 'A',
        labelAsymId: 'A',
        authAsymId: 'H',
        entityId: '1',
        operator: '1_555',
        position: 3,
      },
    ]);
    expect(useStructure3dStore.getState().selectionAnchor['struct-1']).toEqual({
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
      operator: '1_555',
      position: 3,
    });
  });
});

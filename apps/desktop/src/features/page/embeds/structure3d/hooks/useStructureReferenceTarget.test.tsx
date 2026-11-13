// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MolstarPlugin } from '../molstar/cache';
import {
  requestStructureReferenceTarget,
  useStructureReferenceTarget,
  useStructureReferenceTargets,
} from './useStructureReferenceTarget';

const runtime = vi.hoisted(() => ({ scene: 'pinned', index: 1, focus: vi.fn(), select: vi.fn() }));
vi.mock('../molstar/molViewSpec', () => ({
  activeMolViewSpecScene: () => runtime.scene,
  activeMolViewSpecSnapshotIndex: () => runtime.index,
  sameLoadedMolViewSpecScene: (a: string, b: string) => a === b,
}));
vi.mock('../molstar/molViewSpecLegend', () => ({
  molViewSpecColorGroups: () => [{ id: 'peptide', label: 'Peptide and cap' }],
}));
vi.mock('../molstar/molViewSpecSwatchSelection', () => ({
  focusMolViewSpecColorGroup: runtime.focus,
  selectMolViewSpecColorGroup: runtime.select,
}));
vi.mock('./useHighlightActions', () => ({ residueLocationsForHighlightGroup: vi.fn() }));
vi.mock('./useResidueHighlight', () => ({ focusOnResidues: vi.fn() }));
const plugin = {} as MolstarPlugin;
beforeEach(() => {
  useStructureReferenceTargets.setState({ requests: {} });
  vi.clearAllMocks();
  runtime.scene = 'pinned';
  runtime.index = 1;
});

it('clears native legend selection when reopening the same view, after it is loaded', () => {
  const clear = vi.fn();
  requestStructureReferenceTarget('view', {
    intent: 'open-view',
    scene: 'pinned',
    snapshotIndex: 1,
  });
  const { rerender } = renderHook(
    ({ loaded }) =>
      useStructureReferenceTarget(
        'view',
        plugin,
        loaded,
        { molViewSpec: 'pinned', molViewSpecSnapshotIndex: 1 },
        [],
        clear
      ),
    { initialProps: { loaded: false } }
  );
  expect(clear).not.toHaveBeenCalled();
  rerender({ loaded: true });
  expect(clear).toHaveBeenCalledOnce();
  expect(useStructureReferenceTargets.getState().requests).toEqual({});
});

it('uses the legend Target without clearing or selecting the group again', () => {
  const clear = vi.fn();
  requestStructureReferenceTarget('view', {
    intent: 'target',
    scene: 'pinned',
    snapshotIndex: 1,
    groupId: 'peptide',
  });
  renderHook(() =>
    useStructureReferenceTarget(
      'view',
      plugin,
      true,
      { molViewSpec: 'pinned', molViewSpecSnapshotIndex: 1 },
      [],
      clear
    )
  );
  expect(runtime.focus).toHaveBeenCalledOnce();
  expect(runtime.select).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

it('cancels a pending target when the user chooses another view before loading completes', () => {
  requestStructureReferenceTarget('view', {
    intent: 'target',
    scene: 'pinned',
    snapshotIndex: 1,
    groupId: 'peptide',
  });
  renderHook(() =>
    useStructureReferenceTarget(
      'view',
      plugin,
      true,
      { molViewSpec: 'different', molViewSpecSnapshotIndex: 0 },
      [],
      vi.fn()
    )
  );
  expect(runtime.focus).not.toHaveBeenCalled();
  expect(useStructureReferenceTargets.getState().requests).toEqual({});
});

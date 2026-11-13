import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HighlightGroup, Structure3dAttrs } from '../types';

const mocks = vi.hoisted(() => ({ save: vi.fn(), rename: vi.fn() }));
vi.mock('../utils/savedSelectionPersistence', async (importOriginal) => ({
  molecularViewBinding: (
    await importOriginal<typeof import('../utils/savedSelectionPersistence')>()
  ).molecularViewBinding,
  saveStructureSelection: mocks.save,
  renameSavedSelectionRef: mocks.rename,
  saveViewBeforeSelection: vi.fn(),
  createViewForSelection: vi.fn(),
  recordSelectionInOpenViews: vi.fn(() => 0),
}));
import { useHighlightActions } from './useHighlightActions';

const oldRef = {
  selectionId: 'saved-b',
  revisionId: 'r-b',
  artifactPath: 'Selections/b.wpselection.json',
  visible: true,
};
const newRef = {
  selectionId: 'saved-a',
  revisionId: 'r-a',
  artifactPath: 'Selections/a.wpselection.json',
  visible: true,
};
const group: HighlightGroup = {
  id: 'new',
  label: 'New selection',
  selections: [{ chain: 'A', ranges: [[1, 2]] }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount() {
  return renderHook(
    ({ structureId }) => {
      const [attrs, setAttrs] = useState<Structure3dAttrs>({
        source: 'pdb',
        sourceId: '1FS0',
        label: '1FS0',
        molecularDocumentPath: '/project/1FS0.dnaforge-molecular.json',
        savedSelectionRefs: [oldRef],
      });
      const actions = useHighlightActions({
        attrs,
        structureId,
        structureViewId: structureId,
        workspaceRoot: '/project',
        highlightGroups: [],
        chains: [],
        savedSelectionRefs: attrs.savedSelectionRefs,
        updateAttrs: (changes) => setAttrs((current) => ({ ...current, ...changes })),
      });
      return { ...actions, attrs };
    },
    { initialProps: { structureId: 'view-1' } }
  );
}
beforeEach(() => vi.clearAllMocks());

it('does not resurrect a reference deleted while another selection is saving', async () => {
  const save = deferred<{ ref: typeof newRef }>();
  mocks.save.mockReturnValue(save.promise);
  const hook = mount();
  let saving!: Promise<void>;
  act(() => {
    saving = hook.result.current.handleSaveSelection(group);
  });
  act(() => hook.result.current.handleDeleteHighlight(oldRef.selectionId));
  expect(hook.result.current.attrs.savedSelectionRefs).toEqual([]);
  await act(async () => {
    save.resolve({ ref: newRef });
    await saving;
  });
  expect(hook.result.current.attrs.savedSelectionRefs).toEqual([newRef]);
});

it('retains both selections when their saves finish in the same render turn', async () => {
  const first = deferred<{ ref: typeof newRef }>();
  const second = deferred<{ ref: typeof newRef }>();
  const otherRef = { ...newRef, selectionId: 'saved-c' };
  mocks.save.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const hook = mount();
  let saves!: Promise<void>[];
  act(() => {
    saves = [
      hook.result.current.handleSaveSelection(group),
      hook.result.current.handleSaveSelection({ ...group, id: 'other' }),
    ];
  });
  await act(async () => {
    first.resolve({ ref: newRef });
    second.resolve({ ref: otherRef });
    await Promise.all(saves);
  });
  expect(hook.result.current.attrs.savedSelectionRefs).toEqual([oldRef, newRef, otherRef]);
});

it('does not restore a deleted selection when its rename completes', async () => {
  const rename = deferred<{ ref: typeof oldRef }>();
  mocks.rename.mockReturnValue(rename.promise);
  const hook = mount();
  let renaming!: Promise<void>;
  act(() => {
    renaming = hook.result.current.handleRenameHighlight(oldRef.selectionId, 'Renamed');
  });
  act(() => hook.result.current.handleDeleteHighlight(oldRef.selectionId));
  await act(async () => {
    rename.resolve({ ref: { ...oldRef, revisionId: 'renamed' } });
    await renaming;
  });
  expect(hook.result.current.attrs.savedSelectionRefs).toEqual([]);
});

it('retires the old view save when the hook changes structure identity', async () => {
  const save = deferred<{ ref: typeof newRef }>();
  mocks.save.mockReturnValue(save.promise);
  const hook = mount();
  let saving!: Promise<void>;
  act(() => {
    saving = hook.result.current.handleSaveSelection(group);
  });
  hook.rerender({ structureId: 'view-2' });
  await act(async () => {
    save.resolve({ ref: newRef });
    await saving;
  });
  expect(hook.result.current.attrs.savedSelectionRefs).toEqual([oldRef]);
});

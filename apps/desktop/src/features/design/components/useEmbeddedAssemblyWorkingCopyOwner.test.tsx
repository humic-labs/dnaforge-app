import { documentLifecycle } from '../../../shared/document-lifecycle';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../../canvas/public/types';
import {
  acceptDesignArtifact,
  confirmDesignArtifactPublication,
  useDesignRecoveryStore,
} from '../design-recovery';
import { useEmbeddedAssemblyWorkingCopyOwner } from './useEmbeddedAssemblyWorkingCopyOwner';
import { getWorkspaceEditorBlockers } from '../../../services/workspace-editor-mutation-state';

const h = vi.hoisted(() => ({
  design: { id: 'copy-1', name: 'First', constructId: 'package-1' },
  updateTab: vi.fn(),
  drain: vi.fn(),
  toast: vi.fn(),
  pendingMirror: false,
}));
vi.mock('../store', () => ({
  useDesignStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ designs: { 'copy-1': h.design } }),
    { getState: () => ({ designs: { 'copy-1': h.design } }) }
  ),
}));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ updateTab: h.updateTab }),
    { getState: () => ({ panels: { main: { id: 'main', tabs: [tab] } }, updateTab: h.updateTab }) }
  ),
}));
vi.mock('../design-artifact-mirror', () => ({
  drainDesignArtifactMirrors: h.drain,
  hasPendingDesignArtifactMirror: () => h.pendingMirror,
}));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: h.toast }) },
}));

const tab: Tab = {
  id: 'tab-1',
  type: 'sequence',
  entityId: 'package-1',
  label: 'Example',
  isDirty: false,
  assemblyEditDesignId: 'copy-1',
  sequenceDocument: {
    kind: 'managed-sequence',
    packageId: 'package-1',
    packageRoot: '/workspace/sample.seqpkg',
  },
};

describe('embedded assembly working-copy owner', () => {
  beforeEach(() => {
    h.design = { id: 'copy-1', name: 'First', constructId: 'package-1' };
    h.updateTab.mockReset();
    h.drain.mockReset();
    h.toast.mockReset();
    h.pendingMirror = false;
    localStorage.clear();
    useDesignRecoveryStore.setState({ records: {} });
    acceptDesignArtifact(h.design as never);
  });

  it('marks the one outer sequence tab dirty and saves that tab target through the package mirror', async () => {
    const onExitToSequence = vi.fn();
    const { rerender } = renderHook(() =>
      useEmbeddedAssemblyWorkingCopyOwner({
        designId: 'copy-1',
        tab,
        panelId: 'main',
        onExitToSequence,
      })
    );
    expect(h.updateTab).not.toHaveBeenCalled();
    h.design = { ...h.design, name: 'Edited' };
    rerender();
    expect(h.updateTab).toHaveBeenCalledWith('main', 'tab-1', { isDirty: true });
    expect(
      getWorkspaceEditorBlockers({
        workspaceRoot: '/workspace/sample.seqpkg',
        affectedEntityIds: ['package-1'],
      }).some((editor) => editor.entityId === 'package-1' && editor.state === 'dirty')
    ).toBe(true);
    h.drain.mockImplementation(async () => {
      confirmDesignArtifactPublication(h.design as never);
    });
    await act(async () => {
      expect(
        await documentLifecycle.save({ kind: 'sequence-document', documentId: 'package-1' }, tab.id)
      ).toBe(true);
    });
    expect(h.drain).toHaveBeenCalledWith(['copy-1']);
    expect(onExitToSequence).not.toHaveBeenCalled();
  });

  it('keeps the same tab in assembly edit if package-member saving fails', async () => {
    const onExitToSequence = vi.fn();
    h.design = { ...h.design, name: 'Edited' };
    h.drain.mockRejectedValue(new Error('Member unavailable'));
    const { result } = renderHook(() =>
      useEmbeddedAssemblyWorkingCopyOwner({
        designId: 'copy-1',
        tab,
        panelId: 'main',
        onExitToSequence,
      })
    );
    act(() => result.current.exitToSequence?.());
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(onExitToSequence).not.toHaveBeenCalled();
  });

  it('reports an in-flight member save to the shared workspace editor guard', async () => {
    let finishSave: (() => void) | undefined;
    h.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            confirmDesignArtifactPublication(h.design as never);
            resolve();
          };
        })
    );
    renderHook(() =>
      useEmbeddedAssemblyWorkingCopyOwner({
        designId: 'copy-1',
        tab,
        panelId: 'main',
        onExitToSequence: vi.fn(),
      })
    );
    act(() => {
      void documentLifecycle.save({ kind: 'sequence-document', documentId: 'package-1' }, tab.id);
    });
    expect(
      getWorkspaceEditorBlockers({
        workspaceRoot: '/workspace/sample.seqpkg',
        affectedEntityIds: ['package-1'],
      }).some((editor) => editor.state === 'saving')
    ).toBe(true);
    await act(async () => finishSave?.());
    await waitFor(() =>
      expect(
        getWorkspaceEditorBlockers({
          workspaceRoot: '/workspace/sample.seqpkg',
          affectedEntityIds: ['package-1'],
        }).every((editor) => editor.state === 'clean')
      ).toBe(true)
    );
  });
});

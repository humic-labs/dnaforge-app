import 'fake-indexeddb/auto';
import {
  flushPendingUnsavedDraftWrites,
  readUnsavedDraft,
} from '../../../shared/unsaved-draft-recovery';
import { documentLifecycle } from '../../../shared/document-lifecycle';
import { expectToastCall } from '../../../test/toast-assertions';
/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateTab: vi.fn(),
  retargetTab: vi.fn(),
  closeTab: vi.fn(),
  recordProtein: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../canvas/store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ updateTab: mocks.updateTab, closeTab: mocks.closeTab }),
    {
      getState: () => ({
        panels: {},
        updateTab: mocks.updateTab,
        retargetTab: mocks.retargetTab,
      }),
    }
  ),
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ folders: [{ path: '/workspace', name: 'Workspace', addedAt: 1 }] }),
}));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));
vi.mock('../../sequence/components/SequenceDrawer', () => ({
  SequenceDrawer: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));
vi.mock('./ProteinSaveLocationPicker', () => ({
  ProteinSaveLocationPicker: () => <div data-testid="mock-protein-location">/workspace/lab</div>,
}));
vi.mock('../record-proteins', () => ({ recordProtein: mocks.recordProtein }));

import type { Tab } from '../../canvas/types';
import { ProteinCreationTab } from './ProteinCreationTab';

const tab: Tab = {
  id: 'tab-protein-draft',
  type: 'protein',
  entityId: 'protein-draft:1',
  label: 'Untitled Protein',
  artifactDocument: {
    kind: 'protein',
    persistence: 'draft',
    workspaceRoot: '/workspace',
    destinationPath: '/workspace/lab',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordProtein.mockResolvedValue({
    artifactPath: 'lab/GFP.entity.json',
    limsEntity: { id: 'protein-1', name: 'GFP' },
    gitCommitted: true,
  });
});

afterEach(cleanup);

describe('ProteinCreationTab', () => {
  it.each([true, false])(
    'retires the recovery copy only when close-save publication succeeds=%s',
    async (success) => {
      if (!success) mocks.recordProtein.mockRejectedValueOnce(new Error('controlled refusal'));
      render(<ProteinCreationTab tab={tab} panelId="panel-1" />);
      fireEvent.change(screen.getByTestId('protein-draft-name'), { target: { value: 'GFP' } });
      fireEvent.change(screen.getByTestId('protein-draft-sequence'), {
        target: { value: 'MSKX*' },
      });
      expect(documentLifecycle.dirty({ kind: 'tab', tabId: tab.id }, tab.id)).toBe(true);
      const key = `new:${tab.id}`;
      await flushPendingUnsavedDraftWrites([key]);
      const unsaved = await readUnsavedDraft(key);
      expect(unsaved).toBeDefined();
      await act(async () => {
        expect(await documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id)).toBe(success);
      });
      expect(await readUnsavedDraft(key)).toEqual(success ? undefined : unsaved);
    }
  );

  it('keeps later edits and their recovery copy when an earlier publication finishes', async () => {
    const publication = Promise.withResolvers<{
      artifactPath: string;
      limsEntity: { id: string; name: string };
    }>();
    mocks.recordProtein.mockReturnValueOnce(publication.promise);
    render(<ProteinCreationTab tab={tab} panelId="panel-1" />);
    const name = screen.getByTestId('protein-draft-name');
    fireEvent.change(name, { target: { value: 'First name' } });
    fireEvent.change(screen.getByTestId('protein-draft-sequence'), {
      target: { value: 'MPEPTIDE' },
    });
    const target = { kind: 'tab', tabId: tab.id } as const;
    const key = `new:${tab.id}`;
    const saving = documentLifecycle.save(target, tab.id);
    fireEvent.change(name, { target: { value: 'Newer name' } });
    publication.resolve({
      artifactPath: 'first.entity.json',
      limsEntity: { id: 'first', name: 'First name' },
    });
    await act(async () => expect(await saving).toBe(false));
    await flushPendingUnsavedDraftWrites([key]);
    expect(mocks.retargetTab).not.toHaveBeenCalled();
    expect(documentLifecycle.dirty(target, tab.id)).toBe(true);
    expect(await readUnsavedDraft(key)).toMatchObject({
      payload: { fields: { name: 'Newer name' } },
    });
  });

  it('keeps Save disabled until both a name and valid protein sequence exist', () => {
    render(<ProteinCreationTab tab={tab} panelId="panel-1" />);
    const save = screen.getByTestId('protein-draft-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('protein-draft-name'), { target: { value: 'GFP' } });
    fireEvent.change(screen.getByTestId('protein-draft-sequence'), {
      target: { value: 'MSKX*' },
    });
    expect(save.disabled).toBe(false);
  });

  it('syncs the tab label while naming the draft', () => {
    render(<ProteinCreationTab tab={tab} panelId="panel-1" />);
    fireEvent.change(screen.getByTestId('protein-draft-name'), { target: { value: 'GFP' } });
    expect(mocks.updateTab).toHaveBeenCalledWith('panel-1', tab.id, {
      label: 'GFP',
    });
  });

  it('saves through the shared package writer and turns the draft into the protein entity tab', async () => {
    const changed = vi.fn();
    window.addEventListener('waypoint:workspace-files-changed', changed, { once: true });
    render(<ProteinCreationTab tab={tab} panelId="panel-1" />);

    fireEvent.change(screen.getByTestId('protein-draft-name'), { target: { value: 'GFP' } });
    fireEvent.change(screen.getByTestId('protein-draft-sequence'), {
      target: { value: 'msk x*' },
    });
    fireEvent.click(screen.getByTestId('protein-draft-save'));

    await waitFor(() =>
      expect(mocks.recordProtein).toHaveBeenCalledWith({
        name: 'GFP',
        sequence: 'MSKX*',
        workspaceRoot: '/workspace',
        dir: '/workspace/lab',
        organism: undefined,
        sourceCds: undefined,
        notes: undefined,
      })
    );
    await waitFor(() =>
      expect(mocks.retargetTab).toHaveBeenCalledWith(
        'panel-1',
        tab.id,
        { type: 'protein', entityId: 'protein-1' },
        { label: 'GFP', artifactDocument: undefined, isDirty: false }
      )
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expectToastCall(mocks.addToast, 'Created protein GFP.', 'success');
  });
});

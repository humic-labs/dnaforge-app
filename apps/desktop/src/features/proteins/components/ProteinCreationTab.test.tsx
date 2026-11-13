import { documentLifecycle } from '../../../shared/document-lifecycle';
import { expectToastCall } from '../../../test/toast-assertions';
/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateTab: vi.fn(),
  closeTab: vi.fn(),
  recordProtein: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../canvas/store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ updateTab: mocks.updateTab, closeTab: mocks.closeTab }),
    { getState: () => ({ panels: {}, updateTab: mocks.updateTab }) }
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
    'correlates the close-save result when publication succeeds=%s',
    async (success) => {
      if (!success) mocks.recordProtein.mockRejectedValueOnce(new Error('controlled refusal'));
      render(<ProteinCreationTab tab={tab} panelId="panel-1" />);
      fireEvent.change(screen.getByTestId('protein-draft-name'), { target: { value: 'GFP' } });
      fireEvent.change(screen.getByTestId('protein-draft-sequence'), {
        target: { value: 'MSKX*' },
      });
      expect(documentLifecycle.dirty({ kind: 'tab', tabId: tab.id }, tab.id)).toBe(true);
      await act(async () => {
        expect(await documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id)).toBe(success);
      });
    }
  );

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
    expect(mocks.updateTab).toHaveBeenCalledWith('panel-1', tab.id, {
      entityId: 'protein-1',
      label: 'GFP',
      artifactDocument: undefined,
      isDirty: false,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expectToastCall(mocks.addToast, 'Created protein GFP.', 'success');
  });
});

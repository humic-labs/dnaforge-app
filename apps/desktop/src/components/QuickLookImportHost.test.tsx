import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../features/canvas/store';
import { useSequenceStore } from '../features/sequence/store';
import { useToastStore } from '../stores/toast-store';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { QuickLookPackageReceipt } from '../shared/file-association-ipc';
import { useQuickLookImportStore } from '../stores/quick-look-import-store';

const mocks = vi.hoisted(() => ({
  createEmptyWorkspace: vi.fn(),
  findByMemberPath: vi.fn(),
  savePreview: vi.fn(),
  readDir: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    fs: { readDir: mocks.readDir },
    fileAssociations: {
      savePreview: mocks.savePreview,
      adoptPreview: async ({ receipt }: { receipt: QuickLookPackageReceipt }) => ({
        ...receipt,
        packageId: 'preview',
        version: 1,
        sequence: receipt,
      }),
      syncPreviewTabs: vi.fn(),
      releasePreview: vi.fn(),
    },
    workspace: {
      createEmptyWorkspace: mocks.createEmptyWorkspace,
    },
  }),
}));

vi.mock('../features/sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: {
    findByMemberPath: mocks.findByMemberPath,
  },
}));

import { QuickLookImportHost } from './QuickLookImportHost';

const receipt: QuickLookPackageReceipt = {
  sourcePath: '/Users/scientist/Downloads/pUC19.gb',
  sourceFileName: 'pUC19.gb',
  familyId: 'genbank',
  contentHash: 'abc123',
  packageRoot: '/cache/generation/package',
  productPath: '/cache/generation/package/pUC19.gb',
  records: [
    {
      recordId: 'record-puc19',
      ordinal: 0,
      displayName: 'pUC19',
      sequenceLength: 2686,
      circular: true,
      productPath: '/cache/generation/package/pUC19.gb',
    },
  ],
};

const durableProductPath = '/workspace/pUC19/pUC19.gb';
const quickLookDocument = {
  kind: 'managed-sequence',
  packageId: 'quick-look-puc19',
  packageRoot: receipt.packageRoot,
} as const;
const promotedDocument = {
  kind: 'managed-sequence',
  packageId: quickLookDocument.packageId,
  packageRoot: '/workspace/pUC19',
} as const;
const onDestinationCommit = vi.fn();

function seedQuickLookTab(): void {
  useCanvasStore.setState({
    panels: {
      main: {
        id: 'main',
        activeTabId: 'quick-look-tab',
        tabs: [
          {
            id: 'quick-look-tab',
            type: 'sequence',
            entityId: quickLookDocument.packageId,
            label: receipt.sourceFileName,
            readOnly: true,
            quickLookSource: receipt,
            sequenceDocument: quickLookDocument,
            loadStatus: 'loaded',
          },
        ],
      },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
    oversizeScanComplete: true,
  });
}

describe('QuickLookImportHost', () => {
  beforeEach(() => {
    mocks.createEmptyWorkspace.mockReset();
    mocks.findByMemberPath.mockReset();
    mocks.savePreview.mockReset();
    mocks.readDir.mockReset();
    mocks.readDir.mockResolvedValue([]);
    onDestinationCommit.mockReset();
    onDestinationCommit.mockResolvedValue(undefined);
    mocks.createEmptyWorkspace.mockResolvedValue({
      rootPath: '/managed/pUC19',
      displayName: 'pUC19',
      createdAt: 1,
    });
    mocks.savePreview.mockResolvedValue({
      destPath: durableProductPath,
      relPath: 'pUC19/pUC19.gb',
      committed: true,
      workspaceRoot: '/workspace',
      createdNewWorkspace: false,
      createdWorkspaceName: null,
      records: [
        {
          recordId: receipt.records[0].recordId,
          destPath: durableProductPath,
          relPath: 'pUC19/pUC19.gb',
        },
      ],
    });
    mocks.findByMemberPath.mockResolvedValue({
      ref: promotedDocument,
      document: { name: 'pUC19' },
      productPath: durableProductPath,
    });
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace', name: 'Research', addedAt: 1 }],
      activeWorkspaceFile: null,
      expandedPaths: new Set(),
      selectedPath: null,
      isLoading: false,
      error: null,
    });
    useSequenceStore.getState().clearAll();
    useQuickLookImportStore.setState({ request: null, durablePromotion: null });
    useToastStore.getState().clearToasts();
    seedQuickLookTab();
  });

  afterEach(() => {
    act(() => {
      useQuickLookImportStore.setState({ request: null, durablePromotion: null });
      useToastStore.getState().clearToasts();
    });
  });

  it('imports the cached snapshot and makes the same tab editable in an existing workspace', async () => {
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);

    expect(screen.queryByTestId('dest-registry')).toBeNull();
    fireEvent.click(screen.getByText('Research'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));

    await waitFor(() => expect(screen.queryByTestId('quick-look-import-dialog')).toBeNull());
    expect(mocks.savePreview).toHaveBeenCalledWith({
      receipt: expect.objectContaining({ packageId: 'preview', sequence: receipt }),
      destination: { kind: 'existing-workspace', rootPath: '/workspace' },
    });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([
      expect.objectContaining({
        id: 'quick-look-tab',
        entityId: promotedDocument.packageId,
        sequenceDocument: promotedDocument,
        label: 'pUC19',
        readOnly: false,
        quickLookSource: undefined,
        sourceFileName: undefined,
      }),
    ]);
    expect(onDestinationCommit).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      createdNewWorkspace: false,
      createdWorkspaceName: null,
      revealPath: durableProductPath,
    });
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      type: 'success',
      message: 'Imported “pUC19.gb” to edit.',
    });
  });

  it('can create a destination workspace without depending on a current project', async () => {
    const managedProductPath = '/managed/pUC19/pUC19/pUC19.gb';
    mocks.savePreview.mockResolvedValueOnce({
      destPath: managedProductPath,
      relPath: 'pUC19/pUC19.gb',
      committed: true,
      workspaceRoot: '/managed/pUC19',
      createdNewWorkspace: true,
      createdWorkspaceName: 'pUC19',
      records: [
        {
          recordId: receipt.records[0].recordId,
          destPath: managedProductPath,
          relPath: 'pUC19/pUC19.gb',
        },
      ],
    });
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);

    fireEvent.click(screen.getByTestId('dest-new-workspace'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));

    await waitFor(() => expect(screen.queryByTestId('quick-look-import-dialog')).toBeNull());
    expect(mocks.savePreview).toHaveBeenCalledWith({
      receipt: expect.objectContaining({ packageId: 'preview', sequence: receipt }),
      destination: { kind: 'new-workspace', name: 'pUC19' },
    });
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      id: 'quick-look-tab',
      entityId: promotedDocument.packageId,
      sequenceDocument: promotedDocument,
      readOnly: false,
    });
    expect(onDestinationCommit).toHaveBeenCalledWith({
      workspaceRoot: '/managed/pUC19',
      createdNewWorkspace: true,
      createdWorkspaceName: 'pUC19',
      revealPath: managedProductPath,
    });
  });

  it('keeps the Quick Look tab read-only when the managed import fails', async () => {
    let rejectImport: ((error: Error) => void) | null = null;
    mocks.savePreview.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectImport = reject;
        })
    );
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);

    fireEvent.click(screen.getByText('Research'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));
    await waitFor(() => expect(rejectImport).not.toBeNull());
    await act(async () => {
      rejectImport?.(new Error('disk full'));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        type: 'error',
        message: userMessage('operation.failed'),
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('quick-look-import-confirm')).toHaveTextContent('Import')
    );
    expect(screen.getByTestId('quick-look-import-dialog')).toBeTruthy();
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      id: 'quick-look-tab',
      entityId: quickLookDocument.packageId,
      sequenceDocument: quickLookDocument,
      readOnly: true,
      quickLookSource: receipt,
    });
    expect(onDestinationCommit).not.toHaveBeenCalled();
  });

  it('reuses a durable promotion when destination reconciliation is retried', async () => {
    onDestinationCommit.mockRejectedValueOnce(new Error('workspace reconcile failed'));
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);

    fireEvent.click(screen.getByText('Research'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        type: 'error',
        message: expect.stringContaining(
          'Imported “pUC19.gb” to /workspace/pUC19/pUC19.gb, but DNAForge could not open the destination'
        ),
      })
    );
    expect(screen.getByTestId('quick-look-import-dialog')).toBeTruthy();
    expect(screen.getByTestId('quick-look-import-saved')).toHaveTextContent(
      'DNAForge will not import or copy it again'
    );
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      id: 'quick-look-tab',
      entityId: quickLookDocument.packageId,
      sequenceDocument: quickLookDocument,
      readOnly: true,
      quickLookSource: receipt,
    });

    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));

    await waitFor(() => expect(screen.queryByTestId('quick-look-import-dialog')).toBeNull());
    expect(mocks.savePreview).toHaveBeenCalledTimes(1);
    expect(onDestinationCommit).toHaveBeenCalledTimes(2);
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      entityId: promotedDocument.packageId,
      sequenceDocument: promotedDocument,
      readOnly: false,
    });
  });

  it('retries a new-workspace promotion through the main-owned compensating lifecycle', async () => {
    mocks.savePreview.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({
      destPath: '/managed/pUC19/pUC19/pUC19.gb',
      relPath: 'pUC19/pUC19.gb',
      committed: true,
      workspaceRoot: '/managed/pUC19',
      createdNewWorkspace: true,
      createdWorkspaceName: 'pUC19',
      records: [
        {
          recordId: receipt.records[0].recordId,
          destPath: '/managed/pUC19/pUC19/pUC19.gb',
          relPath: 'pUC19/pUC19.gb',
        },
      ],
    });
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);

    fireEvent.click(screen.getByTestId('dest-new-workspace'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('quick-look-import-confirm')).toHaveTextContent('Import')
    );
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));

    await waitFor(() => expect(screen.queryByTestId('quick-look-import-dialog')).toBeNull());
    expect(mocks.savePreview).toHaveBeenCalledTimes(2);
    expect(mocks.savePreview).toHaveBeenLastCalledWith({
      receipt: expect.objectContaining({ packageId: 'preview', sequence: receipt }),
      destination: { kind: 'new-workspace', name: 'pUC19' },
    });
  });
});

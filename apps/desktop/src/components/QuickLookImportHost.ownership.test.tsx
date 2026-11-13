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
  promoteQuickLookPackage: vi.fn(),
  readDir: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: () => ({
    fs: { readDir: mocks.readDir },
    fileAssociations: {
      promoteQuickLookPackage: mocks.promoteQuickLookPackage,
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
    mocks.promoteQuickLookPackage.mockReset();
    mocks.readDir.mockReset();
    mocks.readDir.mockResolvedValue([]);
    onDestinationCommit.mockReset();
    onDestinationCommit.mockResolvedValue(undefined);
    mocks.createEmptyWorkspace.mockResolvedValue({
      rootPath: '/managed/pUC19',
      displayName: 'pUC19',
      createdAt: 1,
    });
    mocks.promoteQuickLookPackage.mockResolvedValue({
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

  it('late promotion completion cannot dismiss a replacement import request', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof mocks.promoteQuickLookPackage>>) => void;
    const result = await mocks.promoteQuickLookPackage();
    mocks.promoteQuickLookPackage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);
    fireEvent.click(screen.getByText('Research'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));
    const replacement = {
      ...receipt,
      sourcePath: '/different.gb',
      contentHash: 'other',
      sourceFileName: 'different.gb',
    };
    act(() => useQuickLookImportStore.getState().open(replacement));
    await act(async () => resolve(result));
    expect(useQuickLookImportStore.getState().request).toBe(replacement);
    expect(screen.getByTestId('quick-look-import-dialog')).toBeTruthy();
  });

  it('retired promotion cannot overwrite the replacement request recovery state', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof mocks.promoteQuickLookPackage>>) => void;
    const result = await mocks.promoteQuickLookPackage();
    mocks.promoteQuickLookPackage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    useQuickLookImportStore.getState().open(receipt);
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);
    fireEvent.click(screen.getByText('Research'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));
    const replacement = {
      ...receipt,
      sourcePath: '/different.gb',
      contentHash: 'other',
      sourceFileName: 'different.gb',
    };
    act(() => useQuickLookImportStore.getState().open(replacement));
    const replacementResult = { ...result, destPath: '/workspace/different.gb' };
    act(() => useQuickLookImportStore.getState().rememberPromotion(replacement, replacementResult));
    await act(async () => resolve(result));
    expect(useQuickLookImportStore.getState().durablePromotion).toMatchObject({
      sourcePath: replacement.sourcePath,
      result: replacementResult,
    });
  });
  it('a saved import remains retryable when its dialog unmounts during native promotion', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof mocks.promoteQuickLookPackage>>) => void;
    const result = await mocks.promoteQuickLookPackage();
    mocks.promoteQuickLookPackage.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    useQuickLookImportStore.getState().open(receipt);
    const first = render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);
    fireEvent.click(screen.getByText('Research'));
    fireEvent.click(screen.getByTestId('quick-look-import-confirm'));
    first.unmount();
    await act(async () => resolve(result));
    render(<QuickLookImportHost onDestinationCommit={onDestinationCommit} />);
    expect(screen.getByTestId('quick-look-import-confirm')).toBeEnabled();
    expect(screen.getByTestId('quick-look-import-saved')).toBeTruthy();
  });
});

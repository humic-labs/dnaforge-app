import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { WorkspaceSyncStatus } from '../../shared/cloud-sync-status';
import type { WorkspaceSyncUploadPreviewOk } from '../../shared/workspace-sync-ipc';
import type { WorkspaceSyncDisplay } from './workspace-sync-display';
import { CloudWorkspacePanel } from './CloudWorkspacePanel';

function status(overrides: Partial<WorkspaceSyncStatus> = {}): WorkspaceSyncStatus {
  return {
    workspaceUuid: 'repo-uuid-a',
    syncAxis: 'idle_synced',
    bufferAxis: 'clean',
    canDisplayPlainSynced: true,
    blockers: [],
    excludedAuthoritativeState: [],
    excludedSummary: null,
    terminalErrorCode: null,
    terminalErrorMessage: null,
    ...overrides,
  } as WorkspaceSyncStatus;
}

function display(overrides: Partial<WorkspaceSyncDisplay> = {}): WorkspaceSyncDisplay {
  return {
    label: 'Up to date',
    detail: 'Eligible design files match the latest cloud version.',
    scopeDetail: null,
    exclusionDetail: null,
    tone: 'success',
    canForceSync: true,
    canCopyShareLink: true,
    canEnableSync: false,
    canDeleteCloudCopy: true,
    ...overrides,
  };
}

const PREVIEW: WorkspaceSyncUploadPreviewOk = {
  ok: true,
  workspaceUuid: 'repo-uuid-a',
  includedFiles: [
    { relativePath: 'plasmid.gb', name: 'plasmid.gb', kind: 'genbank', sizeBytes: 128 },
  ],
  includedFileCount: 1,
  includedBytes: 128,
  excludedSummary: { ignoredCount: 0 },
  limits: { maxFileBytes: 32 * 1024 * 1024, maxBundleBytes: 256 * 1024 * 1024, maxFiles: 2000 },
};

function baseProps() {
  return {
    syncStatus: status(),
    syncWorkspaceUuid: 'repo-uuid-a' as string | null,
    syncDisplay: display(),
    syncBusy: null,
    commandInFlight: false,
    uploadPreview: null as WorkspaceSyncUploadPreviewOk | null,
    uploadPreviewError: null as string | null,
    onRunAction: vi.fn(),
    onResolveConflict: vi.fn(),
  };
}

beforeEach(() => cleanup());

it('offers scientific recovery only for a complete scientific receipt and shares the cloud command lock', () => {
  const onRecover = vi.fn();
  const props = baseProps();
  const receipt = {
    representation: 'scientific_manifest_v1' as const,
    candidateId: '31da3243-0000-4000-8000-000000000003',
    localHeadSha: 'a'.repeat(40),
    contentSha256: 'b'.repeat(64),
    coverage: 'captured-bytes' as const,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const view = render(
    <CloudWorkspacePanel
      {...props}
      syncStatus={status({ recoveryCandidate: receipt })}
      onRecoverScientificDrafts={onRecover}
    />
  );
  fireEvent.click(screen.getByTestId('recover-scientific-drafts'));
  expect(onRecover).toHaveBeenCalledTimes(1);
  view.rerender(
    <CloudWorkspacePanel
      {...props}
      commandInFlight
      syncStatus={status({ recoveryCandidate: receipt })}
      onRecoverScientificDrafts={onRecover}
    />
  );
  fireEvent.click(screen.getByTestId('recover-scientific-drafts'));
  expect(onRecover).toHaveBeenCalledTimes(1);
  view.rerender(
    <CloudWorkspacePanel
      {...props}
      syncStatus={status({ recoveryCandidate: { ...receipt, representation: undefined } })}
      onRecoverScientificDrafts={onRecover}
    />
  );
  expect(screen.queryByTestId('recover-scientific-drafts')).toBeNull();
});

describe('CloudWorkspacePanel', () => {
  it('renders the status badge label and exposes the sync axis for probes', () => {
    render(
      <CloudWorkspacePanel {...baseProps()} syncStatus={status({ syncAxis: 'idle_synced' })} />
    );
    const box = screen.getByTestId('account-sync-status');
    expect(box.getAttribute('data-sync-axis')).toBe('idle_synced');
    expect(screen.getByText('This project')).toBeTruthy();
    expect(screen.getByText('Up to date')).toBeTruthy();
  });

  it('renders detail and exclusion copy when present', () => {
    render(
      <CloudWorkspacePanel
        {...baseProps()}
        syncDisplay={display({ exclusionDetail: 'Left local: 2 raw/sequencing.' })}
      />
    );
    expect(screen.getByText('Eligible design files match the latest cloud version.')).toBeTruthy();
    expect(screen.getByTestId('account-cloud-backup-exclusions').textContent).toContain(
      'Left local: 2 raw/sequencing.'
    );
  });

  it('renders the upload preview file list when a preview is loaded', () => {
    render(<CloudWorkspacePanel {...baseProps()} uploadPreview={PREVIEW} />);
    const preview = screen.getByTestId('account-cloud-backup-preview');
    expect(preview.textContent).toContain('Will upload (1 file, 128 B)');
    expect(preview.textContent).toContain('plasmid.gb');
  });

  it('lists every previewed file instead of a 12-file cap', () => {
    const manyFiles = {
      ...PREVIEW,
      includedFileCount: 20,
      includedBytes: 2560,
      includedFiles: Array.from({ length: 20 }, (_, i) => ({
        relativePath: `designs/file-${i}.gb`,
        name: `file-${i}.gb`,
        kind: 'genbank' as const,
        sizeBytes: 128,
      })),
    };
    render(<CloudWorkspacePanel {...baseProps()} uploadPreview={manyFiles} />);
    const preview = screen.getByTestId('account-cloud-backup-preview');
    expect(preview.textContent).toContain('Will upload (20 files, 2.5 KB)');
    expect(preview.textContent).toContain('designs/file-0.gb');
    expect(preview.textContent).toContain('designs/file-19.gb');
    expect(preview.textContent).not.toContain('more');
  });

  it('shows the preview error over the file list', () => {
    render(<CloudWorkspacePanel {...baseProps()} uploadPreviewError="nope" />);
    expect(screen.getByTestId('account-cloud-backup-preview').textContent).toContain(
      userMessage('account.failed')
    );
  });

  it('hides the preview block entirely when there is no managed repo uuid', () => {
    render(<CloudWorkspacePanel {...baseProps()} syncWorkspaceUuid={null} />);
    expect(screen.queryByTestId('account-cloud-backup-preview')).toBeNull();
  });

  it('renders the four-action grid off-conflict and fires onRunAction', () => {
    const onRunAction = vi.fn();
    render(<CloudWorkspacePanel {...baseProps()} onRunAction={onRunAction} />);
    expect(screen.queryByTestId('account-resolve-keep-local')).toBeNull();
    fireEvent.click(screen.getByTestId('account-sync-now'));
    fireEvent.click(screen.getByTestId('account-copy-sync-link'));
    fireEvent.click(screen.getByTestId('account-delete-cloud-copy'));
    expect(onRunAction).toHaveBeenNthCalledWith(1, 'force');
    expect(onRunAction).toHaveBeenNthCalledWith(2, 'share');
    expect(onRunAction).toHaveBeenNthCalledWith(3, 'delete');
  });

  it('reflects capability flags on the action buttons', () => {
    render(
      <CloudWorkspacePanel
        {...baseProps()}
        syncDisplay={display({
          canEnableSync: false,
          canForceSync: false,
          canCopyShareLink: false,
          canDeleteCloudCopy: false,
        })}
      />
    );
    expect((screen.getByTestId('account-enable-sync') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('account-sync-now') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('account-copy-sync-link') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('account-delete-cloud-copy') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('disables the action grid while a project open runs in the list below', () => {
    render(
      <CloudWorkspacePanel
        {...baseProps()}
        syncBusy={null}
        commandInFlight
        syncDisplay={display({ canForceSync: true, canCopyShareLink: true })}
      />
    );
    expect((screen.getByTestId('account-sync-now') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('account-copy-sync-link') as HTMLButtonElement).disabled).toBe(true);
  });

  it('swaps the action grid for the conflict grid on a conflict axis', () => {
    const onResolveConflict = vi.fn();
    render(
      <CloudWorkspacePanel
        {...baseProps()}
        syncStatus={status({ syncAxis: 'conflict' })}
        onResolveConflict={onResolveConflict}
      />
    );
    expect(screen.queryByTestId('account-sync-now')).toBeNull();
    fireEvent.click(screen.getByTestId('account-resolve-keep-local'));
    expect(onResolveConflict).toHaveBeenCalledWith('keep_local');
  });
});

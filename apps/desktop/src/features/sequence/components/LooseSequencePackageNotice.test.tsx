import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectEditFolder } from '../../workspace-loader/public/project-edit-folders';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  convert: vi.fn(),
  reconcile: vi.fn(),
  openDocument: vi.fn(),
  closeTab: vi.fn(),
  addToast: vi.fn(),
  projectEditFolders: vi.fn<() => ProjectEditFolder[]>(),
}));

vi.mock('../../workspace-loader/public/use-project-edit-folders', () => ({
  useProjectEditFolders: mocks.projectEditFolders,
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    looseSequenceFiles: { inspect: mocks.preview, convert: mocks.convert },
  }),
}));
vi.mock('../../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: () => '/repo',
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [{ path: '/repo' }] }) },
}));
vi.mock('../../../services/workspace-reconcile', () => ({ isManagedRepo: async () => true }));
vi.mock('../../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: mocks.reconcile,
}));
vi.mock('../../document-opening/public/open-document', () => ({
  openDocument: mocks.openDocument,
}));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      panels: { main: { tabs: [{ id: 'tab-1' }] } },
      closeTab: mocks.closeTab,
    }),
  },
}));

import {
  LegacyFastaSequencePackageNotice,
  LooseSequencePackageNotice,
} from './LooseSequencePackageNotice';

describe('LooseSequencePackageNotice ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcile.mockResolvedValue({});
    mocks.openDocument.mockResolvedValue({ status: 'presented' });
    mocks.projectEditFolders.mockReturnValue([
      { path: '/repo', lifecycle: 'active', sharedEditAccess: { kind: 'ready', role: null } },
    ]);
  });

  it('converts a generic FASTA with the declared bytes and opens the package', async () => {
    mocks.preview.mockResolvedValue({
      state: 'needs-dna-confirmation',
      reason: '"clone.fasta" uses a generic FASTA extension without explicit nucleotide identity.',
      sourceSha256: 'b'.repeat(64),
    });
    mocks.convert.mockResolvedValue({
      converted: true,
      packageRoots: ['/repo/clone'],
      reason: null,
    });

    render(<LooseSequencePackageNotice tabId="tab-1" filePath="/repo/clone.fasta" label="clone" />);
    fireEvent.click(await screen.findByRole('button', { name: 'This is DNA — convert' }));

    await waitFor(() => expect(mocks.openDocument).toHaveBeenCalled());
    expect(mocks.convert).toHaveBeenCalledWith({
      workspaceRoot: '/repo',
      sourcePath: '/repo/clone.fasta',
      confirmedDnaSourceSha256: 'b'.repeat(64),
      confirmedNucleicAcid: 'dna',
    });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/repo', revealPath: '/repo/clone', strict: true })
    );
    expect(mocks.closeTab).toHaveBeenCalledWith('main', 'tab-1');
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'sequence-package', path: '/repo/clone' },
      label: 'clone',
    });
  });

  it('does not report a completed conversion as failed when a later step throws', async () => {
    mocks.preview.mockResolvedValue({ state: 'convertible' });
    mocks.convert.mockResolvedValue({
      converted: true,
      packageRoots: ['/repo/a', '/repo/b', '/repo/c'],
      reason: null,
    });
    mocks.reconcile.mockRejectedValue(new Error('index busy'));
    mocks.openDocument
      .mockResolvedValueOnce({ status: 'presented' })
      .mockRejectedValueOnce(new Error('tab limit'))
      .mockResolvedValueOnce({ status: 'presented' });

    render(<LooseSequencePackageNotice tabId="tab-1" filePath="/repo/multi.fna" label="multi" />);
    fireEvent.click(await screen.findByTestId('loose-sequence-package-convert'));

    await waitFor(() => expect(mocks.openDocument).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/Conversion failed/)).toBeNull();
    expect(mocks.closeTab).toHaveBeenCalledWith('main', 'tab-1');
    expect(mocks.addToast).toHaveBeenCalledWith(
      'Converted the file, but the project view could not refresh.',
      { definition: 'loose-sequence-package-notice-refresh-after-convert-failed' }
    );
    expect(mocks.addToast).toHaveBeenCalledWith(
      'Converted the file, but 1 of its 3 sequences could not be opened.',
      { definition: 'loose-sequence-package-notice-open-after-convert-failed' }
    );
  });

  it('shows the exact refusal and offers no conversion for a damaged file', async () => {
    mocks.preview.mockResolvedValue({
      state: 'refused',
      reason: 'Line 4: Invalid sequence character "`" at column 18.',
    });

    render(<LooseSequencePackageNotice tabId="tab-1" filePath="/repo/x.dnas" label="x" />);

    expect(await screen.findByTestId('loose-sequence-package-reason')).toHaveTextContent(
      'Invalid sequence character "`" at column 18'
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for a non-DNA file type', async () => {
    render(<LooseSequencePackageNotice tabId="tab-1" filePath="/repo/p.faa" label="p" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(screen.queryByTestId('loose-sequence-package-notice')).toBeNull();
  });
});

describe('legacy FASTA explicit conversion ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectEditFolders.mockReturnValue([
      { path: '/repo', lifecycle: 'active', sharedEditAccess: { kind: 'ready', role: null } },
    ]);
    mocks.preview.mockResolvedValue({
      state: 'needs-dna-confirmation',
      reason: '"probe.fasta" uses a generic FASTA extension without explicit nucleotide identity.',
      sourceSha256: 'c'.repeat(64),
    });
    mocks.convert.mockResolvedValue({ converted: true, packageRoots: ['/repo/probe'] });
    mocks.reconcile.mockResolvedValue({});
    mocks.openDocument.mockResolvedValue({ status: 'presented' });
  });

  it('uses the existing digest-confirmed conversion for an editable project', async () => {
    render(
      <LegacyFastaSequencePackageNotice tabId="tab-1" filePath="/repo/probe.fasta" label="probe" />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'This is DNA — convert' }));
    await waitFor(() => expect(mocks.openDocument).toHaveBeenCalled());
    expect(mocks.convert).toHaveBeenCalledWith({
      workspaceRoot: '/repo',
      sourcePath: '/repo/probe.fasta',
      confirmedDnaSourceSha256: 'c'.repeat(64),
      confirmedNucleicAcid: 'dna',
    });
  });

  it.each<{ name: string; folders: ProjectEditFolder[] }>([
    { name: 'unowned path', folders: [] },
    { name: 'reference project', folders: [{ path: '/repo', pinned: true }] },
    {
      name: 'viewer project',
      folders: [{ path: '/repo', sharedEditAccess: { kind: 'ready', role: 'viewer' } }],
    },
    {
      name: 'permission lookup pending',
      folders: [{ path: '/repo', editAvailability: 'checking' }],
    },
  ])('does not offer conversion for $name', ({ folders }) => {
    mocks.projectEditFolders.mockReturnValue(folders);
    render(
      <LegacyFastaSequencePackageNotice tabId="tab-1" filePath="/repo/probe.fasta" label="probe" />
    );
    expect(screen.queryByTestId('loose-sequence-package-notice')).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });
});

import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../canvas/types';
import { useCanvasStore } from '../canvas/store';

const { mockLoadSnapshot, mockReveal, mockExists, mockReadDocument } = vi.hoisted(() => ({
  mockLoadSnapshot: vi.fn(),
  mockReveal: vi.fn(),
  mockExists: vi.fn(),
  mockReadDocument: vi.fn(),
}));

vi.mock('./loadStructureFileSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./loadStructureFileSnapshot')>();
  return { ...actual, loadStructureFileSnapshot: mockLoadSnapshot };
});

vi.mock('../../platform', () => ({
  platform: () => ({ shell: { revealItemInDir: mockReveal }, fs: { exists: mockExists } }),
}));
vi.mock('../molecular-documents/public/services', () => ({
  readMolecularDocument: mockReadDocument,
}));

vi.mock('../page/embeds/structure3d/components/Structure3dPanel', () => ({
  Structure3dPanel: (props: {
    structureData?: string | Uint8Array;
    structureDataFormat?: string;
    structureViewId?: string;
  }) => (
    <div
      data-testid="mock-structure-panel"
      data-format={props.structureDataFormat}
      data-view-id={props.structureViewId}
      data-byte-kind={props.structureData instanceof Uint8Array ? 'binary' : 'text'}
    />
  ),
}));

import { StructureFileLoadError } from './loadStructureFileSnapshot';
import { StructureFileTabContent } from './StructureFileTabContent';
import {
  clearStructureFileSnapshotsForTests,
  getStructureFileSnapshot,
  registerStructureFileSnapshot,
} from './structure-file-snapshots';

const tab: Tab = {
  id: 'tab-file-1',
  type: 'structure',
  entityId: 'view:file:1',
  label: '1FS0.pdb',
  loadStatus: 'loaded',
  initialStructureAttrs: {
    source: 'file',
    sourceId: '/lab/1FS0.pdb',
    coordinateFilePath: '/lab/1FS0.pdb',
    structureViewIdentity: { schemaVersion: 1, structureViewId: 'view:file:1', bindingId: null },
    structureArtifactRef: {
      entityId: 'catalog-1',
      revisionId: 'revision-1',
      structureId: 'structure-1',
      coordinateDigestSha256: 'abc',
      artifactPath: '/lab/1FS0.pdb',
      format: 'pdb',
    },
  },
};

describe('StructureFileTabContent', () => {
  beforeEach(() => {
    mockLoadSnapshot.mockReset();
    mockReveal.mockReset();
    mockExists.mockReset().mockResolvedValue(false);
    mockReadDocument.mockReset();
    clearStructureFileSnapshotsForTests();
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [tab], activeTabId: tab.id } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
      recentlyClosed: [],
    });
  });

  it('hydrates the existing Molstar panel with explicit file data and parser', async () => {
    mockLoadSnapshot.mockResolvedValue({
      structureViewId: 'view:file:1',
      revisionId: 'revision-1',
      filePath: '/lab/1FS0.pdb',
      coordinateDigestSha256: 'abc',
      parser: 'pdb',
      encoding: 'text',
      data: 'HEADER TEST\nATOM 1\nEND\n',
    });

    render(<StructureFileTabContent tab={tab} />);

    expect(screen.getByRole('status')).toHaveTextContent('Reading coordinate file');
    const panel = await screen.findByTestId('mock-structure-panel');
    expect(panel).toHaveAttribute('data-format', 'pdb');
    expect(panel).toHaveAttribute('data-byte-kind', 'text');
    expect(panel).toHaveAttribute('data-view-id', 'view:file:1');
  });

  it('does not reread coordinates when reference navigation only replaces highlight attrs', async () => {
    const snapshot = {
      structureViewId: 'view:file:1',
      revisionId: 'revision-1',
      filePath: '/lab/1FS0.pdb',
      coordinateDigestSha256: 'abc',
      parser: 'pdb' as const,
      encoding: 'text' as const,
      data: 'HEADER TEST\nATOM 1\nEND\n',
    };
    mockLoadSnapshot.mockResolvedValue(snapshot);

    const view = render(<StructureFileTabContent tab={tab} />);
    await screen.findByTestId('mock-structure-panel');

    view.rerender(
      <StructureFileTabContent
        tab={{
          ...tab,
          initialStructureAttrs: {
            ...tab.initialStructureAttrs,
            highlightGroups: [
              {
                id: 'selection:from-chat',
                label: 'Chat selection',
                selections: [{ chain: 'A', ranges: [[57, 57]] }],
                renderMode: 'selection',
              },
            ],
          },
        }}
      />
    );

    await waitFor(() => expect(screen.getByTestId('mock-structure-panel')).toBeInTheDocument());
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(1);
  });

  it('renders a bounded actionable error and an explicit text escape hatch', async () => {
    mockLoadSnapshot.mockRejectedValue(
      new StructureFileLoadError(
        'unsupported-cif',
        'This CIF does not contain a macromolecular atom_site table.',
        '/lab/1FS0.pdb'
      )
    );

    render(<StructureFileTabContent tab={tab} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('structure.unsupportedCoordinates')
    );
    expect(screen.queryByTestId('mock-structure-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open as text' }));
    await waitFor(() => {
      expect(useCanvasStore.getState().findTab('text', '/lab/1FS0.pdb')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    expect(mockReveal).toHaveBeenCalledWith('/lab/1FS0.pdb');
  });

  it('reopens a converted coordinate file from the package beside it ', async () => {
    mockLoadSnapshot.mockRejectedValue(
      new StructureFileLoadError('read-error', 'The file is missing.', '/lab/1FS0.pdb')
    );
    mockExists.mockImplementation(
      async (path: string) => path === '/lab/1FS0.dnaforge-molecular.json'
    );
    mockReadDocument.mockResolvedValue({
      path: '/lab/1FS0.dnaforge-molecular.json',
      revision: 'r1',
      catalogEntityId: 'project::document-1',
      document: {
        id: 'document-1',
        name: '1FS0',
        currentReferenceId: 'reference-1',
        history: [{ referenceId: 'reference-1', snapshot: { coordinates: { sha256: 'abc' } } }],
      },
    });

    render(<StructureFileTabContent tab={tab} />);

    await waitFor(() => {
      expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
        entityId: 'molecular-document:project::document-1',
        label: '1FS0',
        initialStructureAttrs: {
          sourceId: '',
          molecularDocumentPath: '/lab/1FS0.dnaforge-molecular.json',
          molecularDocumentRevision: 'r1',
          molecularDocumentSavedReferenceId: 'reference-1',
        },
      });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the error when the package beside a missing file holds other coordinates', async () => {
    mockLoadSnapshot.mockRejectedValue(
      new StructureFileLoadError('read-error', 'The file is missing.', '/lab/1FS0.pdb')
    );
    mockExists.mockResolvedValue(true);
    mockReadDocument.mockResolvedValue({
      path: '/lab/1FS0.dnaforge-molecular.json',
      revision: 'r1',
      catalogEntityId: 'project::document-1',
      document: {
        id: 'document-1',
        name: '1FS0',
        currentReferenceId: 'reference-1',
        history: [{ referenceId: 'reference-1', snapshot: { coordinates: { sha256: 'other' } } }],
      },
    });

    render(<StructureFileTabContent tab={tab} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('structure.failed'));
    expect(useCanvasStore.getState().panels.main.tabs[0].entityId).toBe('view:file:1');
  });

  it('retries the same pinned revision without remounting an error forever', async () => {
    mockLoadSnapshot
      .mockRejectedValueOnce(
        new StructureFileLoadError('read-error', 'DNAForge could not read this coordinate file.')
      )
      .mockResolvedValueOnce({
        structureViewId: 'view:file:1',
        revisionId: 'revision-1',
        filePath: '/lab/1FS0.pdb',
        coordinateDigestSha256: 'abc',
        parser: 'pdb',
        encoding: 'text',
        data: 'HEADER TEST\nATOM 1\nEND\n',
      });

    render(<StructureFileTabContent tab={tab} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('mock-structure-panel')).toBeInTheDocument();
    expect(mockLoadSnapshot).toHaveBeenCalledTimes(2);
  });

  it('releases the coordinate body when the owning structure tab unmounts', async () => {
    const snapshot = {
      structureViewId: 'view:file:1',
      revisionId: 'revision-1',
      filePath: '/lab/1FS0.pdb',
      coordinateDigestSha256: 'abc',
      parser: 'pdb' as const,
      encoding: 'text' as const,
      data: 'HEADER TEST\nATOM 1\nEND\n',
    };
    registerStructureFileSnapshot(snapshot);
    mockLoadSnapshot.mockResolvedValue(snapshot);

    const view = render(<StructureFileTabContent tab={tab} />);
    await screen.findByTestId('mock-structure-panel');
    expect(getStructureFileSnapshot('view:file:1')).toBeDefined();

    view.unmount();
    expect(getStructureFileSnapshot('view:file:1')).toBeUndefined();
  });
});

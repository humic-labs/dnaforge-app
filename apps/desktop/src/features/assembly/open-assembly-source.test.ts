import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeChecksum, serializeGenBank } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { useCanvasStore } from '../canvas/public/store';
import { useSequenceStore } from '../sequence/public/store';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  exists: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { readFile: mocks.readFile, readTextFile: mocks.readTextFile, exists: mocks.exists },
  }),
}));
vi.mock('../sequence/sequence-document-repository', () => ({
  resolveSequenceDocumentById: mocks.resolve,
}));
vi.mock('../document-opening/open-document', () => ({ openDocument: mocks.open }));
import { openAssemblySourceRegion } from './open-assembly-source';

const source = {
  sourceSequenceId: 'source-uuid',
  sourceSequenceName: 'Source',
  sourceStart: 20,
  sourceEnd: 30,
  sequence: 'A'.repeat(10),
  sourceType: 'pcr' as const,
};

beforeEach(() => {
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
  useSequenceStore.getState().clearAll();
  mocks.resolve
    .mockReset()
    .mockResolvedValue({ ref: { kind: 'catalog-sequence', entityId: 'source-uuid' } });
  mocks.open.mockReset().mockImplementation(async (request) => {
    const entityId =
      request.target.kind === 'file'
        ? 'catalog-source-file'
        : (request.target.document.packageId ?? request.target.document.entityId);
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId,
      label: 'Source',
      sequenceDocument: { kind: 'catalog-sequence', entityId },
    });
    return { status: 'presented', panelId: 'main', tabId, disposition: 'created' };
  });
  mocks.readFile.mockReset();
  mocks.readTextFile.mockReset();
  mocks.exists.mockReset().mockResolvedValue(false);
});

describe('shared assembly source opening', () => {
  it('opens a legacy saved absolute path through the normal file-opening boundary', async () => {
    await openAssemblySourceRegion({ ...source, sourceSequenceId: '/project/source.gb' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/project/source.gb' },
      label: 'Source',
    });
    const tab = useCanvasStore.getState().panels.main.tabs[0];
    expect(tab.viewState?.highlightRange).toEqual({ start: 20, end: 29 });
    expect(tab.viewState?.scrollPosition).toBe(21);
  });

  it('opens a saved source through its current package binding when the old package still exists', async () => {
    const staleRoot = '/other-profile/source-package';
    const currentRoot = '/workspace/source-package';
    const oldProductPath = `${staleRoot}/source.gb`;
    const currentProductPath = `${currentRoot}/source.gb`;
    const currentRef = {
      kind: 'managed-sequence' as const,
      packageId: 'stable-source-id',
      packageRoot: currentRoot,
    };
    mocks.exists.mockImplementation(
      async (path: string) => path === `${staleRoot}/.forge/plasmid.json`
    );
    mocks.readTextFile.mockResolvedValue(
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: currentRef.packageId,
          name: 'Source',
          product: { file: 'source.gb', topology: 'linear' },
        })
      )
    );
    mocks.resolve.mockResolvedValue({
      ref: currentRef,
      documentId: currentRef.packageId,
      sourcePath: currentProductPath,
    });
    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode(
        serializeGenBank({
          id: 'source',
          name: 'Source',
          sequence: 'A'.repeat(30),
          length: 30,
          circular: false,
          annotations: [],
        })
      )
    );
    const checksum = await computeChecksum('A'.repeat(30));

    await openAssemblySourceRegion(
      { ...source, sourceSequenceId: oldProductPath },
      {
        provenance: {
          regionId: 'part-one',
          sourceType: 'pcr',
          sourceSequenceId: oldProductPath,
          sourceSequenceName: 'Source',
          sourceSequenceChecksum: checksum,
          sourceLocator: oldProductPath,
          copiedDirection: 'forward',
          selectedSourceRange: { start: 20, end: 30 },
          includedSourceSegments: [],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
      }
    );

    expect(mocks.resolve).toHaveBeenCalledWith(currentRef.packageId, expect.any(Array));
    expect(mocks.readFile).toHaveBeenCalledWith(currentProductPath);
    expect(mocks.open).toHaveBeenCalledWith({
      target: { kind: 'sequence-document', document: currentRef },
      label: 'Source',
    });

    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode(
        serializeGenBank({
          id: 'source',
          name: 'Source',
          sequence: 'C'.repeat(30),
          length: 30,
          circular: false,
          annotations: [],
        })
      )
    );
    await expect(
      openAssemblySourceRegion(
        { ...source, sourceSequenceId: oldProductPath },
        {
          provenance: {
            regionId: 'part-one',
            sourceType: 'pcr',
            sourceSequenceId: oldProductPath,
            sourceSequenceName: 'Source',
            sourceSequenceChecksum: checksum,
            sourceLocator: oldProductPath,
            copiedDirection: 'forward',
            selectedSourceRange: { start: 20, end: 30 },
            includedSourceSegments: [],
            sourceAnnotations: [],
            copiedAnnotations: [],
          },
        }
      )
    ).rejects.toThrow('source has changed');
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('resolves stable source identity and surfaces a missing source rather than inventing one', async () => {
    mocks.resolve.mockRejectedValue(
      new Error('The sequence source is no longer available in this project.')
    );
    await expect(openAssemblySourceRegion(source)).rejects.toThrow('no longer available');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('does not report a failed document open as success', async () => {
    mocks.open.mockResolvedValue({ status: 'failed', message: 'Source file is missing.' });
    await expect(openAssemblySourceRegion(source)).rejects.toThrow('Source file is missing.');
  });

  it('refuses a changed pinned source before opening or highlighting its current version', async () => {
    const expected = await computeChecksum('A'.repeat(30));
    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode(
        serializeGenBank({
          id: 'source',
          name: 'Source',
          sequence: 'C'.repeat(30),
          length: 30,
          circular: false,
          annotations: [],
        })
      )
    );
    await expect(
      openAssemblySourceRegion(
        { ...source, sourceSequenceId: '/project/source.gb' },
        {
          provenance: {
            regionId: 'part-one',
            sourceType: 'pcr',
            sourceSequenceId: '/project/source.gb',
            sourceSequenceName: 'Source',
            sourceSequenceChecksum: expected,
            sourceLocator: '/project/source.gb',
            copiedDirection: 'forward',
            selectedSourceRange: { start: 20, end: 30 },
            includedSourceSegments: [],
            sourceAnnotations: [],
            copiedAnnotations: [],
          },
        }
      )
    ).rejects.toThrow('source has changed');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('opens a pinned source only when its current sequence still matches', async () => {
    const expected = await computeChecksum('A'.repeat(30));
    mocks.readFile.mockResolvedValue(
      new TextEncoder().encode(
        serializeGenBank({
          id: 'source',
          name: 'Source',
          sequence: 'A'.repeat(30),
          length: 30,
          circular: false,
          annotations: [],
        })
      )
    );
    await openAssemblySourceRegion(
      { ...source, sourceSequenceId: '/project/source.gb' },
      {
        provenance: {
          regionId: 'part-one',
          sourceType: 'pcr',
          sourceSequenceId: '/project/source.gb',
          sourceSequenceName: 'Source',
          sourceSequenceChecksum: expected,
          sourceLocator: '/project/source.gb',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 20, end: 30 },
          includedSourceSegments: [],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
      }
    );
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().panels.main.tabs[0].viewState?.highlightRange).toEqual({
      start: 20,
      end: 29,
    });
  });
});

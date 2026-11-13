import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsRegistrySummary } from '../../shared/lims';
import { editRegistryMetadata } from './edit-registry-metadata';

const mocks = vi.hoisted(() => {
  const tabs: { id: string; type: string }[] = [];
  return {
    tabs,
    file: vi.fn(),
    openDocument: vi.fn(),
    openEntity: vi.fn(),
    setTabViewState: vi.fn(),
  };
});

vi.mock('../../db/workspace-catalog', () => ({
  getCurrentCatalogFileForEntity: mocks.file,
}));
vi.mock('../document-opening/public/open-document', () => ({
  openDocument: mocks.openDocument,
}));
vi.mock('./open-entity', () => ({
  openLimsEntity: mocks.openEntity,
  isLimsEntityOpened: (result: { status: string }) => result.status === 'opened',
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: {
    getState: () => ({
      panels: { panel: { id: 'panel', tabs: mocks.tabs } },
      setTabViewState: mocks.setTabViewState,
    }),
  },
}));

function summary(): Pick<LimsRegistrySummary, 'id' | 'name' | 'representation'> {
  return {
    id: 'record',
    name: 'Saved sequence',
    representation: { kind: 'file_sequence', canOpen: true, label: 'Sequence' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tabs.splice(0, mocks.tabs.length, { id: 'tab', type: 'sequence' });
  mocks.file.mockResolvedValue({ path: '/project/sequence.gb' });
  mocks.openDocument.mockResolvedValue({ status: 'presented', tabId: 'tab' });
  mocks.openEntity.mockResolvedValue({ status: 'opened', tabId: 'tab' });
});

describe('Registry metadata editor delivery', () => {
  it('sends a one-shot request only to the matching existing document editor', async () => {
    mocks.tabs[0].type = 'primer';
    await editRegistryMetadata(summary(), 'primer');
    expect(mocks.openDocument).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/project/sequence.gb' },
      label: 'Saved sequence',
      placement: { kind: 'focused' },
    });
    expect(mocks.setTabViewState).toHaveBeenCalledWith('panel', 'tab', {
      metadataEditRequestId: expect.any(String),
    });
  });

  it('refuses a different viewer without sending a metadata request', async () => {
    mocks.tabs[0].type = 'protein';
    await expect(editRegistryMetadata(summary(), 'sequence')).rejects.toThrow(
      'does not provide this metadata editor'
    );
    expect(mocks.setTabViewState).not.toHaveBeenCalled();
  });

  it('opens a managed sequence through its owning route before requesting metadata', async () => {
    const record = summary();
    record.representation.openTarget = {
      kind: 'managed_sequence',
      entityId: 'record',
      document: { kind: 'managed-sequence', packageId: 'record', packageRoot: '/project/Sequence' },
    };
    await editRegistryMetadata(record, 'sequence');
    expect(mocks.file).not.toHaveBeenCalled();
    expect(mocks.openDocument).not.toHaveBeenCalled();
    expect(mocks.openEntity).toHaveBeenCalledWith({
      entityId: 'record',
      strategy: { kind: 'focused' },
    });
    expect(mocks.setTabViewState).toHaveBeenCalledWith('panel', 'tab', {
      metadataEditRequestId: expect.any(String),
    });
  });

  it('reports an editor that closed during opening without claiming success', async () => {
    mocks.tabs.length = 0;
    await expect(editRegistryMetadata(summary(), 'sequence')).rejects.toThrow(
      'no longer available'
    );
    expect(mocks.setTabViewState).not.toHaveBeenCalled();
  });

  it('preserves an opening failure without dispatching an edit request', async () => {
    mocks.openDocument.mockResolvedValue({ status: 'failed', message: 'Document unavailable' });
    await expect(editRegistryMetadata(summary(), 'sequence')).rejects.toThrow(
      'Document unavailable'
    );
    expect(mocks.setTabViewState).not.toHaveBeenCalled();
  });
});

import { beforeEach, expect, it, vi } from 'vitest';
import { promotePreviewTab } from './promote-preview-tab';
import { useCanvasStore } from '../canvas/public/store';
import { partializeCanvasState } from '../canvas/store';
import { referencedPreviewPackages } from '../../lib/preview-tab-packages';
import { sourceViewForReceipt, sourceViewerTabId } from '../../lib/open-external-preview';
import type {
  ExternalPreviewReceipt,
  PromoteQuickLookPackageResult,
} from '../../shared/file-association-ipc';

const native = vi.hoisted(() => ({ find: vi.fn(), describe: vi.fn() }));
vi.mock('../sequence/public/managed-sequence-repository', () => ({
  managedSequenceRepository: { findByMemberPath: native.find },
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fileAssociations: { describeProjectPreviewPackage: native.describe } }),
}));

const receipt: ExternalPreviewReceipt = {
  version: 1,
  packageId: 'snapshot',
  sourceFileName: 'reads.fa',
  sourcePath: '/missing/reads.fa',
  familyId: 'fasta',
  contentHash: 'a'.repeat(64),
};
const saved: PromoteQuickLookPackageResult = {
  destPath: '/project/one/one.gb',
  relPath: 'one/one.gb',
  workspaceRoot: '/project',
  createdWorkspaceName: null,
  createdNewWorkspace: false,
  committed: true,
  records: [
    { recordId: 'one', destPath: '/project/one/one.gb', relPath: 'one/one.gb' },
    { recordId: 'two', destPath: '/project/two/two.gb', relPath: 'two/two.gb' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.getState().reset();
});

it('promotes the selected FASTA record in the initiating tab and keeps other panels and history pinned', async () => {
  const canvas = useCanvasStore.getState();
  const secondPanel = canvas.splitPanel('main', 'vertical');
  const closedPanel = canvas.splitPanel(secondPanel, 'vertical');
  const view = sourceViewForReceipt(receipt);
  const input = {
    type: 'file' as const,
    entityId: sourceViewerTabId(view),
    label: receipt.sourceFileName,
    sourceFileView: view,
    readOnly: true,
  };
  const origin = canvas.openTab('main', {
    ...input,
    sourceFileView: { ...view, selectedRecord: 1 },
  });
  canvas.openTab(secondPanel, input);
  const closed = canvas.openTab(closedPanel, input);
  canvas.closeTab(closedPanel, closed);
  const managed = {
    kind: 'managed-sequence',
    packageId: 'editable-two',
    packageRoot: '/project/two',
  };
  native.find.mockResolvedValue({ ref: managed, document: { name: 'two' } });
  await promotePreviewTab(receipt, saved, origin);
  expect(native.find).toHaveBeenCalledWith('/project/two/two.gb');
  const state = useCanvasStore.getState();
  expect(state.panels.main.tabs[0]).toMatchObject({
    id: origin,
    type: 'sequence',
    sequenceDocument: managed,
    readOnly: false,
  });
  expect(state.panels[secondPanel].tabs[0]).toMatchObject(input);
  expect(state.recentlyClosed[0].tab).toMatchObject(input);
  const persisted = partializeCanvasState(state);
  expect(referencedPreviewPackages(persisted)).toEqual([receipt]);
});

it('opens independent project copies of the same source in different tabs', () => {
  const base = {
    format: 'chromatogram' as const,
    location: 'project' as const,
    projectPackageId: 'same-import',
    workspaceRoot: '/project',
  };
  const first = sourceViewerTabId({
    ...base,
    path: '/project/folder-A/.forge/source-document.json',
  });
  const other = sourceViewerTabId({
    ...base,
    path: '/project/folder-B/.forge/source-document.json',
  });
  expect(first).not.toBe(other);
});

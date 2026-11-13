import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reportDirtyState: vi.fn(),
  pageState: { dirtyIds: new Set<string>() },
  sequenceState: { dirtyPaths: {} as Record<string, boolean> },
  canvasState: {
    panels: {
      main: {
        tabs: [] as Array<{
          id: string;
          type: string;
          label: string;
          entityId?: string;
          isDirty?: boolean;
        }>,
      },
    },
  },
}));

vi.mock('../platform', () => ({
  platform: () => ({ app: { reportDirtyState: mocks.reportDirtyState } }),
}));

vi.mock('../features/page/store', () => ({
  usePageStore: {
    getState: () => mocks.pageState,
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../features/sequence/store', () => ({
  useSequenceStore: {
    getState: () => mocks.sequenceState,
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../features/canvas/store', () => ({
  useCanvasStore: {
    getState: () => mocks.canvasState,
    subscribe: vi.fn(() => vi.fn()),
  },
}));

const designMocks = vi.hoisted(() => ({
  unrecoverable: [] as string[],
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('../features/design/design-recovery', () => ({
  hasUnrecoverableDesignWork: () => designMocks.unrecoverable,
  useDesignRecoveryStore: { subscribe: designMocks.subscribe },
}));

import { QUIT_LABEL_BY_TAB_TYPE, TAB_TYPES } from './tab-kind';
import { initDirtyReporter } from './dirty-reporter';

describe('dirty reporter workspace inputs', () => {
  beforeEach(() => {
    mocks.reportDirtyState.mockReset();
    designMocks.unrecoverable = [];
    mocks.pageState.dirtyIds = new Set(['page-a']);
    mocks.sequenceState.dirtyPaths = {
      'sequence-document-a': true,
      'sequence-document-b': true,
    };
    mocks.canvasState.panels.main.tabs = [];
  });

  it('reports dirty page IDs and stable sequence document IDs to main', () => {
    const unsubscribe = initDirtyReporter();

    expect(mocks.reportDirtyState).toHaveBeenCalledWith({
      hasDirtyWork: true,
      details: '2 sequences and 1 page',
      dirtyPageIds: ['page-a'],
      dirtySequenceDocumentIds: ['sequence-document-a', 'sequence-document-b'],
      dirtyTabIds: [],
      dirtyFilePaths: [],
    });

    unsubscribe();
  });

  it('names each dirty tab type instead of collapsing them into documents', () => {
    mocks.pageState.dirtyIds = new Set();
    mocks.sequenceState.dirtyPaths = {};
    mocks.canvasState.panels.main.tabs = [
      { id: 'primer-tab', type: 'primer', label: 'Primer A', isDirty: true },
      { id: 'assembly-tab', type: 'design', label: 'Untitled Assembly', isDirty: true },
      { id: 'clean-tab', type: 'protein', label: 'Protein A', isDirty: false },
    ];

    const unsubscribe = initDirtyReporter();

    expect(mocks.reportDirtyState).toHaveBeenCalledWith({
      hasDirtyWork: true,
      details: '1 assembly and 1 primer',
      dirtyPageIds: [],
      dirtySequenceDocumentIds: [],
      dirtyTabIds: ['primer-tab', 'assembly-tab'],
      dirtyFilePaths: [],
    });

    unsubscribe();
  });

  it('counts a sequence once when the editor and its tab both say it is unsaved', () => {
    mocks.pageState.dirtyIds = new Set(['page-a']);
    mocks.sequenceState.dirtyPaths = { 'seq-a': true };
    mocks.canvasState.panels.main.tabs = [
      {
        id: 'seq-tab',
        type: 'sequence',
        entityId: 'seq-a',
        label: 'pBR322',
        isDirty: true,
      },
      { id: 'text-tab', type: 'text', entityId: '/a.txt', label: 'a.txt', isDirty: true },
      { id: 'record-tab', type: 'record', entityId: 'r1', label: 'Record', isDirty: true },
    ];

    const unsubscribe = initDirtyReporter();

    expect(mocks.reportDirtyState).toHaveBeenCalledWith({
      hasDirtyWork: true,
      details: '1 sequence and 1 text file and 1 record and 1 page',
      dirtyPageIds: ['page-a'],
      dirtySequenceDocumentIds: ['seq-a'],
      dirtyTabIds: ['seq-tab', 'text-tab', 'record-tab'],
      dirtyFilePaths: ['/a.txt'],
    });

    unsubscribe();
  });

  it('has a quit noun for every openable tab type', () => {
    for (const type of TAB_TYPES) {
      expect(QUIT_LABEL_BY_TAB_TYPE[type].one.trim().length).toBeGreaterThan(0);
      expect(QUIT_LABEL_BY_TAB_TYPE[type].many.trim().length).toBeGreaterThan(0);
    }
  });

  it('treats in-memory-only assembly drafts as unsaved work and ignores durable delayed saves', () => {
    designMocks.unrecoverable = ['design-a'];
    const unsubscribe = initDirtyReporter();
    expect(mocks.reportDirtyState).toHaveBeenCalledWith(
      expect.objectContaining({
        hasDirtyWork: true,
        details: '2 sequences and 1 page and 1 assembly',
      })
    );
    unsubscribe();
  });
});

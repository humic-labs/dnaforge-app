import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/store';
import { useSequenceStore } from './store';
import {
  commitVisibleFileOpen,
  failPendingFileOpen,
  registerPendingFileOpen,
  subscribeVisibleFileOpen,
  __resetFileOpenTelemetryForTests,
} from './file-open-telemetry';

const analyticsMocks = vi.hoisted(() => ({
  trackRendererEvent: vi.fn(),
  getAnalyticsCaptureGeneration: () => 0,
  isAnalyticsCaptureReady: () => false,
}));
const workflowMocks = vi.hoisted(() => ({ observeWorkflowAction: vi.fn() }));
vi.mock('../../lib/analytics', () => analyticsMocks);
vi.mock('../../lib/workflow-telemetry', () => workflowMocks);

describe('file-open telemetry parse/visible commit join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFileOpenTelemetryForTests();
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [
            {
              id: 'tab-1',
              type: 'sequence',
              entityId: '/workspace/pUC19.gb',
              label: 'pUC19.gb',
            },
          ],
          activeTabId: 'tab-1',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
    useSequenceStore.setState({
      sequences: {
        '/workspace/pUC19.gb': {
          id: '/workspace/pUC19.gb',
          name: 'pUC19',
          sequence: 'ATCG',
          length: 4,
          annotations: [],
          circular: true,
        },
      },
    });
  });

  it('emits once only after parsed state exists and the originating tab still exists', () => {
    const visibleListener = vi.fn();
    const unsubscribe = subscribeVisibleFileOpen(visibleListener);
    registerPendingFileOpen({
      filePath: '/workspace/pUC19.gb',
      tabId: 'tab-1',
      fileTypeCategory: 'dna',
      sourceSurface: 'file_tree',
      sizeBucket: '1_10kb',
      fileSizeBytes: 4,
    });

    expect(commitVisibleFileOpen('/workspace/pUC19.gb')).toBe(true);
    expect(commitVisibleFileOpen('/workspace/pUC19.gb')).toBe(false);
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledOnce();
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith('file_opened', {
      feature_area: 'file',
      file_type_category: 'dna',
      source_surface: 'file_tree',
      size_bucket: '1_10kb',
      file_size_bytes: 4,
    });
    expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledOnce();
    expect(workflowMocks.observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'content',
      action: 'open',
      status: 'viewed',
    });
    expect(visibleListener).toHaveBeenCalledOnce();
    expect(visibleListener).toHaveBeenCalledWith({ filePath: '/workspace/pUC19.gb' });
    unsubscribe();
  });

  it('stops notifying a visible-open listener after unsubscribe', () => {
    const visibleListener = vi.fn();
    const unsubscribe = subscribeVisibleFileOpen(visibleListener);
    unsubscribe();
    registerPendingFileOpen({
      filePath: '/workspace/pUC19.gb',
      tabId: 'tab-1',
      fileTypeCategory: 'dna',
      sourceSurface: 'file_tree',
      sizeBucket: '1_10kb',
      fileSizeBytes: 4,
    });

    expect(commitVisibleFileOpen('/workspace/pUC19.gb')).toBe(true);
    expect(visibleListener).not.toHaveBeenCalled();
  });

  it('settles a parsed open even if the user changes focus before parsing finishes', () => {
    registerPendingFileOpen({
      filePath: '/workspace/pUC19.gb',
      tabId: 'tab-1',
      fileTypeCategory: 'dna',
      sourceSurface: 'search',
      sizeBucket: '1_10kb',
      fileSizeBytes: 4,
    });
    useCanvasStore.setState((state) => ({
      panels: { ...state.panels, main: { ...state.panels.main, activeTabId: null } },
    }));
    expect(commitVisibleFileOpen('/workspace/pUC19.gb')).toBe(true);
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledOnce();
  });

  it('does not settle success while parsed sequence state is absent', () => {
    registerPendingFileOpen({
      filePath: '/workspace/pUC19.gb',
      tabId: 'tab-1',
      fileTypeCategory: 'dna',
      sourceSurface: 'search',
      sizeBucket: '1_10kb',
      fileSizeBytes: 4,
    });
    useSequenceStore.setState({ sequences: {} });
    expect(commitVisibleFileOpen('/workspace/pUC19.gb')).toBe(false);
    expect(analyticsMocks.trackRendererEvent).not.toHaveBeenCalled();
  });

  it('correlates a visible sequence parse failure to the import attempt without leaking file data', () => {
    const importOperationId = '123e4567-e89b-42d3-a456-426614174000';
    registerPendingFileOpen({
      filePath: '/workspace/verified-user-organism.gb',
      tabId: 'tab-1',
      fileTypeCategory: 'dna',
      sourceSurface: 'sidebar',
      sizeBucket: '1_10kb',
      fileSizeBytes: 4,
      importOperationId,
    });

    failPendingFileOpen('/workspace/verified-user-organism.gb', 'parse_failed');
    failPendingFileOpen('/workspace/verified-user-organism.gb', 'parse_failed');
    expect(analyticsMocks.trackRendererEvent.mock.calls).toEqual([
      [
        'file_open_failed',
        {
          feature_area: 'file',
          file_type_category: 'dna',
          source_surface: 'sidebar',
          size_bucket: '1_10kb',
          error_class: 'parse_failed',
        },
      ],
      [
        'import_failed',
        {
          feature_area: 'import',
          source_system_type: 'file',
          failure_stage: 'parse',
          error_class: 'parse_failed',
          operation_id: importOperationId,
        },
      ],
    ]);
    expect(JSON.stringify(analyticsMocks.trackRendererEvent.mock.calls)).not.toContain(
      'verified-user-organism'
    );
  });

  it('reports an ordinary handled open failure without inventing an import failure', () => {
    registerPendingFileOpen({
      filePath: '/workspace/existing-sequence.gb',
      tabId: 'tab-1',
      fileTypeCategory: 'dna',
      sourceSurface: 'file_tree',
      sizeBucket: '1_10kb',
      fileSizeBytes: 4,
    });

    failPendingFileOpen('/workspace/existing-sequence.gb', 'filesystem');
    failPendingFileOpen('/workspace/existing-sequence.gb', 'filesystem');

    expect(analyticsMocks.trackRendererEvent.mock.calls).toEqual([
      [
        'file_open_failed',
        {
          feature_area: 'file',
          file_type_category: 'dna',
          source_surface: 'file_tree',
          size_bucket: '1_10kb',
          error_class: 'filesystem',
        },
      ],
    ]);
  });
});

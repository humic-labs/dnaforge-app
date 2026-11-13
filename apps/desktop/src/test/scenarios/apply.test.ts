import { describe, it, expect, afterEach } from 'vitest';
import { useCanvasStore } from '../../features/canvas/store';
import { useSequenceStore } from '../../features/sequence/store';
import { useVerificationStore } from '../../features/alignment-manager/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { applyScenario, resetAllStores } from './apply';
import { staleAlignmentSession, ALIGNMENT_STALE_DOCUMENT_ID } from './alignment';
import { sidecarScenarios } from './sidecar';
import type { AppScenario } from './types';
import { getMockFileContent } from '../platform-mocks';

afterEach(() => {
  resetAllStores();
});

describe('applyScenario', () => {
  it('hydrates sidecar via mock fetch', async () => {
    const sidecar = sidecarScenarios.fullyReady();
    applyScenario({ sidecar });
    const response = await (await global.fetch('/toolbox/status')).json();
    expect(response).toEqual(sidecar);
  });

  it('hydrates canvas with single panel', () => {
    const documentId = 'fixture:sequence:apply-single-puc19';
    applyScenario({
      canvas: {
        tabs: [
          {
            type: 'sequence',
            entityId: documentId,
            label: 'pUC19',
            sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
          },
        ],
      },
    });
    const state = useCanvasStore.getState();
    expect(state.panels.main.tabs).toHaveLength(1);
    expect(state.panels.main.tabs[0].type).toBe('sequence');
    expect(state.panels.main.tabs[0].entityId).toBe(documentId);
    expect(state.panels.main.tabs[0].sequenceDocument).toEqual({
      kind: 'catalog-sequence',
      entityId: documentId,
    });
    expect(state.panels.main.activeTabId).toBe(state.panels.main.tabs[0].id);
  });

  it('hydrates canvas with split-vertical layout', () => {
    applyScenario({
      canvas: {
        tabs: [
          { type: 'chat', entityId: 'conv-1', label: 'Chat' },
          {
            type: 'sequence',
            entityId: 'fixture:sequence:apply-split-puc19',
            label: 'pUC19',
            sequenceDocument: {
              kind: 'catalog-sequence',
              entityId: 'fixture:sequence:apply-split-puc19',
            },
          },
        ],
        activeTabIndex: 1,
        layout: 'split-vertical',
      },
    });
    const state = useCanvasStore.getState();
    expect(Object.keys(state.panels)).toHaveLength(2);
    expect(state.layout.type).toBe('split');
    expect(state.focusedPanelId).toBe('right');
  });

  it('hydrates chat, paper, and protocol into three visible columns', () => {
    applyScenario({
      canvas: {
        tabs: [
          { type: 'chat', entityId: 'conv-1', label: 'Chat' },
          { type: 'pdf', entityId: '/test/paper.pdf', label: 'Paper' },
          {
            type: 'scientific-document',
            entityId: '/test/source.dnaforge-protocol.json',
            label: 'Protocol',
          },
        ],
        layout: 'three-column',
      },
    });

    const state = useCanvasStore.getState();
    expect(Object.values(state.panels).map((panel) => panel.tabs[0]?.type)).toEqual([
      'chat',
      'pdf',
      'scientific-document',
    ]);
    expect(state.layout).toMatchObject({
      type: 'split',
      direction: 'vertical',
      sizes: [32, 34, 34],
    });
  });

  it('hydrates sequences', () => {
    const seq = {
      id: 'test-seq',
      name: 'Test',
      sequence: 'ATCG',
      length: 4,
      annotations: [],
    };
    applyScenario({ sequences: { 'fixture:sequence:apply-seq': seq } });
    const documentId = 'fixture:sequence:apply-seq';
    const store = useSequenceStore.getState();
    expect(store.sequences[documentId]).toEqual({ ...seq, id: documentId });
    expect(store.captureForSave(documentId)?.sequence).toEqual({ ...seq, id: documentId });
    store.dispatchEdit(documentId, { type: 'INSERT', text: 'A' });
    expect(useSequenceStore.getState().isDirty(documentId)).toBe(true);
    resetAllStores();
    const cleared = useSequenceStore.getState();
    expect(cleared.captureForSave(documentId)).toBeNull();
    expect(cleared.drafts).toEqual({});
    expect(cleared.savedSequences).toEqual({});
    expect(cleared.sequenceVersions).toEqual({});
    expect(cleared.savedVersions).toEqual({});
    expect(cleared.dirtyPaths).toEqual({});
  });

  it('hydrates workspace folders', () => {
    applyScenario({
      workspace: {
        folders: [
          { path: '/workspace/plasmids', name: 'plasmids' },
          { path: '/workspace/sequences', name: 'sequences' },
        ],
        selectedPath: '/workspace/plasmids',
      },
    });
    const state = useWorkspaceStore.getState();
    expect(state.folders).toHaveLength(2);
    expect(state.selectedPath).toBe('/workspace/plasmids');
    expect(state.folders[0].addedAt).toBeGreaterThan(0);
  });

  it('hydrates files via setMockFileContent', () => {
    applyScenario({
      files: {
        '/test/hello.txt': 'Hello, World!',
      },
    });
    expect(getMockFileContent('/test/hello.txt')).toBe('Hello, World!');
  });

  it('hydrates alignment sessions with scoped stale state', () => {
    applyScenario(staleAlignmentSession());

    const state = useVerificationStore.getState();
    const refState = state.verificationState[ALIGNMENT_STALE_DOCUMENT_ID];

    expect(refState.sessions).toHaveLength(1);
    expect(refState.activeSessionId).toBe('alignment-stale-session');
    expect(refState.sessions[0].tracks[0].mutations).toHaveLength(5);
    expect(state.staleReferences[ALIGNMENT_STALE_DOCUMENT_ID]).toBe(true);
    expect(state.staleSessionIds[ALIGNMENT_STALE_DOCUMENT_ID]).toEqual(['alignment-stale-session']);
    expect(
      state.sessionViewPreferences[`${ALIGNMENT_STALE_DOCUMENT_ID}::alignment-stale-session`]
        ?.alignmentVisible
    ).toBe(true);
  });

  it('applies all domains simultaneously', () => {
    const documentId = 'fixture:sequence:apply-all-puc19';
    const scenario: AppScenario = {
      sidecar: sidecarScenarios.fullyReady(),
      canvas: {
        tabs: [
          {
            type: 'sequence',
            entityId: documentId,
            label: 'pUC19',
            sequenceDocument: { kind: 'catalog-sequence', entityId: documentId },
          },
        ],
      },
      sequences: {
        [documentId]: {
          id: documentId,
          name: 'pUC19',
          sequence: 'ATCG'.repeat(25),
          length: 100,
          annotations: [],
          circular: true,
        },
      },
      files: { '/ws/puc19.gb': 'LOCUS pUC19' },
      workspace: {
        folders: [{ path: '/ws', name: 'workspace' }],
      },
    };
    applyScenario(scenario);

    expect(global.fetch).toBeDefined();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expect(useSequenceStore.getState().sequences[documentId]).toBeDefined();
    expect(useWorkspaceStore.getState().folders).toHaveLength(1);
  });
});

describe('resetAllStores', () => {
  it('clears all stores to defaults', () => {
    applyScenario({
      canvas: {
        tabs: [{ type: 'chat', entityId: 'x', label: 'X' }],
      },
      sequences: {
        'fixture:sequence:reset-a': {
          id: 'fixture:sequence:reset-a',
          name: 'A',
          sequence: 'A',
          length: 1,
          annotations: [],
        },
      },
      workspace: {
        folders: [{ path: '/b', name: 'B' }],
      },
    });

    resetAllStores();

    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
    expect(useSequenceStore.getState().sequences).toEqual({});
    expect(useWorkspaceStore.getState().folders).toHaveLength(0);
    expect(useVerificationStore.getState().verificationState).toEqual({});
  });
});

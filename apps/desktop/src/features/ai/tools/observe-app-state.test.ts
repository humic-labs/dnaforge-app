import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import { useDesignStore } from '../../design/store';
import { useSequenceStore } from '../../sequence/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useStructureLinkRegistry } from '../../structure-drawer/state/use-structure-link-registry';
import { usePaperProtocolReviewStore } from '../../paper-protocol-review/store';
import { createDesignTool } from './create-design';
import { observeAppStateOutputSchema, observeAppStateTool as uncheckedobserveAppStateTool } from './observe-app-state';
import { execTool, resetCanvasStore } from './test-helpers';

function resetDesignStore() {
  useDesignStore.setState({
    designs: {},
    activeDesignId: null,
    pendingDispatchId: null,
  });
}

function resetWorkspaceStore() {
  useWorkspaceStore.setState({
    folders: [],
    activeWorkspaceFile: null,
    expandedPaths: new Set(),
    selectedPath: null,
    isLoading: false,
    error: null,
  });
}

describe('observe_app_state tool', () => {
  beforeEach(() => {
    resetCanvasStore();
    resetDesignStore();
    resetWorkspaceStore();
    useSequenceStore.getState().clearAll();
    useStructureLinkRegistry.setState({ links: {} });
    usePaperProtocolReviewStore.setState({
      protocols: {},
      pdfs: {},
      selectedStep: null,
      hoveredStep: null,
    });
  });

  it('returns a compact empty app-state snapshot', async () => {
    const result = await execTool<any>(observeAppStateTool, {});

    expect(result.schemaVersion).toBe(1);
    expect(result.workspace).toMatchObject({
      focusedPanelId: 'main',
      folderCount: 0,
      panelCount: 1,
      tabCount: 0,
    });
    expect(result.tabs).toEqual([]);
    expect(result.designs).toMatchObject({ count: 0, activeDesignId: null, items: [] });
    expect(result.sequences).toMatchObject({ count: 0, loadingDocumentIds: [], items: [] });
                                                        
    expect(result.structureLinks).toMatchObject({ count: 0, items: [] });
    expect(result.paperProtocolReview).toBeNull();
  });

  it('observes the selected paper candidate, evidence, revision, gaps, and dirty state', async () => {
    const protocolPath = '/lab/Protocols/Paper/.forge/protocol.json';
    usePaperProtocolReviewStore.setState({
      protocols: {
        [protocolPath]: {
          protocolPath,
          title: 'Cell lysis',
          candidate: {
            candidateSetId: 'paper-set-1',
            candidateId: 'paper-candidate-1',
            ordinal: 1,
            label: 'Cell lysis',
            status: 'selected',
          },
          draftRevision: 4,
          draftState: 'draft',
          gapCount: 1,
          sourceKinds: ['pdf'],
          sources: [],
          steps: [
            {
              id: 'paper-step-1',
              ordinal: 1,
              title: 'Lyse cells',
              anchors: [
                {
                  anchorId: 'paper-evidence-1',
                  sourceId: 'paper-source-1',
                  page: 2,
                  quote: 'Lyse cells.',
                  rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
                },
              ],
            },
          ],
        },
      },
      selectedStep: { protocolPath, stepId: 'paper-step-1' },
    });
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 'protocol-tab',
          tabs: [
            {
              id: 'protocol-tab',
              type: 'scientific-document',
              entityId: protocolPath,
              label: 'Cell lysis',
              isDirty: true,
            },
          ],
        },
      },
      focusedPanelId: 'main',
      layout: { type: 'panel', panelId: 'main' },
    });

    const result = await execTool<any>(observeAppStateTool, {});

    expect(result.paperProtocolReview).toEqual({
      displayMode: 'linked-tabs',
      protocolPath,
      candidate: expect.objectContaining({
        candidateId: 'paper-candidate-1',
        status: 'selected',
      }),
      selectedStepId: 'paper-step-1',
      selectedEvidenceIds: ['paper-evidence-1'],
      sourceRepresentations: ['pdf'],
      draftRevision: 4,
      draftState: 'draft',
      gapCount: 1,
      dirty: true,
    });
  });

  it('exposes structure-link registry entries  harness surface)', async () => {
    useStructureLinkRegistry.getState().registerLink({
      structureId: 'drawer-alphafold-P0AD86',
      sequenceDocumentId: 'sequence-document-mg1655',
      cdsLabel: 'thrL',
      translation: 'MKRISTTITTTITITTGNGAG',
      cdsStart: 100,
      cdsEnd: 162,
      strand: 1,
    });

    const result = await execTool<any>(observeAppStateTool, {});

    expect(result.structureLinks.count).toBe(1);
    expect(result.structureLinks.items[0]).toMatchObject({
      structureId: 'drawer-alphafold-P0AD86',
      sequenceDocumentId: 'sequence-document-mg1655',
      cdsLabel: 'thrL',
      cdsStart: 100,
      cdsEnd: 162,
      strand: 1,
      translationLength: 21,
    });
                                                                    
    expect(result.structureLinks.items[0]).not.toHaveProperty('translation');
  });

  it('observes a design and its open tab after create_design mutates app state', async () => {
    const created = await execTool<{ designId: string; tabId: string }>(createDesignTool, {
      name: 'example observed design',
      assemblyMethod: 'gibson',
      open: true,
    });

    const result = await execTool<any>(observeAppStateTool, {
      targetLabel: 'example observed design',
      targetDesignId: created.designId,
    });

    expect(result.workspace.tabCount).toBe(1);
    expect(result.tabs).toContainEqual(
      expect.objectContaining({
        id: created.tabId,
        type: 'design',
        entityId: created.designId,
        label: 'example observed design',
        active: true,
      })
    );
    expect(result.designs.items).toContainEqual(
      expect.objectContaining({
        id: created.designId,
        name: 'example observed design',
        assemblyMethod: 'gibson',
        assemblyState: 'preflight',
        regionCount: 0,
      })
    );
    expect(result.targets.label).toMatchObject({
      label: 'example observed design',
      present: true,
      count: 1,
      active: true,
    });
    expect(result.targets.design).toMatchObject({
      designId: created.designId,
      present: true,
      openTabs: [expect.objectContaining({ id: created.tabId, active: true })],
    });
  });

  it('observes loaded sequence summaries and sequence tab targets', async () => {
    useSequenceStore.getState().setSequence('sequence-document-puc19', {
      name: 'pUC19',
      sequence: 'ATGC',
      circular: true,
      annotations: [{ type: 'gene', start: 1, end: 4 }],
      primers: [],
    } as any);
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 'seq-tab',
          tabs: [
            {
              id: 'seq-tab',
              type: 'sequence',
              entityId: 'sequence-document-puc19',
              label: 'pUC19',
              sequenceDocument: {
                kind: 'catalog-sequence',
                entityId: 'sequence-document-puc19',
              },
            },
          ],
        },
      },
      focusedPanelId: 'main',
      layout: { type: 'panel', panelId: 'main' },
    });

    const result = await execTool<any>(observeAppStateTool, {
      targetSequenceDocumentId: 'sequence-document-puc19',
    });

    expect(result.sequences.items).toEqual([
      expect.objectContaining({
        documentId: 'sequence-document-puc19',
        name: 'pUC19',
        length: 4,
        circular: true,
        annotationCount: 1,
      }),
    ]);
    expect(result.targets.sequence).toMatchObject({
      documentId: 'sequence-document-puc19',
      present: true,
      openTabs: [expect.objectContaining({ id: 'seq-tab', label: 'pUC19', active: true })],
    });
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const observeAppStateTool = checkedToolFactory(() => uncheckedobserveAppStateTool, observeAppStateOutputSchema)();

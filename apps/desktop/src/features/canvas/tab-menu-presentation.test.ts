import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  projectTabMenuPanels,
  projectTabStripTab,
  type TabMenuPresentation,
  type TabStripPresentation,
} from './tab-menu-presentation';
import type { Tab } from './types';

describe('tab menu projection', () => {
  it('preserves a protein entity color when its editor is a record', () => {
    const tab = projectTabStripTab({
      id: 'protein-record-tab',
      type: 'record',
      entityKind: 'protein',
      entityId: 'protein-record-id',
      label: 'Saved protein',
    });
    expect(tab.type).toBe('record');
    expect(tab.iconContext?.kind).toBe('protein');
  });

  it('identifies the active package assembly editor rather than its sequence storage kind', () => {
    const tab = projectTabStripTab({
      id: 'package-tab',
      type: 'sequence',
      entityId: 'package-id',
      label: 'Saved construct',
      assemblyEditDesignId: 'package-working-copy',
      sequenceDocument: {
        kind: 'managed-sequence',
        packageId: 'package-id',
        packageRoot: '/workspace/package',
      },
    });
    expect(tab.type).toBe('design');
    expect(tab.isIndexedSequence).toBe(false);
    expect(tab).not.toHaveProperty('entityId');
    expect(tab).not.toHaveProperty('assemblyEditDesignId');
  });
  it('retains the molecular-document icon capability without exposing stored document data', () => {
    const tab = projectTabStripTab({
      id: 'molecular-tab',
      type: 'structure',
      entityId: 'molecular:one',
      label: 'Molecular view',
      initialStructureAttrs: {
        source: 'file',
        sourceId: 'coordinates',
        molecularDocumentId: 'document-one',
      },
    });
    expect(tab).toMatchObject({ isMolecularDocument: true });
    expect(tab).not.toHaveProperty('initialStructureAttrs');
  });
  it('keeps a restored molecular tab checking until it loads or reports a read failure', () => {
    const saved: Tab = {
      id: 'molecular-tab',
      type: 'structure',
      entityId: 'molecular:one',
      label: 'Molecular view',
      initialStructureAttrs: {
        source: 'file',
        molecularDocumentId: 'document-one',
        molecularDocumentPath: '/fixture/Molecular view.dnaforge-molecular.json',
      },
    };
    expect(projectTabStripTab(saved).molecularDocumentStatus).toBe('checking');
    expect(
      projectTabStripTab({ ...saved, structureRenderError: 'The saved file is damaged.' })
        .molecularDocumentStatus
    ).toBe('blocked');
  });
  it('projects tab identity and color context without source authority', () => {
    expect(
      projectTabStripTab({
        id: 'sequence-tab',
        type: 'sequence',
        entityId: 'logical-sequence-id',
        label: 'pUC19.v2.gb',
        sourceFileName: 'raw-product.gb',
        sequenceDocument: {
          kind: 'managed-sequence',
          packageId: 'logical-sequence-id',
          packageRoot: '/private/raw-package',
        },
      })
    ).toEqual({
      id: 'sequence-tab',
      type: 'sequence',
      iconContext: { kind: 'sequence', molecule: undefined, path: 'raw-product.gb' },
      label: 'pUC19.v2',
      isDirty: false,
      isIndexedSequence: false,
    });
    expectTypeOf<TabStripPresentation>().not.toHaveProperty('sourceFileName');
    expectTypeOf<TabStripPresentation>().not.toHaveProperty('sequenceDocument');
    expectTypeOf<TabStripPresentation>().not.toHaveProperty('entityId');
  });

  it('projects names and capabilities without giving the menu any source filename, receipt or path', () => {
    const panels = projectTabMenuPanels({
      main: {
        id: 'main',
        activeTabId: 'sequence-tab',
        tabs: [
          {
            id: 'sequence-tab',
            type: 'sequence',
            entityId: 'logical-sequence-id',
            label: 'pBR322 Follow-up.gb',
            sourceFileName: 'unrelated-raw-product.gb',
            sequenceDocument: {
              kind: 'managed-sequence',
              packageId: 'logical-sequence-id',
              packageRoot: '/private/raw-import__seq_123',
            },
          },
        ],
      },
    });
    expect(panels.main.tabs).toEqual([
      {
        id: 'sequence-tab',
        type: 'sequence',
        label: 'pBR322 Follow-up',
        isDirty: false,
        canRenameManagedSequence: true,
        canRevealInWorkspace: true,
      },
    ]);
    expectTypeOf<TabMenuPresentation>().not.toHaveProperty('sourceFileName');
    expectTypeOf<TabMenuPresentation>().not.toHaveProperty('quickLookSource');
    expectTypeOf<TabMenuPresentation>().not.toHaveProperty('sequenceDocument');
  });
});

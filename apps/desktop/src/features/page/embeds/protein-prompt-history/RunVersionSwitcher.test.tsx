/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { initializeTestSchema } from '../../../../test/initializeTestSchema';
import { createEntityReference } from '../../../../db/entity-references';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { createMolecularComparison } from '../structure3d/utils/molecularComparison';
import { coordinateDigest, molecularViewSchema } from '../structure3d/utils/molecularView';
import { useCanvasStore } from '../../../canvas/public/store';
import {
  applyProteinRunVersionToTab,
  applyProteinSavedViewReferenceToTab,
  getOrCreateProteinComparisonReference,
} from './RunVersionSwitcher';

const coordinateText = 'HEADER SAVED VIEW\nEND\n';
const coordinateSha256 = 'd475d1656749714ddef3f00c0f07674d39db634924dd7a3e022f19b2b82ae04c';

describe('saved protein run version navigation', () => {
  beforeEach(async () => {
    await initializeTestSchema();
    useCanvasStore.getState().reset();
  });

  it('replaces the view in the same tab and keeps the comparison notebook beside it', async () => {
    const savedViewId = 'saved-view:00000000-0000-4000-8000-000000000042';
    const reference = await createEntityReference({
      entityType: 'structure',
      displayLabel: 'Streptavidin pocket · v4',
      locator: `entity://structure/${savedViewId}`,
      deepLinkParams: null,
      data: {
        kind: 'molecular-view',
        version: 1,
        title: 'Streptavidin pocket · v4',
        caption: 'The binding interface.',
        scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
        coordinates: { format: 'pdb', text: coordinateText, sha256: coordinateSha256 },
        source: { source: 'pdb', sourceId: '1MK5' },
        evidence: [],
        preview: 'data:image/png;base64,AAAA',
        createdAt: 1,
      },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    const canvas = useCanvasStore.getState();
    const notebookTabId = canvas.openTab('main', {
      type: 'page',
      entityId: 'page-protein-prompt-trials-v1',
      label: 'Protein trials',
    });
    const rightPanelId = canvas.splitPanel('main', 'vertical');
    const structureTabId = canvas.openTab(rightPanelId, {
      type: 'structure',
      entityId: 'saved-view:00000000-0000-4000-8000-000000000031',
      label: 'Streptavidin pocket · v3',
      proteinRunPreview: true,
      viewState: { highlightGroups: [] },
      pendingViewState: { highlightGroups: [] },
    });
    const beforeTabCount = useCanvasStore.getState().panels[rightPanelId].tabs.length;

    await expect(
      applyProteinRunVersionToTab(
        rightPanelId,
        structureTabId,
        'saved-view:00000000-0000-4000-8000-000000000031',
        {
          resultId: 'result-v4',
          referenceId: reference.id,
          savedViewId,
          label: 'Evidence + context · v4',
          recordedAt: 40,
          coordinateSha256: 'f'.repeat(64),
        }
      )
    ).rejects.toThrow('pinned coordinates');
    expect(
      useCanvasStore.getState().panels[rightPanelId].tabs.find((tab) => tab.id === structureTabId)
        ?.entityId
    ).toBe('saved-view:00000000-0000-4000-8000-000000000031');

    await expect(
      applyProteinSavedViewReferenceToTab(
        rightPanelId,
        structureTabId,
        'saved-view:00000000-0000-4000-8000-000000000031',
        reference,
        'f'.repeat(64)
      )
    ).rejects.toThrow('pinned coordinates');

    await applyProteinRunVersionToTab(
      rightPanelId,
      structureTabId,
      'saved-view:00000000-0000-4000-8000-000000000031',
      {
        resultId: 'result-v4',
        referenceId: reference.id,
        savedViewId,
        label: 'Evidence + context · v4',
        recordedAt: 40,
        coordinateSha256,
      }
    );

    const state = useCanvasStore.getState();
    expect(state.panels[rightPanelId].tabs).toHaveLength(beforeTabCount);
    expect(state.panels[rightPanelId].activeTabId).toBe(structureTabId);
    expect(state.panels.main.activeTabId).toBe(notebookTabId);
    expect(state.panels.main.tabs.find((tab) => tab.id === notebookTabId)?.entityId).toBe(
      'page-protein-prompt-trials-v1'
    );
    expect(state.panels[rightPanelId].tabs.find((tab) => tab.id === structureTabId)).toMatchObject({
      entityId: savedViewId,
      label: 'Streptavidin pocket · v4',
      initialStructureAttrs: {
        coordinateSha256,
        molViewSpec: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
      },
      viewState: undefined,
      pendingViewState: undefined,
    });
  });

  it('opens and reuses a comparison of persisted multi-resource outputs with exact assets', async () => {
    const builder = MVSData.createBuilder();
    builder
      .download({ url: 'structure.pdb' })
      .parse({ format: 'pdb' })
      .modelStructure()
      .component({ selector: 'protein' })
      .representation({ type: 'cartoon' });
    const source = async (title: string, text: string) => ({
      referenceId: crypto.randomUUID(),
      view: molecularViewSchema.parse({
        kind: 'molecular-view',
        version: 1,
        title,
        caption: title,
        scene: MVSData.toMVSJ(builder.getState()),
        coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
        source: { source: 'file' },
        evidence: [],
        preview: 'data:image/png;base64,AAAA',
        createdAt: 1,
      }),
    });
    const a = await source('First', coordinateText);
    const b = await source('Second', 'HEADER SECOND\nEND\n');
    const views = await Promise.all([
      createMolecularComparison('First saved output', [a, b]),
      createMolecularComparison('Second saved output', [b, a]),
    ]);
    const structures = await Promise.all(
      views.map(async (view) => {
        const savedViewId = 'saved-view:' + crypto.randomUUID();
        const row = await createEntityReference({
          entityType: 'structure',
          displayLabel: view.title,
          locator: 'entity://structure/' + savedViewId,
          deepLinkParams: null,
          data: view,
          source: 'ai',
          workspaceScope: null,
          workspaceRootPath: null,
        });
        return {
          referenceId: row.id,
          savedViewId,
          label: view.title,
          coordinateSha256: view.coordinates.sha256,
        };
      })
    );
    const opened = await getOrCreateProteinComparisonReference(structures);
    expect(opened.comparison.version).toBe(2);
    if (opened.comparison.version !== 2) return;
    expect(opened.comparison.pinnedAssets).toHaveLength(1);
    expect(opened.comparison.coordinates.sha256).toBe(a.view.coordinates.sha256);
    expect(opened.comparison.pinnedAssets[0]).toMatchObject({
      sha256: b.view.coordinates.sha256,
      sourceReferenceId: structures[1].referenceId,
    });
    expect((await getOrCreateProteinComparisonReference(structures)).reference.id).toBe(
      opened.reference.id
    );
  });
});

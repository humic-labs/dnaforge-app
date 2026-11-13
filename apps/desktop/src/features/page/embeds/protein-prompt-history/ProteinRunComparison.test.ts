/** @vitest-environment jsdom */
import { beforeEach, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { initializeTestSchema } from '../../../../test/initializeTestSchema';
import {
  createEntityReference,
  getEntityReferenceByLocator,
} from '../../../../db/entity-references';
import { coordinateDigest } from '../structure3d/utils/molecularView';
import { useCanvasStore } from '../../../canvas/public/store';
import { applyProteinComparisonToTab } from './RunVersionSwitcher';

function scene() {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.pdb' })
    .parse({ format: 'pdb' })
    .modelStructure()
    .component({ selector: 'protein' })
    .representation({ type: 'cartoon' });
  return MVSData.toMVSJ(builder.getState());
}

beforeEach(async () => {
  await initializeTestSchema();
  useCanvasStore.getState().reset();
});

it('opens and reopens one durable comparison without changing either frozen source view', async () => {
  const entries = await Promise.all(
    ['Prefusion', 'Postfusion'].map(async (label, index) => {
      const text = `ATOM ${index + 1}\n`;
      const sha256 = await coordinateDigest(text);
      const savedViewId = `saved-view:rsv-${index + 1}`;
      const reference = await createEntityReference({
        entityType: 'structure',
        displayLabel: label,
        locator: `entity://structure/${savedViewId}`,
        deepLinkParams: null,
        data: {
          kind: 'molecular-view',
          version: 1,
          title: label,
          caption: label,
          scene: scene(),
          coordinates: { format: 'pdb', text, sha256 },
          source: { source: 'pdb', sourceId: String(index + 1) },
          evidence: [],
          preview: 'data:image/png;base64,AAAA',
          createdAt: 1,
        },
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: null,
      });
      return { referenceId: reference.id, savedViewId, label, coordinateSha256: sha256 };
    })
  );
  const canvas = useCanvasStore.getState();
  const notebookId = canvas.openTab('main', {
    type: 'page',
    entityId: 'page-protein-prompt-trials-v1',
    label: 'Trials',
  });
  const right = canvas.splitPanel('main', 'vertical');
  const tabId = canvas.openTab(right, {
    type: 'structure',
    entityId: entries[0].savedViewId,
    label: entries[0].label,
    proteinRunPreview: true,
  });
  const sourceBodies = await Promise.all(
    entries.map(
      async (entry) =>
        (await getEntityReferenceByLocator(`entity://structure/${entry.savedViewId}`))?.data
    )
  );

  await applyProteinComparisonToTab(right, tabId, entries[0].savedViewId, entries);
  const tab = useCanvasStore.getState().panels[right].tabs.find((item) => item.id === tabId)!;
  expect(tab.entityId).toMatch(/^saved-view:comparison:/);
  expect(tab.initialStructureAttrs?.molViewSpecAssets).toMatchObject([
    { sha256: entries[1].coordinateSha256 },
  ]);
  expect(tab.initialStructureAttrs?.molViewSpec).toContain('asset-2.pdb');
  expect(
    useCanvasStore.getState().panels.main.tabs.find((item) => item.id === notebookId)?.entityId
  ).toBe('page-protein-prompt-trials-v1');
  expect(useCanvasStore.getState().panels[right].tabs).toHaveLength(1);
  const saved = await getEntityReferenceByLocator(`entity://structure/${tab.entityId}`);
  expect(JSON.parse(saved!.data!).version).toBe(2);
  expect(
    await Promise.all(
      entries.map(
        async (entry) =>
          (await getEntityReferenceByLocator(`entity://structure/${entry.savedViewId}`))?.data
      )
    )
  ).toEqual(sourceBodies);
});

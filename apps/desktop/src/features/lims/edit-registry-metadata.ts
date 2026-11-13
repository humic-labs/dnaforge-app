import type { LimsRegistrySummary } from '../../shared/lims';
import { getCurrentCatalogFileForEntity } from '../../db/workspace-catalog';
import { openDocument } from '../document-opening/public/open-document';
import { useCanvasStore } from '../canvas/public/store';
import type { MetadataEditorTabType } from '../canvas/public/types';
import { openLimsEntity, isLimsEntityOpened } from './open-entity';

export async function editRegistryMetadata(
  summary: Pick<LimsRegistrySummary, 'id' | 'name' | 'representation'>,
  editor: MetadataEditorTabType
): Promise<void> {
  const managed = summary.representation.openTarget?.kind === 'managed_sequence';
  const file = managed ? null : await getCurrentCatalogFileForEntity(summary.id);
  let tabId: string;
  if (managed || !file) {
    const result = await openLimsEntity({
      entityId: summary.id,
      strategy: { kind: 'focused' },
    });
    if (!isLimsEntityOpened(result)) throw new Error(result.message);
    tabId = result.tabId;
  } else {
    const result = await openDocument({
      target: { kind: 'file', path: file.path },
      label: summary.name,
      placement: { kind: 'focused' },
    });
    if (result.status !== 'presented')
      throw new Error('message' in result ? result.message : result.reason);
    tabId = result.tabId;
  }
  const store = useCanvasStore.getState();
  for (const panel of Object.values(store.panels)) {
    const tab = panel.tabs.find((tab) => tab.id === tabId);
    if (tab) {
      if (tab.type !== editor)
        throw new Error('The opened document does not provide this metadata editor.');
      store.setTabViewState(panel.id, tabId, { metadataEditRequestId: crypto.randomUUID() });
      return;
    }
  }
  throw new Error('The metadata editor tab is no longer available.');
}

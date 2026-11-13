import { createEntityReference } from '../../db/entity-references';
import { getCurrentWorkspaceScope } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import { useChatStore } from '../ai/public/hooks/useChat';
import type { LimsEntity } from '../../shared/lims';
import type { ProteinResidueSelection } from './components/ProteinResidueTrack';

export async function askAiAboutProtein(
  entity: LimsEntity,
  selection: ProteinResidueSelection | null
): Promise<void> {
  const displayLabel =
    selection && selection.start !== selection.end
      ? `${entity.name} ${selection.start}-${selection.end}`
      : selection
        ? `${entity.name} residue ${selection.start}`
        : entity.name;

  const ref = await createEntityReference({
    entityType: 'protein',
    displayLabel,
    locator: `entity://protein/${entity.id}`,
    deepLinkParams: selection ? { start: selection.start, end: selection.end } : null,
    data: null,
    source: 'user',
    workspaceScope: getCurrentWorkspaceScope(),
    workspaceRootPath: null,
  });

  const { conversationId } = useCanvasStore.getState().openChatTab();
  useChatStore.getState().setPendingDraft({
    conversationId,
    references: [ref],
    text: selection
      ? `About residues ${selection.start}-${selection.end} of ${entity.name}: `
      : undefined,
  });
}

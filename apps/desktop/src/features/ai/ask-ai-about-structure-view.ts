import { getEntityReference } from '../../db/entity-references';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import { useCanvasStore } from '../canvas/public/store';
import { useChatStore } from './hooks/useChat';
import { createAskAiSelectionReference, type AskAiSelectionInput } from './ask-ai-about-selection';
import { resolveMolecularViewerSubject } from '../../shared/molecular-reference';

async function referenceForViewer({
  structureViewId,
  attrs,
  selection,
  workspaceRoot,
}: {
  structureViewId: string;
  attrs: Structure3dAttrs;
  selection: AskAiSelectionInput | null;
  workspaceRoot: string | null;
}) {
  resolveMolecularViewerSubject(structureViewId, attrs);
  const { handleMolSaveView } = await import('../agent-bridge/public/structure-tools');
  const captured = await handleMolSaveView({
    structureViewId,
    title: attrs.label?.trim() || attrs.title?.trim() || 'Current molecular view',
    caption: attrs.description ?? '',
    evidence: [],
    ...(workspaceRoot ? { destinationProject: workspaceRoot } : {}),
  });
  if (!captured.ok) throw Error(captured.error);
  const documentReference = captured.activeViewReference ?? captured.documentReference;
  if (selection) {
    if (selection.entityType !== 'structure')
      throw Error('A molecular document selection requires native residue identities.');
    return createAskAiSelectionReference({
      ...selection,
      molecularViewTarget: undefined,
      molecularDocumentReference: documentReference,
      workspaceRootPath: workspaceRoot,
    });
  }
  const { molecularDocumentReferenceRecord } =
    await import('../../shared/molecular-document-reference');
  return (
    (captured.referenceId ? await getEntityReference(captured.referenceId) : null) ??
    molecularDocumentReferenceRecord(
      captured.documentReference,
      captured.title,
      crypto.randomUUID(),
      workspaceRoot
    )
  );
}

export async function askAiAboutStructureView({
  structureViewId,
  attrs,
  selection,
  workspaceRoot,
  sourcePanelId,
}: {
  structureViewId: string;
  attrs: Structure3dAttrs;
  selection: AskAiSelectionInput | null;
  workspaceRoot: string | null;
  sourcePanelId?: string;
}) {
  const sourcePane = sourcePanelId ?? useCanvasStore.getState().focusedPanelId ?? undefined;
  const reference = await referenceForViewer({ structureViewId, attrs, selection, workspaceRoot });
  useChatStore.getState().setPendingAskAiPicker({
    contextKind: selection ? 'selection' : 'view',
    reference,
    chatWorkspacePath: workspaceRoot,
    sourcePanelId: sourcePane,
  });
  return reference;
}

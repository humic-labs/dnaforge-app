import { createEntityReference, type DBEntityReference } from '../../db/entity-references';
import { getConversation } from '../../db';
import { getCurrentWorkspaceScope, useWorkspaceStore } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import type { LayoutNode } from '../canvas/public/types';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { resolveStructureWorkspaceRoot } from '../page/public/embeds/structure3d/utils/savedSelectionPersistence';
import { structureSourceIdentityKey } from '../page/public/embeds/structure3d/utils/structureSourceIdentity';
import { useChatStore } from './hooks/useChat';
import type { ToolPartialEffect, ToolStateChange } from '../agent-bridge/public/tool-result';

export class StructureChatError extends Error {
  constructor(
    readonly code:
      | 'STRUCTURE_VIEW_NOT_OPEN'
      | 'STRUCTURE_VIEW_CHANGED'
      | 'STRUCTURE_CHAT_FAILED'
      | 'CANCELLED',
    message: string,
    readonly stateChanged: ToolStateChange = false,
    readonly partialEffects: readonly ToolPartialEffect[] = []
  ) {
    super(message);
  }
}

function panelIds(node: LayoutNode): string[] {
  return node.type === 'panel' ? [node.panelId] : node.children.flatMap(panelIds);
}

function sourceForView(structureViewId: string) {
  const canvas = useCanvasStore.getState();
  const matches = Object.values(canvas.panels).flatMap((panel) =>
    panel.tabs
      .filter(
        (tab) =>
          tab.type === 'structure' &&
          (tab.initialStructureAttrs?.structureViewIdentity?.structureViewId ?? tab.entityId) ===
            structureViewId
      )
      .map((tab) => ({ panelId: panel.id, tab }))
  );
  const source = matches.length === 1 ? matches[0] : undefined;
  const attrs = useStructure3dStore.getState().expandedStructures[structureViewId]?.data;
  if (!source || !attrs) {
    throw new StructureChatError(
      'STRUCTURE_VIEW_NOT_OPEN',
      'Open one structure tab before exploring it with AI.'
    );
  }
  return { ...source, attrs, identity: structureSourceIdentityKey(attrs) };
}

export async function openStructureChat(
  input: { structureViewId: string },
  options: { abortSignal?: AbortSignal } = {}
) {
  const effects: ToolPartialEffect[] = [];
  let stateChanged: ToolStateChange = false;
  const checkCancelled = () => {
    if (options.abortSignal?.aborted) {
      throw new StructureChatError(
        'CANCELLED',
        'Opening structure chat was cancelled.',
        stateChanged,
        effects
      );
    }
  };
  checkCancelled();
  const source = sourceForView(input.structureViewId);
  const assertCurrentSource = () => {
    let current: ReturnType<typeof sourceForView>;
    try {
      current = sourceForView(input.structureViewId);
    } catch {
      throw new StructureChatError(
        'STRUCTURE_VIEW_CHANGED',
        'The structure tab closed while chat was opening.',
        stateChanged,
        effects
      );
    }
    if (current.tab.id !== source.tab.id || current.identity !== source.identity) {
      throw new StructureChatError(
        'STRUCTURE_VIEW_CHANGED',
        'The structure changed while chat was opening. Try again.',
        stateChanged,
        effects
      );
    }
    return current;
  };
  const folders = useWorkspaceStore.getState().folders;
  const workspacePath = resolveStructureWorkspaceRoot(folders, source.attrs);
  const canvas = useCanvasStore.getState();
  const ordered = panelIds(canvas.layout);
  const index = ordered.indexOf(source.panelId);
  const adjacentId = ordered[index + 1] ?? ordered[index - 1];
  const adjacent = adjacentId ? canvas.panels[adjacentId] : undefined;
  const adjacentChat =
    adjacent?.tabs.find((tab) => tab.id === adjacent.activeTabId && tab.type === 'chat') ??
    adjacent?.tabs.find((tab) => tab.type === 'chat');
  const chat = useChatStore.getState();
  let adjacentConversation: { id: string; workspacePath: string | null } | undefined = adjacentChat
    ? chat.conversations.find((conversation) => conversation.id === adjacentChat.entityId)
    : undefined;
  if (!adjacentConversation && adjacentChat) {
    try {
      const persisted = await getConversation(adjacentChat.entityId);
      if (persisted) {
        adjacentConversation = { id: persisted.id, workspacePath: persisted.workspace_path };
      }
    } catch (error) {
      throw new StructureChatError(
        'STRUCTURE_CHAT_FAILED',
        error instanceof Error ? error.message : 'Could not read the adjacent chat.'
      );
    }
    checkCancelled();
    assertCurrentSource();
  }
  const existing =
    adjacentConversation?.workspacePath === workspacePath ? adjacentConversation : undefined;
  const locator = `entity://structure/${input.structureViewId}`;
  const draftState = useChatStore.getState();
  const pending =
    existing && draftState.pendingDraft?.conversationId === existing.id
      ? draftState.pendingDraft.references
      : [];
  const staged = existing ? (draftState.composerDrafts.get(existing.id)?.references ?? []) : [];
  let reference: DBEntityReference | undefined = [...pending, ...staged].find(
    (ref) =>
      ref.entity_type === 'structure' &&
      ref.locator === locator &&
      ref.data === null &&
      ref.deep_link_params === null
  );

  try {
    if (!reference) {
      stateChanged = 'unknown';
      reference = await createEntityReference({
        entityType: 'structure',
        displayLabel: source.attrs.label ?? source.tab.label,
        locator,
        data: null,
        deepLinkParams: null,
        source: 'user',
        workspaceScope: getCurrentWorkspaceScope(),
        workspaceRootPath: workspacePath,
      });
      stateChanged = true;
      effects.push({ kind: 'entity-reference', id: reference.id });
    }
    checkCancelled();
    assertCurrentSource();
    let conversationId: string;
    if (existing) {
      const status = await chat.switchConversation(existing.id);
      if (status !== 'applied') {
        throw new StructureChatError(
          'STRUCTURE_CHAT_FAILED',
          'Another chat selection superseded this request. Try again.',
          stateChanged,
          effects
        );
      }
      conversationId = existing.id;
    } else {
      stateChanged = 'unknown';
      conversationId = await chat.newConversation(workspacePath, {
        force: true,
        sourceConversationId: null,
      });
      stateChanged = true;
      effects.push({ kind: 'chat-conversation', id: conversationId });
    }
    checkCancelled();
    const current = assertCurrentSource();
    const placement = useCanvasStore
      .getState()
      .retargetChatTabOpposite(current.panelId, conversationId);
    useCanvasStore.getState().arrangeTwoPanels(placement.panelId, current.panelId);
    useChatStore.getState().setPendingDraft({ conversationId, references: [reference] });
    return { ...placement, structureViewId: input.structureViewId, referenceId: reference.id };
  } catch (error) {
    if (error instanceof StructureChatError) throw error;
    throw new StructureChatError(
      'STRUCTURE_CHAT_FAILED',
      error instanceof Error ? error.message : 'Could not open structure chat.',
      stateChanged,
      effects
    );
  }
}

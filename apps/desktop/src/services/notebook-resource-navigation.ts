import { platform } from '../platform';
import type {
  ProjectResourceReference,
  ResolveNotebookResourceReferenceRequest,
  ResolvedProjectResourceReference,
} from '../shared/project-resource-reference';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import { useCanvasStore } from '../features/canvas/public/store';
import { mountOwner } from './entity-navigation-resolution';
import {
  dispatchReferenceEvent,
  referenceIntent,
  type ReferenceIntent,
} from '../features/page/public/reference-workflow';

export interface ProjectResourceNavigationOptions {
  intent?: 'open' | 'reveal';
  signal?: AbortSignal;
  sourceChatConversationId?: string | null;
}

function placeResourceBesideChat(
  current: ResolvedProjectResourceReference,
  options: ProjectResourceNavigationOptions
) {
  const canvas = useCanvasStore.getState();
  const chat = options.sourceChatConversationId
    ? canvas.findTab('chat', options.sourceChatConversationId)
    : null;
  if (!chat) return null;
  if (canvas.panels[chat.panelId]?.activeTabId !== chat.tabId)
    throw new Error('The source conversation is no longer active.');
  options.signal?.throwIfAborted();
  const placement = canvas.agentContentPlacement(chat.panelId);
  const target = current.reference;
  const matches = Object.entries(useCanvasStore.getState().panels)
    .flatMap(([panelId, panel]) => panel.tabs.map((tab) => ({ panelId, tab })))
    .filter(
      ({ tab }) =>
        tab.type !== 'chat' &&
        (tab.entityId === current.path ||
          tab.trackView?.path === current.path ||
          (target.kind === 'entity' &&
            tab.entityId === target.entityId &&
            (!tab.trackView || tab.trackView.path === current.path)))
    );
  const existing = matches.find(({ panelId }) => panelId === placement.targetPanelId) ?? matches[0];
  if (existing && existing.panelId !== placement.targetPanelId)
    useCanvasStore.getState().moveTab(existing.panelId, placement.targetPanelId, existing.tab.id);
  useCanvasStore.getState().focusPanel(chat.panelId);
  return { ...placement, chat };
}

function presentResource(
  current: ResolvedProjectResourceReference,
  options: ProjectResourceNavigationOptions
) {
  options.signal?.throwIfAborted();
  const target = current.reference;
  const reveal =
    options.intent === 'reveal' || (target.kind === 'path' && target.resourceKind === 'directory');
  const path =
    target.kind === 'path'
      ? target.path
      : pathRelativeToBoundary(current.path, current.workspaceRoot);
  if (!path) throw new Error('The project resource has no presentation path.');
  const placement = reveal ? null : placeResourceBesideChat(current, options);
  return new Promise<void>((resolve, reject) => {
    const tracked = referenceIntent({});
    const abort = () => intent.finish({ kind: 'cancelled' });
    const intent: ReferenceIntent = {
      ...(placement
        ? { placement: { kind: 'panel' as const, panelId: placement.targetPanelId } }
        : {}),
      get finished() {
        return tracked.finished;
      },
      finish(disposition) {
        if (tracked.finished) return;
        tracked.finish(disposition);
        options.signal?.removeEventListener('abort', abort);
        if (placement) {
          const canvas = useCanvasStore.getState();
          const chat = options.sourceChatConversationId
            ? canvas.findTab('chat', options.sourceChatConversationId)
            : null;
          if (
            !options.signal?.aborted &&
            chat?.panelId === placement.chat.panelId &&
            chat.tabId === placement.chat.tabId &&
            canvas.panels[chat.panelId]?.activeTabId === chat.tabId
          )
            canvas.focusPanel(chat.panelId);
          if (
            placement.createdPanelId &&
            canvas.panels[placement.createdPanelId]?.tabs.length === 0
          )
            canvas.closePanel(placement.createdPanelId);
        }
        if (
          disposition.kind === 'reveal_requested' ||
          (disposition.kind === 'document' && disposition.result.status === 'presented')
        )
          resolve();
        else reject(new Error('The project resource could not be presented.'));
      },
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    dispatchReferenceEvent(
      {
        ...(target.kind === 'entity' && !reveal
          ? { entityType: 'native-catalog-exact', entityId: target.entityId }
          : { entityType: 'file', path }),
        projectId: target.projectId,
        owningRoot: current.workspaceRoot,
        label: current.label,
        action: reveal ? 'reveal' : 'open',
      },
      intent
    );
  });
}

export async function openProjectResourceReference(
  reference: string | ProjectResourceReference,
  options: ProjectResourceNavigationOptions = {}
) {
  const resolver = platform().fs.resolveProjectResourceReference;
  if (!resolver) throw new Error('Project resource references are unavailable.');
  options.signal?.throwIfAborted();
  const initial = await resolver(reference);
  options.signal?.throwIfAborted();
  await mountOwner(initial.workspaceRoot);
  options.signal?.throwIfAborted();
  const current = await resolver(initial.reference);
  options.signal?.throwIfAborted();
  return presentResource(current, options);
}

export async function openNotebookResourceReference(
  input: ResolveNotebookResourceReferenceRequest
) {
  const resolver = platform().notebook.resolveResourceReference;
  if (!resolver) throw new Error('Project resource references are unavailable.');
  const initial = await resolver(input);
  await mountOwner(initial.workspaceRoot);
  return presentResource(await resolver({ ...input, reference: initial.reference }), {});
}

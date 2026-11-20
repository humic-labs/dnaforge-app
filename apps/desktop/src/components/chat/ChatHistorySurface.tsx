import { toUserMessage } from '@waypoint/user-messages';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useAgentUserInputStore } from '../../features/ai/agent-confirm/agent-user-input-store';
import { useDestructiveConfirmStore } from '../../features/ai/agent-confirm/destructive-confirm-store';
import { useChatStore, type ConversationSummary } from '../../features/ai/hooks/useChat';
import { TAB_PORTAL_HOST_ATTACHED_EVENT } from '../../shared/tab-portal-contract';
import { safeFocus } from '../../shared/utils/safeFocus';
import { platform } from '../../platform';
import { useToastStore } from '../../stores/toast-store';
import { EditIcon, PinIcon, PlusIcon, SearchIcon, SidebarIcon, TrashIcon } from '../icons';
import { beginHistoryObservation } from '../../lib/chat-history-telemetry';
import type {
  HistoryAction,
  HistoryDetails,
  HistoryObservation,
  HistorySource,
} from '../../shared/chat-history-telemetry';
import { formatTimeAgo } from './MessageFormatting';

const PANEL_MARGIN_PX = 9;
const VIEWPORT_INSET_PX = 16;
const HEADER_ACTION_SPACE_PX = 44;

interface RenameEdit {
  conversationId: string;
  generation: number;
  title: string;
  failed: boolean;
  saving: boolean;
}

interface ChatHistorySurfaceProps {
  anchor: HTMLElement | null;
  inputRef: RefObject<HTMLTextAreaElement>;
  workspacePath: string | null;
  viewConversationId: string | null;
  conversations: ConversationSummary[];
  pinned: boolean;
  setPinned: (pinned: boolean) => void;
  isOpen: boolean;
  isVisible?: boolean;
  isBusy: boolean;
  queuedMessageCount: number;
  historyPaneGenerationId?: string | null;
  onConversationIdChange?: (
    conversationId: string,
    observed?: HistoryObservation,
    details?: Partial<HistoryDetails>
  ) => void;
  onRequestPanelFocus?: () => void;
  onPinnedLayoutChange?: (pinned: boolean) => void;
  onPause: () => void;
}

export function ChatHistorySurface({
  anchor,
  inputRef,
  workspacePath,
  viewConversationId,
  conversations,
  pinned,
  setPinned,
  isOpen,
  isVisible = isOpen,
  isBusy,
  queuedMessageCount,
  onConversationIdChange,
  historyPaneGenerationId,
  onRequestPanelFocus,
  onPinnedLayoutChange,
  onPause,
}: ChatHistorySurfaceProps) {
  const approvalConversationId = useDestructiveConfirmStore(
    (state) => state.request?.conversationId ?? null
  );
  const questionConversationId = useAgentUserInputStore(
    (state) => state.request?.conversationId ?? null
  );
  const waitingConversationId = questionConversationId || approvalConversationId;
  const anotherChatIsWaiting = Boolean(
    waitingConversationId && waitingConversationId !== viewConversationId
  );
  const newConversation = useChatStore((state) => state.newConversation);
  const switchConversation = useChatStore((state) => state.switchConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const togglePin = useChatStore((state) => state.togglePin);
  const renameConversation = useChatStore((state) => state.renameConversation);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const historyRead = useChatStore((state) => state.conversationHistoryRead);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [hoverSuppressed, setHoverSuppressed] = useState(false);
  const [titleExpanded, setTitleExpanded] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number } | null>(
    null
  );
  const [search, setSearch] = useState('');
  const filterDirty = useRef(false);
  const filterEditPane = useRef<string | null>(null);
  const filterSnapshot = useRef({
    search: '',
    count: 0,
    read: historyRead,
    pane: historyPaneGenerationId,
    open: isOpen,
  });
  const filterBoundarySnapshot = useRef<typeof filterSnapshot.current | null>(null);
  const filterBoundary = useRef<'commit' | 'cancel' | null>(null);
  const [filterCommit, setFilterCommit] = useState(0);
  const settleFilter = useCallback((boundary: 'commit' | 'cancel' = 'commit') => {
    if (!filterDirty.current) return;
    filterBoundary.current = filterBoundary.current === 'cancel' ? 'cancel' : boundary;
    filterBoundarySnapshot.current = filterSnapshot.current;
    setFilterCommit((value) => value + 1);
  }, []);
  const observe = useCallback(
    (action: HistoryAction, source: HistorySource = 'history_surface') =>
      historyPaneGenerationId
        ? beginHistoryObservation(action, source, historyPaneGenerationId)
        : null,
    [historyPaneGenerationId]
  );
  const retarget = useCallback(
    (id: string, observed: HistoryObservation | null, details?: Partial<HistoryDetails>) => {
      if (observed) onConversationIdChange?.(id, observed, details);
      else onConversationIdChange?.(id);
    },
    [onConversationIdChange]
  );
  const [renameEdit, setRenameEdit] = useState<RenameEdit | null>(null);
  const renameEditRef = useRef<RenameEdit | null>(null);
  const renameGenerationRef = useRef(0);
  const latestRenameGenerationRef = useRef(new Map<string, number>());
  const renamesInFlightRef = useRef(new Map<number, Promise<void>>());
  const failedRenameEditsRef = useRef(new Map<string, RenameEdit>());
  const [failedRenameEdits, setFailedRenameEdits] = useState<Map<string, RenameEdit>>(
    () => new Map()
  );
  const pinsInFlightRef = useRef(new Map<string, Promise<void>>());
  const [pinningConversationIds, setPinningConversationIds] = useState<Set<string>>(
    () => new Set()
  );
  const [failedPinIds, setFailedPinIds] = useState<Set<string>>(() => new Set());
  const [deletingConversationIds, setDeletingConversationIds] = useState<Set<string>>(
    () => new Set()
  );
  const [forkingConversationIds, setForkingConversationIds] = useState<Set<string>>(
    () => new Set()
  );
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const navigationRequestRef = useRef(0);
  const pendingInputFocusRef = useRef<{ conversationId: string; request: number } | null>(null);
  const newConversationInFlightRef = useRef<Promise<void> | null>(null);
  const viewConversationIdRef = useRef(viewConversationId);
  const conversationsRef = useRef(conversations);
  const isOpenRef = useRef(isOpen);
  viewConversationIdRef.current = viewConversationId;
  conversationsRef.current = conversations;
  isOpenRef.current = isOpen;

  useEffect(() => {
    const pending = pendingInputFocusRef.current;
    if (!pending) return;
    if (!isOpen || pending.request !== navigationRequestRef.current) {
      pendingInputFocusRef.current = null;
      return;
    }
    if (pending.conversationId === viewConversationId && safeFocus(inputRef.current)) {
      pendingInputFocusRef.current = null;
    }
  }, [inputRef, isOpen, viewConversationId]);

  const updateRenameEdit = useCallback((edit: RenameEdit | null) => {
    if (edit) latestRenameGenerationRef.current.set(edit.conversationId, edit.generation);
    renameEditRef.current = edit;
    setRenameEdit(edit);
  }, []);

  const updateFailedRename = useCallback((id: string, edit: RenameEdit | null) => {
    const next = new Map(failedRenameEditsRef.current);
    if (edit) next.set(id, edit);
    else next.delete(id);
    failedRenameEditsRef.current = next;
    setFailedRenameEdits(next);
  }, []);

  useLayoutEffect(() => {
    const ids = new Set(conversations.map((conversation) => conversation.id));
    const edit = renameEditRef.current;
    if (edit && !ids.has(edit.conversationId)) {
      updateRenameEdit(null);
    }
    for (const id of failedRenameEditsRef.current.keys()) {
      if (!ids.has(id)) updateFailedRename(id, null);
    }
    for (const id of latestRenameGenerationRef.current.keys()) {
      if (!ids.has(id)) {
        latestRenameGenerationRef.current.delete(id);
      }
    }
  }, [conversations, updateFailedRename, updateRenameEdit]);

  useLayoutEffect(
    () => () => {
      renameEditRef.current = null;
    },
    []
  );

  useLayoutEffect(() => {
    if (!isVisible || !onPinnedLayoutChange) return;
    onPinnedLayoutChange(pinned);
    return () => onPinnedLayoutChange(false);
  }, [isVisible, onPinnedLayoutChange, pinned]);

  useLayoutEffect(() => {
    if (!isVisible) setPosition(null);
    if (!isOpen) {
      setHoverOpen(false);
      setFocusOpen(false);
      setHoverSuppressed(false);
      setTitleExpanded(false);
    }
  }, [isOpen, isVisible]);

  useLayoutEffect(() => {
    if (!isVisible) return;
    if (!anchor) {
      setPosition(null);
      return;
    }
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => updatePosition()) : null;
    const updatePosition = (): void => {
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(rect.left + VIEWPORT_INSET_PX, VIEWPORT_INSET_PX + PANEL_MARGIN_PX);
      const panelHeight = Math.min(576, window.innerHeight - 2 * VIEWPORT_INSET_PX);
      const naturalTop = rect.top + VIEWPORT_INSET_PX - PANEL_MARGIN_PX;
      const maxTop = Math.max(
        VIEWPORT_INSET_PX,
        window.innerHeight - VIEWPORT_INSET_PX - panelHeight
      );
      const panelTop = Math.min(Math.max(naturalTop, VIEWPORT_INSET_PX), maxTop);
      const nextPosition = {
        left,
        top: panelTop + PANEL_MARGIN_PX,
        maxWidth: Math.max(
          0,
          Math.min(rect.right, window.innerWidth) - left - HEADER_ACTION_SPACE_PX
        ),
      };
      setPosition((current) =>
        current &&
        current.left === nextPosition.left &&
        current.top === nextPosition.top &&
        current.maxWidth === nextPosition.maxWidth
          ? current
          : nextPosition
      );
    };

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    observer?.observe(anchor);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, updatePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener(TAB_PORTAL_HOST_ATTACHED_EVENT, updatePosition);
    };
  }, [anchor, isVisible]);

  const dismissTransientSurface = useCallback(() => {
    if (pinned) return;
    setHoverSuppressed(true);
    setHoverOpen(false);
    setFocusOpen(false);
    safeFocus(inputRef.current);
  }, [inputRef, pinned]);

  const reportNavigationFailure = useCallback((message: string, error: unknown): void => {
    console.error(`[ChatHistorySurface] ${message}`, error);
    useToastStore
      .getState()
      .addToast(toUserMessage(message), { definition: 'chat-history-failed' });
  }, []);

  const handleNewConversation = useCallback(() => {
    if (newConversationInFlightRef.current) return newConversationInFlightRef.current;
    const request = ++navigationRequestRef.current;
    const observed = observe('new');
    settleFilter();
    const operation = (async () => {
      try {
        const nextId = await newConversation(workspacePath, {
          sourceConversationId: viewConversationId,
          ...(observed ? { history: observed } : {}),
        });
        if (request !== navigationRequestRef.current) {
          observed?.pane({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
          return;
        }
        if (isOpenRef.current) {
          pendingInputFocusRef.current = { conversationId: nextId, request };
        }
        retarget(nextId, observed);
        if (isOpenRef.current) dismissTransientSurface();
      } catch (error) {
        observed?.pane({ phase: 'error', result: 'pane_unavailable' });
        reportNavigationFailure("Couldn't start a new chat — try again.", error);
      }
    })().finally(() => {
      if (newConversationInFlightRef.current === operation) {
        newConversationInFlightRef.current = null;
      }
    });
    newConversationInFlightRef.current = operation;
    return operation;
  }, [
    dismissTransientSurface,
    newConversation,
    observe,
    retarget,
    settleFilter,
    reportNavigationFailure,
    viewConversationId,
    workspacePath,
  ]);

  const handleSwitchConversation = useCallback(
    async (id: string) => {
      const request = ++navigationRequestRef.current;
      const observed = observe('resume');
      settleFilter();
      try {
        const disposition = await switchConversation(id, {
          sourceConversationId: viewConversationId,
          workspacePath,
          ...(observed ? { history: observed } : {}),
        });
        if (disposition === 'stale') {
          observed?.pane({ phase: 'refused', result: 'pane_unavailable' });
          return;
        }
        if (request !== navigationRequestRef.current) {
          observed?.pane({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
          return;
        }
        retarget(id, observed);
        if (isOpenRef.current) dismissTransientSurface();
      } catch (error) {
        observed?.pane({ phase: 'error', result: 'pane_unavailable' });
        reportNavigationFailure("Couldn't open that chat — try again.", error);
      }
    },
    [
      dismissTransientSurface,
      observe,
      retarget,
      settleFilter,
      reportNavigationFailure,
      switchConversation,
      viewConversationId,
      workspacePath,
    ]
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const request = ++navigationRequestRef.current;
      setDeletingConversationIds((current) => new Set(current).add(id));
      const observed = observe('delete');
      settleFilter();
      try {
        const nextConversationId = observed
          ? await deleteConversation(id, observed)
          : await deleteConversation(id);
        if (id !== viewConversationIdRef.current) {
          observed?.pane({
            result: 'request_returned',
            paneRole: 'background',
            authority: 'not_attested',
          });
          return;
        }
        let destinationId = nextConversationId;
        if (!destinationId) {
          try {
            const replacementObserved = historyPaneGenerationId
              ? beginHistoryObservation(
                  'new',
                  'delete_replacement',
                  historyPaneGenerationId,
                  observed?.id
                )
              : null;
            destinationId = await newConversation(workspacePath, {
              force: true,
              sourceConversationId: null,
              ...(replacementObserved ? { history: replacementObserved } : {}),
            });
          } catch (error) {
            const fallbackId = crypto.randomUUID();
            if (id === viewConversationIdRef.current) {
              retarget(fallbackId, observed, {
                availability: 'placeholder',
                replacement: 'create_failed_placeholder',
              });
            }
            reportNavigationFailure(
              "Chat deleted, but the replacement couldn't be saved — try again.",
              error
            );
            return;
          }
        }
        if (id !== viewConversationIdRef.current) {
          observed?.pane({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
          return;
        }

        retarget(
          destinationId,
          observed,
          nextConversationId ? {} : { replacement: 'created', availability: 'cached' }
        );
        if (request === navigationRequestRef.current && isOpenRef.current) {
          dismissTransientSurface();
        }
      } catch (error) {
        observed?.pane({ phase: 'error', result: 'pane_unavailable' });
        reportNavigationFailure("Couldn't delete that chat — try again.", error);
      } finally {
        setDeletingConversationIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [
      deleteConversation,
      dismissTransientSurface,
      newConversation,
      historyPaneGenerationId,
      observe,
      retarget,
      settleFilter,
      reportNavigationFailure,
      workspacePath,
    ]
  );

  const handleForkConversation = useCallback(
    async (id: string) => {
      setForkingConversationIds((current) => new Set(current).add(id));
      try {
        const result = await platform().agentCapabilities.forkConversation({ conversationId: id });
        if (!result.ok) throw new Error(result.error);
        await loadConversations();
        const disposition = await switchConversation(result.conversationId, {
          sourceConversationId: viewConversationId,
          workspacePath,
        });
        if (disposition === 'stale') return;
        onConversationIdChange?.(result.conversationId);
        if (isOpenRef.current) dismissTransientSurface();
      } catch (error) {
        reportNavigationFailure("Couldn't fork that chat — try again.", error);
      } finally {
        setForkingConversationIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [
      dismissTransientSurface,
      loadConversations,
      onConversationIdChange,
      reportNavigationFailure,
      switchConversation,
      viewConversationId,
      workspacePath,
    ]
  );

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((conversation) => conversation.title.toLowerCase().includes(query));
  }, [conversations, search]);
  const showPanel = pinned || (isOpen && !hoverSuppressed && (hoverOpen || focusOpen));
  filterSnapshot.current = {
    search,
    count: filteredConversations.length,
    read: historyRead,
    pane: historyPaneGenerationId,
    open: isOpen,
  };
  const emitFilterBoundary = useCallback((cancel = false) => {
    if (!filterDirty.current) return;
    const snapshot = filterBoundarySnapshot.current ?? filterSnapshot.current;
    const editPane = filterEditPane.current;
    const superseded =
      snapshot.open && !filterBoundarySnapshot.current && editPane !== snapshot.pane;
    filterDirty.current = false;
    filterEditPane.current = null;
    filterBoundary.current = null;
    filterBoundarySnapshot.current = null;
    if (!editPane) return;
    const observed = beginHistoryObservation('title_filter', 'history_surface', editPane);
    const unavailable = !snapshot.read.hasLoaded;
    observed.store({
      phase: cancel || superseded ? 'cancelled' : unavailable ? 'refused' : 'result',
      result: superseded
        ? 'superseded'
        : cancel
          ? 'surface_closed'
          : unavailable
            ? 'filter_unavailable'
            : !snapshot.search.trim()
              ? 'filter_cleared'
              : snapshot.count === 0
                ? 'filter_no_match'
                : 'filter_matches',
      authority: 'loaded_titles',
      freshness: superseded
        ? 'superseded'
        : snapshot.read.status === 'ready'
          ? 'current'
          : snapshot.read.hasLoaded
            ? 'cached'
            : 'unavailable',
      matches:
        unavailable || cancel || superseded
          ? 'not_applicable'
          : snapshot.count === 0
            ? 'zero'
            : snapshot.count === 1
              ? 'one'
              : 'many',
    });
  }, []);
  useLayoutEffect(() => {
    if (filterBoundary.current) emitFilterBoundary(filterBoundary.current === 'cancel');
    else if (
      !isOpen ||
      !showPanel ||
      (filterDirty.current && filterEditPane.current !== historyPaneGenerationId)
    )
      emitFilterBoundary(true);
  }, [filterCommit, isOpen, showPanel, search, historyPaneGenerationId, emitFilterBoundary]);
  useLayoutEffect(() => () => emitFilterBoundary(true), [emitFilterBoundary]);
  const activeTitle =
    conversations.find((conversation) => conversation.id === viewConversationId)?.title?.trim() ||
    'New Chat';

  const completeRename = useCallback(
    (id: string, generation: number, retry = false) => {
      const activeEdit = renameEditRef.current;
      const edit =
        activeEdit?.conversationId === id && activeEdit.generation === generation
          ? activeEdit
          : retry
            ? failedRenameEditsRef.current.get(id)
            : null;
      if (!edit || edit.conversationId !== id || edit.generation !== generation) return;
      if (edit.failed && !retry) return;
      const inFlight = renamesInFlightRef.current.get(generation);
      if (inFlight) return inFlight;
      const title = edit.title.trim();
      if (!title) {
        observe('rename')?.store({ phase: 'refused', result: 'empty_title' });
        updateRenameEdit(null);
        return;
      }
      if (activeEdit?.generation === generation) {
        updateRenameEdit({ ...edit, failed: false, saving: true });
      }
      const observed = observe('rename', retry ? 'history_retry' : 'history_surface');
      const operation = (async () => {
        try {
          if (observed) await renameConversation(id, title, observed);
          else await renameConversation(id, title);
          observed?.pane(
            latestRenameGenerationRef.current.get(id) === generation
              ? { result: 'request_returned', authority: 'not_attested' }
              : { phase: 'cancelled', result: 'superseded', freshness: 'superseded' }
          );
          if (failedRenameEditsRef.current.get(id)?.generation === generation) {
            updateFailedRename(id, null);
          }
          if (renameEditRef.current?.generation === generation) updateRenameEdit(null);
        } catch {
          observed?.pane({ phase: 'error', result: 'request_rejected' });

          if (!conversationsRef.current.some((conversation) => conversation.id === id)) return;
          const current = renameEditRef.current;

          if (latestRenameGenerationRef.current.get(id) !== generation) return;
          const failed = { ...edit, failed: true, saving: false };
          updateFailedRename(id, failed);
          if (current?.generation === generation) {
            updateRenameEdit(failed);
          }
        }
      })().finally(() => {
        renamesInFlightRef.current.delete(generation);
      });
      renamesInFlightRef.current.set(generation, operation);
      return operation;
    },
    [observe, renameConversation, updateFailedRename, updateRenameEdit]
  );

  const handleTogglePin = useCallback(
    (id: string) => {
      const inFlight = pinsInFlightRef.current.get(id);
      if (inFlight) return inFlight;
      setPinningConversationIds((current) => new Set(current).add(id));
      setFailedPinIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      const observed = observe(
        'row_pin',
        failedPinIds.has(id) ? 'history_retry' : 'history_surface'
      );
      const operation = (async () => {
        try {
          if (observed) await togglePin(id, observed);
          else await togglePin(id);
          observed?.pane({ result: 'request_returned', authority: 'not_attested' });
        } catch {
          observed?.pane({ phase: 'error', result: 'request_rejected' });
          if (conversationsRef.current.some((conversation) => conversation.id === id)) {
            setFailedPinIds((current) => new Set(current).add(id));
          }
        } finally {
          setPinningConversationIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }
      })().finally(() => {
        pinsInFlightRef.current.delete(id);
      });
      pinsInFlightRef.current.set(id, operation);
      return operation;
    },
    [failedPinIds, observe, togglePin]
  );

  const refreshHistory = useCallback(() => {
    const observed = observe('list', 'history_retry');
    void (observed ? loadConversations(observed) : loadConversations()).catch(() => undefined);
  }, [loadConversations, observe]);

  if (!isVisible || !position) return null;
  const mode = pinned ? 'pinned' : 'floating';

  const conversationList =
    conversations.length === 0 ? (
      historyRead.status === 'ready' ? (
        <div
          className="px-3 py-4 text-center text-xs leading-5 text-fg-muted"
          data-testid="ai-history-empty"
        >
          <div>No conversations yet</div>
          <div>Chats appear here after their first message.</div>
        </div>
      ) : null
    ) : filteredConversations.length === 0 ? (
      <div
        className="px-3 py-4 text-center text-xs leading-5 text-fg-muted"
        data-testid="ai-history-no-match"
      >
        {historyRead.status === 'ready' ? 'No matching chats' : 'No matches in the saved list'}
      </div>
    ) : (
      <div className="py-1" data-testid="ai-history-list">
        {filteredConversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`group relative transition-colors wp-interactive ${
              conversation.id === viewConversationId ? 'bg-accent/10' : ''
            }`}
            data-testid="conversation-item"
            data-conversation-id={conversation.id}
          >
            {renameEdit?.conversationId === conversation.id ? (
              <div className="min-w-0 px-2.5 py-1.5">
                <input
                  type="text"
                  value={renameEdit.title}
                  onChange={(event) => {
                    updateFailedRename(conversation.id, null);
                    updateRenameEdit({
                      conversationId: conversation.id,
                      generation: ++renameGenerationRef.current,
                      title: event.target.value,
                      failed: false,
                      saving: false,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void completeRename(conversation.id, renameEdit.generation);
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      observe('rename')?.store({ phase: 'cancelled', result: 'edit_cancelled' });
                      event.stopPropagation();
                      const generation = renameEdit.generation;
                      if (latestRenameGenerationRef.current.get(conversation.id) === generation) {
                        latestRenameGenerationRef.current.delete(conversation.id);
                      }
                      if (
                        failedRenameEditsRef.current.get(conversation.id)?.generation === generation
                      ) {
                        updateFailedRename(conversation.id, null);
                      }
                      if (renameEditRef.current?.generation === generation) updateRenameEdit(null);
                    }
                  }}
                  onBlur={() => void completeRename(conversation.id, renameEdit.generation)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label="Conversation name"
                  aria-invalid={renameEdit.failed}
                  aria-busy={renameEdit.saving}
                  autoFocus
                  data-testid="ai-rename-input"
                  className="w-full rounded border border-accent bg-bg px-1 py-0.5 text-sm text-fg focus:outline-none"
                />
                {renameEdit.failed && (
                  <div className="pt-1 text-xs text-error" role="alert">
                    Couldn&apos;t rename this chat. Your edit is kept.
                    <button
                      type="button"
                      onClick={() =>
                        void completeRename(conversation.id, renameEdit.generation, true)
                      }
                      className="ml-2 underline"
                    >
                      Retry rename
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleSwitchConversation(conversation.id)}
                disabled={deletingConversationIds.has(conversation.id)}
                aria-label={`Open conversation: ${conversation.title}`}
                aria-current={conversation.id === viewConversationId ? 'page' : undefined}
                data-testid="conversation-open-button"
                className="block min-w-0 w-full cursor-pointer px-2.5 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm leading-5 text-fg">
                    {conversation.pinned && (
                      <span className="flex-shrink-0 text-accent">
                        <PinIcon filled />
                      </span>
                    )}
                    <span className="min-w-0 truncate">{conversation.title}</span>
                    {conversation.id === waitingConversationId ? (
                      <span
                        className="flex-shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold leading-4 text-amber-800 dark:text-amber-200"
                        data-testid="conversation-waiting"
                      >
                        Waiting
                      </span>
                    ) : null}
                  </div>
                  <span
                    className="ml-auto w-16 flex-shrink-0 text-right text-[11px] leading-4 text-fg-muted transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
                    data-testid="conversation-time"
                  >
                    {formatTimeAgo(conversation.updatedAt)}
                  </span>
                </div>
              </button>
            )}
            {renameEdit?.conversationId !== conversation.id && (
              <div className="pointer-events-none absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    updateRenameEdit({
                      conversationId: conversation.id,
                      generation: ++renameGenerationRef.current,
                      title:
                        failedRenameEditsRef.current.get(conversation.id)?.title ??
                        conversation.title,
                      failed: false,
                      saving: false,
                    });
                    updateFailedRename(conversation.id, null);
                  }}
                  className="p-1 text-fg-muted transition-colors wp-interactive"
                  title="Rename conversation"
                  data-testid="ai-rename-button"
                >
                  <EditIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleTogglePin(conversation.id);
                  }}
                  disabled={pinningConversationIds.has(conversation.id)}
                  className={`p-1 transition-colors ${
                    conversation.pinned ? 'text-accent' : 'text-fg-muted hover:text-accent'
                  }`}
                  title={conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
                >
                  <PinIcon filled={conversation.pinned} />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleForkConversation(conversation.id);
                  }}
                  disabled={forkingConversationIds.has(conversation.id)}
                  className="p-1 text-fg-muted transition-colors hover:text-accent disabled:opacity-40"
                  title="Fork conversation"
                  aria-label={`Fork conversation: ${conversation.title}`}
                  data-testid="ai-fork-conversation-button"
                >
                  <PlusIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteConversation(conversation.id);
                  }}
                  disabled={deletingConversationIds.has(conversation.id)}
                  className="p-1 text-fg-muted transition-colors hover:text-error"
                  title="Delete conversation"
                >
                  <TrashIcon />
                </button>
              </div>
            )}
            {renameEdit?.conversationId !== conversation.id &&
              failedRenameEdits.has(conversation.id) && (
                <div className="px-2.5 pb-1.5 text-xs text-error" role="alert">
                  Couldn&apos;t rename this chat. Your edit is kept.
                  <button
                    type="button"
                    onClick={() => {
                      const failed = failedRenameEditsRef.current.get(conversation.id);
                      if (failed) void completeRename(conversation.id, failed.generation, true);
                    }}
                    className="ml-2 underline"
                  >
                    Retry rename
                  </button>
                </div>
              )}
            {failedPinIds.has(conversation.id) && (
              <div className="px-2.5 pb-1.5 text-xs text-error" role="alert">
                Couldn&apos;t change this chat&apos;s pin.
                <button
                  type="button"
                  disabled={pinningConversationIds.has(conversation.id)}
                  onClick={() => void handleTogglePin(conversation.id)}
                  className="ml-2 underline"
                >
                  Retry pin
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    );

  return createPortal(
    <div
      data-analytics-block
      className="ph-no-capture fixed z-30 flex items-start gap-2"
      style={position}
      data-testid="ai-history-launcher"
      onPointerDownCapture={onRequestPanelFocus}
      onFocusCapture={onRequestPanelFocus}
      onMouseEnter={(event) => {
        const target = event.target as Element;
        if (
          target.closest(
            '[data-testid="ai-active-conversation-title-button"], [data-testid="ai-new-conversation-button"]'
          )
        )
          return;
        setHoverSuppressed(false);
        setHoverOpen(true);
      }}
      onMouseLeave={(event) => {
        if (!pinned) setHoverOpen(false);
        if (!event.currentTarget.contains(document.activeElement)) setHoverSuppressed(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (isBusy || queuedMessageCount > 0) {
          event.preventDefault();
          event.stopPropagation();
          onPause();
          return;
        }
        if (!pinned && showPanel) {
          settleFilter('cancel');
          event.preventDefault();
          event.stopPropagation();
          setHoverSuppressed(true);
          setHoverOpen(false);
          safeFocus(toggleButtonRef.current);
        }
      }}
    >
      <div
        className="relative h-8 w-8 flex-shrink-0"
        data-testid="ai-history-hover-boundary"
        onMouseEnter={() => {
          setHoverSuppressed(false);
          setHoverOpen(true);
        }}
        onMouseLeave={(event) => {
          if (!pinned) setHoverOpen(false);
          if (!event.currentTarget.contains(document.activeElement)) setHoverSuppressed(false);
        }}
        onFocus={() => setFocusOpen(true)}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
            setFocusOpen(false);
            setHoverSuppressed(false);
          }
        }}
      >
        <button
          ref={toggleButtonRef}
          type="button"
          onClick={() => {
            setHoverSuppressed(pinned ? true : false);
            setHoverOpen(false);
            observe('sidebar_preference')?.store({
              result: 'preference_requested',
              authority: 'local_preference',
            });
            setPinned(!pinned);
          }}
          className={`absolute left-0 top-0 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors wp-interactive hover:text-accent ${
            pinned ? 'text-accent' : 'text-fg-muted'
          }`}
          title={
            anotherChatIsWaiting
              ? 'Another chat is waiting for you'
              : pinned
                ? 'Collapse sidebar'
                : 'Conversation sidebar'
          }
          aria-label={
            anotherChatIsWaiting
              ? pinned
                ? 'Collapse conversation sidebar. Another chat is waiting for you.'
                : 'Pin conversation sidebar. Another chat is waiting for you.'
              : pinned
                ? 'Collapse conversation sidebar'
                : 'Pin conversation sidebar'
          }
          aria-expanded={showPanel}
          data-testid="ai-history-button"
        >
          <span data-testid="ai-history-pin-button">
            <SidebarIcon size={17} />
          </span>
        </button>
        {anotherChatIsWaiting ? (
          <span
            className="pointer-events-none absolute right-0 top-0 z-20 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-bg"
            data-testid="ai-history-waiting-dot"
            aria-hidden="true"
          />
        ) : null}
        {showPanel && (
          <div data-testid="ai-history-hover-surface">
            <div
              className="-m-[9px] flex max-h-[min(72vh,34rem)] w-80 flex-col overflow-hidden rounded-xl border border-border bg-bg-subtle shadow-lg"
              style={{
                maxWidth: `calc(100vw - ${position.left + VIEWPORT_INSET_PX - PANEL_MARGIN_PX}px)`,
              }}
              data-testid="ai-history-panel"
              data-history-mode={mode}
              aria-label="Conversation sidebar"
            >
              <div className="flex flex-shrink-0 items-center gap-1 p-2 pb-1">
                <div className="h-8 w-8 flex-shrink-0" aria-hidden="true" />
                <div className="relative min-w-0 flex-1">
                  <span
                    className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle"
                    aria-hidden="true"
                    data-testid="ai-history-search-icon"
                  >
                    <SearchIcon size={13} />
                  </span>
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => {
                      if (event.currentTarget.value !== search) {
                        if (!filterDirty.current)
                          filterEditPane.current = historyPaneGenerationId ?? null;
                        filterDirty.current = true;
                      }
                      setSearch(event.currentTarget.value);
                    }}
                    onBlur={() => settleFilter()}
                    aria-label="Search chats"
                    data-testid="ai-history-search"
                    className="h-8 min-w-0 w-full rounded-md border border-border bg-bg px-2 pl-7 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleNewConversation()}
                className="mx-2 mt-0.5 flex h-8 flex-shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-semibold leading-4 text-fg transition-colors wp-interactive "
                title="New conversation"
                aria-label="New conversation"
                data-testid="ai-new-conversation-button"
              >
                <PlusIcon className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                <span className="truncate">New Chat</span>
              </button>
              <div
                className="flex-shrink-0 px-3 pb-1 pt-2 text-[11px] font-medium leading-4 text-fg-subtle"
                data-testid="ai-history-recent-label"
              >
                Recent
              </div>
              <div
                className="min-h-0 flex-1 overflow-y-auto"
                data-testid="ai-history-content"
                data-history-read-status={historyRead.status}
                aria-busy={historyRead.status === 'loading'}
              >
                {historyRead.status !== 'ready' && (
                  <div
                    className="px-3 py-2 text-xs text-fg-muted"
                    data-testid="ai-history-read-state"
                    role={historyRead.status === 'error' ? 'alert' : 'status'}
                  >
                    {historyRead.status === 'idle'
                      ? 'Chat history has not loaded.'
                      : historyRead.status === 'loading'
                        ? historyRead.hasLoaded
                          ? 'Refreshing chats…'
                          : 'Loading chats…'
                        : historyRead.hasLoaded
                          ? 'Chat history could not be refreshed. The saved list may be out of date.'
                          : 'Chat history could not be loaded. Some chats may be missing.'}
                    {(historyRead.status === 'idle' || historyRead.status === 'error') && (
                      <button type="button" onClick={refreshHistory} className="ml-2 underline">
                        {historyRead.status === 'idle' ? 'Load history' : 'Retry history'}
                      </button>
                    )}
                  </div>
                )}
                {historyRead.status === 'ready' && (
                  <button
                    type="button"
                    onClick={refreshHistory}
                    className="mx-3 mb-1 text-xs text-fg-muted underline"
                  >
                    Refresh history
                  </button>
                )}
                {conversationList}
              </div>
            </div>
          </div>
        )}
      </div>
      {!showPanel && (
        <button
          type="button"
          onClick={() => void handleNewConversation()}
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors wp-interactive hover:text-accent "
          title="New conversation"
          aria-label="New conversation"
          data-testid="ai-new-conversation-button"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      )}
      {!showPanel && activeTitle !== 'New Chat' && activeTitle !== 'New conversation' && (
        <button
          type="button"
          className={`min-w-0 rounded-md bg-bg/85 px-2.5 py-1.5 text-left text-xs font-medium leading-5 text-fg shadow-sm ring-1 ring-border/70 backdrop-blur transition-[max-width] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
            titleExpanded
              ? 'max-h-[min(60vh,28rem)] max-w-[min(48rem,calc(100vw-5rem))] overflow-y-auto whitespace-pre-wrap break-words'
              : 'max-w-[min(29.5rem,calc(100vw-4.5rem))] truncate'
          }`}
          aria-label={`Conversation title: ${activeTitle}`}
          aria-expanded={titleExpanded}
          data-testid="ai-active-conversation-title-button"
          onMouseEnter={() => setTitleExpanded(true)}
          onMouseLeave={() => setTitleExpanded(false)}
          onFocus={() => setTitleExpanded(true)}
          onClick={() => setTitleExpanded(true)}
          onBlur={() => setTitleExpanded(false)}
        >
          <span data-testid="ai-active-conversation-title">{activeTitle}</span>
        </button>
      )}
    </div>,
    document.body
  );
}

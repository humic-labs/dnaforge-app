import { WorkInbox, WorkPanel } from '../features/work/public/work';
import { APP_BUILD } from '../lib/app-build';
import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { userEntityLabel, toUserMessage, userMessage } from '@waypoint/user-messages';
import { installedReleaseVersion } from '../shared/app-build-identity';
import { useEffect, useMemo, useRef, useState, useCallback, type KeyboardEvent } from 'react';
import { type RecentlyEditedItem } from '../features/home/recently-edited';
import { useRecentlyEditedSnapshot } from '../features/home/useRecentlyEditedSnapshot';
import { useChatStore } from '../features/ai/hooks/useChat';
import { useChatRouteControls } from '../features/ai/hooks/useChatRouteControls';
import { useComposerSequencePaste } from '../features/ai/paste-copied-sequence';
import type { DBEntityReference } from '../db/entity-references';
import type { AssistantHostId } from '../features/ai/assistant-hosts';
import { useCanvasStore } from '../features/canvas/store';
import { getTabIcon, getTabIconForTab } from '../features/canvas/components/Tab';
import { projectTabStripTab } from '../features/canvas/tab-menu-presentation';
import { EmptyStateChatComposer } from './chat/EmptyStateChatComposer';
import { getReleaseNote } from '../lib/release-notes';
import { stripDisplayExtension } from '../utils/fileTypes';
import { SpinnerIcon } from './icons';
import { BrandWordmarkText } from './BrandWordmark';

interface HomePanelProps {
  onNavigateToExplorer?: () => void;

  onOpenRecentlyEdited?: (item: RecentlyEditedItem) => boolean | void | Promise<boolean | void>;

  onAskAI?: (conversationId: string) => void;

  onViewReleaseNotes?: (sourceElement?: HTMLElement) => void;

  onMigrateFromBenchling?: () => void;

  workspacePath?: string | null;

  onOpenAssistantSources?: () => void;

  onConfigureHost?: (hostId: AssistantHostId) => void;

  recentlyEditedReady?: boolean;
}

export function HomePanel({
  onNavigateToExplorer,
  onOpenRecentlyEdited,
  onAskAI,
  onViewReleaseNotes,
  onMigrateFromBenchling,
  workspacePath = null,
  onOpenAssistantSources,
  onConfigureHost,
  recentlyEditedReady = true,
}: HomePanelProps) {
  const recentlyEditedSnapshot = useRecentlyEditedSnapshot();
  const recentlyEdited = recentlyEditedReady ? recentlyEditedSnapshot : [];

  const panels = useCanvasStore((s) => s.panels);
  const openTabs = useMemo(
    () =>
      Object.values(panels).flatMap((panel) =>
        panel.tabs.map((tab) => ({ panelId: panel.id, tab }))
      ),
    [panels]
  );
  const handleOpenTab = useCallback(
    (panelId: string, tabId: string) => {
      const state = useCanvasStore.getState();
      state.focusPanel(panelId);
      state.setActiveTab(panelId, tabId);
      onNavigateToExplorer?.();
    },
    [onNavigateToExplorer]
  );
  const [askAiText, setAskAiText] = useState('');
  const [askAiReferences, setAskAiReferences] = useState<DBEntityReference[]>([]);
  const [askAiError, setAskAiError] = useState<string | null>(null);
  const handleSequencePaste = useComposerSequencePaste((reference) => {
    setAskAiReferences((current) => {
      if (
        current.some(
          (existing) =>
            existing.entity_type === reference.entity_type &&
            existing.locator === reference.locator &&
            existing.deep_link_params === reference.deep_link_params
        )
      ) {
        return current;
      }
      return [...current, reference];
    });
  });
  const askAiInputRef = useRef<HTMLTextAreaElement>(null);

  const [isSendingAskAi, setIsSendingAskAi] = useState(false);
  const [openingRecentlyEditedId, setOpeningRecentlyEditedId] = useState<string | null>(null);
  const openingRecentlyEditedRef = useRef<string | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleRecentlyEditedOpen = useCallback(
    async (item: RecentlyEditedItem) => {
      if (!onOpenRecentlyEdited || openingRecentlyEditedRef.current) return;
      openingRecentlyEditedRef.current = item.id;
      setOpeningRecentlyEditedId(item.id);
      try {
        const opened = await onOpenRecentlyEdited(item);
        if (opened !== false && isMountedRef.current) onNavigateToExplorer?.();
      } catch (error) {
        console.error('[HomePanel] Recently Edited open failed:', error);
      } finally {
        openingRecentlyEditedRef.current = null;
        if (isMountedRef.current) setOpeningRecentlyEditedId(null);
      }
    },
    [onNavigateToExplorer, onOpenRecentlyEdited]
  );

  const routeControls = useChatRouteControls({ onConfigureHost, onOpenAssistantSources });

  const handleAskAiSend = useCallback(() => {
    const trimmed = askAiText.trim();
    const referenceIds = askAiReferences.map((reference) => reference.id);
    if ((!trimmed && referenceIds.length === 0) || !onAskAI || isSendingAskAi) return;

    if (routeControls.activeRouteSendBlocked) return;
    const chat = useChatStore.getState();
    setIsSendingAskAi(true);
    try {
      setAskAiError(null);

      const conversationId = crypto.randomUUID();
      let didStart = false;
      const onStarted = (startedConversationId: string) => {
        if (didStart) return;
        didStart = true;
        if (!isMountedRef.current) return;
        setAskAiText('');
        setAskAiReferences([]);
        setIsSendingAskAi(false);
        try {
          onAskAI(startedConversationId);
        } catch (handoffError) {
          console.error('[HomePanel] Ask AI handoff failed after starting the send:', handoffError);
        }
      };

      const sendPromise = chat.sendMessage(trimmed, workspacePath, conversationId, referenceIds, {
        activateConversation: true,
        onStarted,
        onNotStarted: (error) => {
          if (isMountedRef.current) setAskAiError(toUserMessage(error, 'assistant.failed'));
        },
      });
      void sendPromise
        .then(() => {
          if (didStart || !isMountedRef.current) return;
          setIsSendingAskAi(false);
        })
        .catch((sendErr) => {
          console.error('[HomePanel] Ask AI send failed:', sendErr);
          if (!didStart && isMountedRef.current) {
            setIsSendingAskAi(false);
            setAskAiError(userMessage('assistant.failed'));
          }
        });
    } catch {
      setAskAiError(userMessage('assistant.failed'));
      setIsSendingAskAi(false);
    }
  }, [
    askAiReferences,
    askAiText,
    onAskAI,
    isSendingAskAi,
    workspacePath,
    routeControls.activeRouteSendBlocked,
  ]);

  const handleAskAiKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void handleAskAiSend();
      }
    },
    [handleAskAiSend]
  );

  const installedVersion = installedReleaseVersion(APP_BUILD);
  const releaseNote = installedVersion ? getReleaseNote(installedVersion) : null;
  const hasOpenTabs = openTabs.length > 0;
  const hasRecentlyEdited = recentlyEdited.length > 0;

  return (
    <div data-testid="home-panel" className="flex-1 h-full flex flex-col overflow-hidden bg-bg">
      {routeControls.renderConnectAiModal()}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full h-full max-w-3xl mx-auto px-6 py-10 lg:px-10 flex flex-col gap-8">
          <div className="flex flex-shrink-0 items-start justify-between gap-4">
            <h1
              data-testid="home-heading"
              className="text-3xl uppercase leading-[1.08] tracking-[0.1em]"
            >
              <BrandWordmarkText />
            </h1>
            {onMigrateFromBenchling ? (
              <button
                type="button"
                onClick={onMigrateFromBenchling}
                data-testid="home-migrate-benchling"
                className={`${INTERACTION_CLASS} flex-shrink-0 rounded border border-border px-3 py-1.5 text-xs font-medium text-fg`}
              >
                Migrate from Benchling…
              </button>
            ) : null}
          </div>

          <WorkPanel mode="mine" />
          <WorkInbox />

          {(hasOpenTabs || hasRecentlyEdited) && (
            <div
              data-analytics-block="true"
              className="ph-no-capture grid flex-1 min-h-0 grid-cols-2 gap-6"
            >
              {hasOpenTabs && (
                <div className="flex min-w-0 flex-col min-h-0">
                  <h2 className="mb-2 flex-shrink-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    Open tabs
                  </h2>
                  <div className="flex flex-1 min-h-0 flex-col gap-1 overflow-y-auto pr-1">
                    {openTabs.map(({ panelId, tab }) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => handleOpenTab(panelId, tab.id)}
                        className={`${INTERACTION_CLASS} flex min-w-0 items-center gap-3 rounded px-3 py-2 text-left text-sm`}
                        data-testid={`home-open-tab-${tab.id}`}
                      >
                        {getTabIconForTab(projectTabStripTab(tab))}
                        <span className="min-w-0 flex-1 truncate font-medium text-fg">
                          {tab.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {hasRecentlyEdited && (
                <div className="flex min-w-0 flex-col min-h-0">
                  <h2 className="mb-2 flex-shrink-0 text-xs font-semibold uppercase tracking-wider text-fg-muted">
                    Recently edited
                  </h2>
                  <div
                    data-testid="home-recently-edited-list"
                    className="flex flex-1 min-h-0 flex-col gap-1 overflow-y-auto pr-1"
                  >
                    {recentlyEdited.map((item) => {
                      const isOpening = openingRecentlyEditedId === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => void handleRecentlyEditedOpen(item)}
                          disabled={openingRecentlyEditedId !== null}
                          aria-busy={isOpening}
                          className={`${INTERACTION_CLASS} flex min-w-0 items-center gap-3 rounded px-3 py-2 text-left text-sm disabled:cursor-wait`}
                          data-testid={`home-recently-edited-${item.id}`}
                        >
                          {isOpening ? (
                            <SpinnerIcon className="w-4 h-4 flex-shrink-0" />
                          ) : (
                            getTabIcon(item.open.tabType, 'w-4 h-4 flex-shrink-0 text-fg-subtle')
                          )}
                          <span className="min-w-0 flex-1 truncate font-medium text-fg">
                            {userEntityLabel(
                              stripDisplayExtension(item.title),
                              'document.untitled'
                            )}
                          </span>
                          {isOpening ? (
                            <span className="flex-shrink-0 text-xs text-fg-subtle">Opening…</span>
                          ) : (
                            item.workspaceName && (
                              <span className="flex-shrink-0 truncate text-xs text-fg-subtle">
                                {userEntityLabel(item.workspaceName, 'project.untitled')}
                              </span>
                            )
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {releaseNote && onViewReleaseNotes && (
            <button
              type="button"
              onClick={(event) => onViewReleaseNotes?.(event.currentTarget)}
              data-testid="home-whats-new"
              className="flex-shrink-0 self-start text-xs text-fg-subtle hover:text-fg hover:underline"
            >
              New in v{installedVersion} →
            </button>
          )}
        </div>
      </div>

      {}
      <div data-testid="home-ask-ai-footer" className="flex-shrink-0">
        <div className="w-full max-w-3xl mx-auto px-6 py-6 lg:px-10">
          <EmptyStateChatComposer
            input={askAiText}
            onInputChange={setAskAiText}
            onKeyDown={handleAskAiKeyDown}
            onPaste={handleSequencePaste}
            onSend={handleAskAiSend}
            sendDisabled={
              (!askAiText.trim() && askAiReferences.length === 0) ||
              routeControls.activeRouteSendBlocked ||
              isSendingAskAi
            }
            composeReferences={askAiReferences}
            onRemoveComposeReference={(id) =>
              setAskAiReferences((current) => current.filter((reference) => reference.id !== id))
            }
            sendTitle={
              routeControls.activeRouteFallbackNotice && !routeControls.activeRouteSendBlocked
                ? routeControls.activeRouteFallbackNotice
                : routeControls.activeDirectApiNeedsKey
                  ? 'Add a Direct API key before sending'
                  : routeControls.activeCliNeedsLogin
                    ? 'Sign in to this CLI host before sending'
                    : routeControls.activeHostedNeedsLogin
                      ? 'Sign in to DNAForge before sending'
                      : routeControls.activeHostedUnavailable
                        ? 'DNAForge AI is temporarily unavailable; choose another route'
                        : routeControls.activeRouteSendBlocked
                          ? 'Waiting for AI route detection'
                          : 'Send (Enter)'
            }
            isLoading={isSendingAskAi}
            inputRef={askAiInputRef}
            error={askAiError}
            onSuggestionClick={setAskAiText}
            renderAssistantRouteSelector={routeControls.renderAssistantRouteSelector}
            renderModelControls={routeControls.renderModelControls}
            renderRunningRouteStatus={() => null}
            renderRouteConfigurationPrompt={routeControls.renderRouteConfigurationPrompt}
            renderRouteCheckingStatus={routeControls.renderRouteCheckingStatus}
          />
        </div>
      </div>
    </div>
  );
}

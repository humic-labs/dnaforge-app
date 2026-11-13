import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { isReferenceCreationTool } from '../../features/ai/references/constants';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useChatStore, type PendingAskAiPicker } from '../../features/ai/hooks/useChat';
import { getConversations, getRecentMessages, type DBConversation, type DBMessage } from '../../db';
import { decodeAgentActivityMessage } from '../../features/ai/agent-activity-message';
import { isChatVisibleAgentTraceEvent } from '../../features/ai/trace-display';
import { ReferenceChip } from './ReferenceChip';
import { safeFocus } from '../../shared/utils/safeFocus';
import { FormattedMessage } from './MessageFormatting';
import { ToolResultDisplay } from './ToolResultDisplay';

const KBD_CLASS =
  'inline-flex min-w-[1.25rem] items-center justify-center rounded border border-border bg-bg px-1 py-0.5 font-sans text-[10px] leading-none text-fg-subtle';

function truncate(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const FLYOUT_WIDTH = 640;
const FLYOUT_GAP = 6;
const FLYOUT_PADDING = 8;

function clampFlyout(
  anchor: { x: number; y: number },
  cardWidth: number,
  cardHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { left: number; top: number } {
  let left = anchor.x + FLYOUT_GAP;
  if (left + cardWidth + FLYOUT_PADDING > viewportWidth) {
    left = anchor.x - cardWidth - FLYOUT_GAP;
  }
  const maxLeft = Math.max(FLYOUT_PADDING, viewportWidth - cardWidth - FLYOUT_PADDING);
  left = Math.min(Math.max(left, FLYOUT_PADDING), maxLeft);

  let top = anchor.y;
  if (top + cardHeight + FLYOUT_PADDING > viewportHeight) {
    top = anchor.y - cardHeight;
  }
  const maxTop = Math.max(FLYOUT_PADDING, viewportHeight - cardHeight - FLYOUT_PADDING);
  top = Math.min(Math.max(top, FLYOUT_PADDING), maxTop);

  return { left, top };
}

function clampIntoViewport(
  left: number,
  top: number,
  cardWidth: number,
  cardHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { left: number; top: number } {
  const maxLeft = Math.max(FLYOUT_PADDING, viewportWidth - cardWidth - FLYOUT_PADDING);
  const maxTop = Math.max(FLYOUT_PADDING, viewportHeight - cardHeight - FLYOUT_PADDING);
  return {
    left: Math.min(Math.max(left, FLYOUT_PADDING), maxLeft),
    top: Math.min(Math.max(top, FLYOUT_PADDING), maxTop),
  };
}

export function AskAiPickerHost() {
  const picker = useChatStore((s) => s.pendingAskAiPicker);
  if (!picker) return null;
  return <AskAiPicker key={picker.reference.id} picker={picker} />;
}

function AskAiPicker({ picker }: { picker: PendingAskAiPicker }) {
  const presentationOverlay = usePresentationOverlay('modal');

  const [conversations, setConversations] = useState<DBConversation[]>([]);
  const [cursor, setCursor] = useState(0);
  const [question, setQuestion] = useState(picker.seedText ?? '');
  const [previewMessages, setPreviewMessages] = useState<DBMessage[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const previewCache = useRef<Map<string, DBMessage[]>>(new Map());
  const submittingRef = useRef(false);

  const anchor = picker.anchor ?? null;
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(() =>
    anchor ? { left: anchor.x, top: anchor.y } : null
  );

  const userMovedRef = useRef(false);
  const [, setHasDragged] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  const targetCount = conversations.length + 1;
  const activeConversation = cursor === 0 ? null : (conversations[cursor - 1] ?? null);
  const destinationTitle = activeConversation
    ? activeConversation.title || 'Untitled conversation'
    : 'New chat';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const convs = await getConversations(picker.chatWorkspacePath);
      if (cancelled) return;
      const sorted = [...convs].sort((a, b) => b.updated_at - a.updated_at);
      setConversations(sorted);
      setCursor(0);
    })();
    return () => {
      cancelled = true;
    };
  }, [picker.chatWorkspacePath]);

  useEffect(() => {
    if (!activeConversation) {
      setPreviewMessages(null);
      setPreviewLoading(false);
      return;
    }
    const convId = activeConversation.id;
    const cached = previewCache.current.get(convId);
    if (cached) {
      setPreviewMessages(cached);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    void (async () => {
      const recent = await getRecentMessages(convId, 3);
      if (cancelled) return;
      const chronological = [...recent].reverse();
      previewCache.current.set(convId, chronological);
      setPreviewMessages(chronological);
      setPreviewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversation]);

  useLayoutEffect(() => {
    safeFocus(inputRef.current);
  }, []);

  const handleInputBlur = useCallback((e: ReactFocusEvent<HTMLInputElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && cardRef.current?.contains(next)) return;
    setTimeout(() => {
      const input = inputRef.current;
      if (input && input.isConnected && !cardRef.current?.contains(document.activeElement)) {
        safeFocus(input);
      }
    }, 0);
  }, []);

  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const height = cardRef.current?.getBoundingClientRect().height ?? 320;
      if (userMovedRef.current) {
        setFlyoutPos((current) => {
          if (!current) return current;
          const kept = clampIntoViewport(
            current.left,
            current.top,
            FLYOUT_WIDTH,
            height,
            window.innerWidth,
            window.innerHeight
          );
          return current.left === kept.left && current.top === kept.top ? current : kept;
        });
        return;
      }
      const next = clampFlyout(anchor, FLYOUT_WIDTH, height, window.innerWidth, window.innerHeight);
      setFlyoutPos((current) =>
        current && current.left === next.left && current.top === next.top ? current : next
      );
    };
    measure();
    window.addEventListener('resize', measure);
    const card = cardRef.current;
    const observer =
      typeof ResizeObserver !== 'undefined' && card ? new ResizeObserver(() => measure()) : null;
    if (observer && card) observer.observe(card);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    if (active && typeof (active as HTMLElement).scrollIntoView === 'function') {
      (active as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [cursor, conversations.length]);

  const cancel = useCallback(() => {
    useChatStore.getState().setPendingAskAiPicker(null);
  }, []);

  const confirmTarget = useCallback(
    async (targetCursor: number) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        const chat = useChatStore.getState();
        const targetId =
          targetCursor === 0
            ? await chat.newConversation(picker.chatWorkspacePath)
            : conversations[targetCursor - 1].id;

        const trimmed = question.trim();
        chat.setPendingDraft({
          conversationId: targetId,
          text: trimmed.length > 0 ? trimmed : undefined,
          references: [picker.reference],
        });

        chat.setAskAiInlineChat({
          conversationId: targetId,
          workspacePath: picker.chatWorkspacePath,
          anchor: picker.anchor,
          sourcePanelId: picker.sourcePanelId,
        });

        chat.setPendingAskAiPicker(null);
      } catch (error) {
        submittingRef.current = false;
        console.error('[AskAiPicker] confirm failed — leaving picker open', error);
      }
    },
    [conversations, question, picker]
  );

  const confirm = useCallback(() => confirmTarget(cursor), [confirmTarget, cursor]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, targetCount - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void confirm();
        return;
      }
    },
    [cancel, confirm, targetCount]
  );

  const handleHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!anchor || e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button, a, input, textarea, [role="button"]')) return;
      const card = cardRef.current;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const startLeft = flyoutPos?.left ?? rect.left;
      const startTop = flyoutPos?.top ?? rect.top;
      e.preventDefault();
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft,
        startTop,
      };
      userMovedRef.current = true;
      setHasDragged(true);
      setFlyoutPos({ left: startLeft, top: startTop });
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
    },
    [anchor, flyoutPos]
  );

  const handleHeaderPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const height = cardRef.current?.getBoundingClientRect().height ?? 0;
    const next = clampIntoViewport(
      drag.startLeft + (e.clientX - drag.startX),
      drag.startTop + (e.clientY - drag.startY),
      FLYOUT_WIDTH,
      height,
      window.innerWidth,
      window.innerHeight
    );
    setFlyoutPos(next);
  }, []);

  const handleHeaderPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {}
    safeFocus(inputRef.current);
  }, []);

  const outerClassName = anchor
    ? 'fixed inset-0 z-[10001]'
    : 'fixed inset-0 z-[10001] flex items-start justify-center pt-[12vh]';
  const cardBaseClass =
    'flex flex-col overflow-hidden rounded-xl border border-border bg-bg-subtle';
  const cardClassName = anchor
    ? `${cardBaseClass} shadow-lg`
    : `mx-4 w-full max-w-xl ${cardBaseClass} shadow-2xl`;
  const cardStyle: CSSProperties | undefined = anchor
    ? {
        position: 'fixed',
        left: flyoutPos?.left ?? anchor.x,
        top: flyoutPos?.top ?? anchor.y,
        width: FLYOUT_WIDTH,
      }
    : undefined;

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        data-testid="ask-ai-picker"
        data-anchored={anchor ? 'true' : 'false'}
        role="dialog"
        aria-modal="true"
        aria-label="Ask AI — choose a conversation"
        className={outerClassName}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) cancel();
        }}
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div
          ref={cardRef}
          data-testid="ask-ai-picker-card"
          className={cardClassName}
          style={cardStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {}
          <div
            data-testid="ask-ai-picker-chip"
            className={`flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 ${
              anchor ? 'cursor-grab select-none active:cursor-grabbing' : ''
            }`}
            onPointerDown={anchor ? handleHeaderPointerDown : undefined}
            onPointerMove={anchor ? handleHeaderPointerMove : undefined}
            onPointerUp={anchor ? handleHeaderPointerUp : undefined}
            onPointerCancel={anchor ? handleHeaderPointerUp : undefined}
          >
            {anchor ? (
              <span
                aria-hidden="true"
                data-testid="ask-ai-picker-drag-affordance"
                className="text-fg-subtle/60 -ml-1 select-none text-[13px] leading-none"
                title="Drag to move"
              >
                ⠿
              </span>
            ) : null}
            <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
              Ask AI about
            </span>
            <ReferenceChip reference={picker.reference} phase="draft" inline />
          </div>

          {}
          <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3">
            <div
              data-testid="ask-ai-picker-composer"
              className="flex items-center gap-2 rounded-lg border border-border bg-bg px-2 py-1.5 transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/40"
            >
              {cursor === 0 && (
                <button
                  type="button"
                  data-testid="ask-ai-picker-new-badge"
                  data-active={true}
                  onClick={() => {
                    setCursor(0);
                    safeFocus(inputRef.current);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  New chat
                </button>
              )}
              <input
                ref={inputRef}
                data-testid="ask-ai-picker-input"
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleInputBlur}
                onClick={() => setCursor(0)}
                placeholder={`Ask about this ${picker.contextKind ?? 'selection'}…`}
                aria-label={`Your question for this ${picker.contextKind ?? 'selection'}`}
                className="h-6 w-full flex-1 border-0 bg-transparent p-0 text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
            </div>
            {}
            {cursor === 0 && conversations.length > 0 ? (
              <button
                type="button"
                data-testid="ask-ai-picker-expand-hint"
                onClick={() => {
                  setCursor(1);
                  safeFocus(inputRef.current);
                }}
                className="inline-flex w-fit items-center gap-1 text-[11px] text-fg-subtle transition-colors hover:text-fg-muted focus:outline-none focus-visible:text-fg-muted"
              >
                <span aria-hidden="true">↓</span>
                earlier conversations
              </button>
            ) : null}
          </div>

          {}
          {cursor > 0 ? (
            <div className="flex min-h-[20rem]">
              <div
                ref={listRef}
                data-testid="ask-ai-picker-targets"
                role="listbox"
                aria-label="Conversation targets"
                className="max-h-72 w-2/5 space-y-0.5 overflow-y-auto border-r border-border p-1.5"
              >
                {conversations.map((conv, i) => {
                  const index = i + 1;
                  return (
                    <TargetRow
                      key={conv.id}
                      testId={`ask-ai-picker-target-${conv.id}`}
                      active={cursor === index}
                      onClick={() => {
                        if (cursor === index) {
                          void confirmTarget(index);
                        } else {
                          setCursor(index);
                          safeFocus(inputRef.current);
                        }
                      }}
                      onDoubleClick={() => void confirmTarget(index)}
                      title={conv.title || 'Untitled conversation'}
                      subtitle={new Date(conv.updated_at).toLocaleString()}
                    />
                  );
                })}
              </div>

              {}
              <div
                data-testid="ask-ai-picker-preview"
                className="flex max-h-72 w-3/5 flex-col overflow-y-auto bg-bg"
              >
                <div
                  data-testid="ask-ai-picker-adds-to"
                  className="sticky top-0 z-10 border-b border-border bg-bg px-3 py-2 text-[11px] font-medium text-fg-muted"
                >
                  → Adds to: <span className="text-fg">{truncate(destinationTitle, 40)}</span>
                </div>
                <div className="space-y-3 p-3">
                  <AskAiPickerPreview
                    isNewTarget={cursor === 0}
                    loading={previewLoading}
                    messages={previewMessages}
                    question={question}
                    reference={picker.reference}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {}
          <div
            data-testid="ask-ai-picker-hint"
            className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[11px] text-fg-muted"
          >
            <span className="flex items-center gap-1">
              <kbd className={KBD_CLASS}>↑</kbd>
              <kbd className={KBD_CLASS}>↓</kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className={KBD_CLASS}>esc</kbd>
              <span>cancel</span>
            </span>
            <button
              type="button"
              data-testid="ask-ai-picker-confirm"
              onClick={() => void confirm()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <kbd className="inline-flex min-w-[1.25rem] items-center justify-center rounded border border-accent-fg/30 bg-accent-fg/10 px-1 py-0.5 font-sans text-[10px] leading-none text-accent-fg">
                ↵
              </kbd>
              <span data-testid="ask-ai-picker-confirm-label">
                {cursor === 0 ? 'Start new chat' : `Add to "${truncate(destinationTitle)}"`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}

function AskAiPickerPreview({
  isNewTarget,
  loading,
  messages,
  question,
  reference,
}: {
  isNewTarget: boolean;
  loading: boolean;
  messages: DBMessage[] | null;
  question: string;
  reference: PendingAskAiPicker['reference'];
}) {
  if (isNewTarget) {
    return <AskAiPickerDraft variant="new" question={question} reference={reference} />;
  }
  if (loading) {
    return (
      <p data-testid="ask-ai-picker-preview-loading" className="text-xs text-fg-muted">
        Loading…
      </p>
    );
  }
  const hasMessages = messages != null && messages.length > 0;
  return (
    <>
      {hasMessages ? (
        messages.map((msg) => <AskAiPickerPreviewMessage key={msg.id} message={msg} />)
      ) : (
        <p data-testid="ask-ai-picker-preview-none" className="text-xs text-fg-muted">
          No messages yet.
        </p>
      )}
      <AskAiPickerDraft variant="append" question={question} reference={reference} />
    </>
  );
}

function AskAiPickerDraft({
  variant,
  question,
  reference,
}: {
  variant: 'new' | 'append';
  question: string;
  reference: PendingAskAiPicker['reference'];
}) {
  const trimmed = question.trim();
  return (
    <div data-testid="ask-ai-picker-draft" data-variant={variant} className="space-y-2">
      {variant === 'append' ? (
        <div
          data-testid="ask-ai-picker-draft-divider"
          className="flex items-center gap-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle"
        >
          <span className="h-px flex-1 bg-border" />
          You&apos;re adding
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="flex justify-end">
        <ReferenceChip reference={reference} phase="draft" inline />
      </div>
      {trimmed.length > 0 ? (
        <div className="flex justify-end" data-testid="ask-ai-picker-draft-bubble" data-role="user">
          <div className="max-w-[85%] rounded-2xl border border-dashed border-accent/50 bg-accent/70 px-3 py-1.5 text-xs leading-snug text-accent-fg">
            <FormattedMessage role="user" content={trimmed} />
          </div>
        </div>
      ) : null}
      <div className="flex justify-end">
        <span
          data-testid="ask-ai-picker-draft-tag"
          className="text-[10px] uppercase tracking-wide text-fg-subtle"
        >
          Draft · not sent
        </span>
      </div>
    </div>
  );
}

function AskAiPickerPreviewMessage({ message }: { message: DBMessage }) {
  if (message.role === 'user') {
    return (
      <div
        className="flex justify-end"
        data-testid="ask-ai-picker-preview-message"
        data-role="user"
      >
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-1.5 text-xs leading-snug text-accent-fg">
          <FormattedMessage role="user" content={message.content} />
        </div>
      </div>
    );
  }

  if (message.role === 'assistant') {
    return (
      <div
        className="text-xs leading-relaxed text-fg"
        data-testid="ask-ai-picker-preview-message"
        data-role="assistant"
      >
        <FormattedMessage content={message.content} />
      </div>
    );
  }

  if (message.role === 'tool') {
    if (isReferenceCreationTool(message.tool_name)) {
      try {
        const data = JSON.parse(message.content) as { referenceData?: unknown };
        if (data.referenceData) {
          return (
            <div data-testid="ask-ai-picker-preview-message" data-role="tool">
              <ReferenceChip
                reference={data.referenceData as Parameters<typeof ReferenceChip>[0]['reference']}
              />
            </div>
          );
        }
      } catch {}
    }
    return (
      <div data-testid="ask-ai-picker-preview-message" data-role="tool">
        <ToolResultDisplay toolName={message.tool_name || 'tool'} content={message.content} />
      </div>
    );
  }

  const event = decodeAgentActivityMessage(message.content);
  if (event && isChatVisibleAgentTraceEvent(event)) {
    return (
      <div
        data-testid="ask-ai-picker-preview-message"
        data-role="activity"
        className="flex items-baseline gap-1.5 text-[11px] text-accent/80 dark:text-accent/70"
      >
        <span
          aria-hidden="true"
          className="mt-[0.3rem] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent/55 dark:bg-accent/45"
        />
        <span className="min-w-0 truncate font-medium">{event.display.title}</span>
      </div>
    );
  }
  return null;
}

function TargetRow({
  testId,
  active,
  onClick,
  onDoubleClick,
  title,
  subtitle,
}: {
  testId: string;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active}
      role="option"
      aria-selected={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? 'bg-accent/10 text-accent' : 'text-fg hover:bg-bg-muted'
      }`}
    >
      <span className="truncate text-sm font-medium">{title}</span>
      <span className="truncate text-[11px] text-fg-muted">{subtitle}</span>
    </button>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { useChatStore, type AskAiInlineChat } from '../../features/ai/hooks/useChat';
import { useCanvasStore } from '../../features/canvas/store';
import { FullChatView } from '../FullChatView';
import { OpenExternalIcon } from '../icons/glyphs';

const PREFERRED_WIDTH = 720;
const PREFERRED_HEIGHT = 680;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 420;
const VIEWPORT_MARGIN = 12;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function AskAiInlineChatHost() {
  const inline = useChatStore((s) => s.askAiInlineChat);
  if (!inline) return null;

  return <AskAiInlineChat key={inline.conversationId} inline={inline} />;
}

function AskAiInlineChat({ inline }: { inline: AskAiInlineChat }) {
  const setAskAiInlineChat = useChatStore((s) => s.setAskAiInlineChat);

  const [size, setSize] = useState<{ width: number; height: number }>(() => ({
    width: clamp(PREFERRED_WIDTH, MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2),
    height: Math.min(PREFERRED_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2),
  }));
  const { width, height } = size;

  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    if (inline.anchor) {
      return {
        left: clamp(inline.anchor.x + 8, VIEWPORT_MARGIN, maxLeft),
        top: clamp(inline.anchor.y, VIEWPORT_MARGIN, maxTop),
      };
    }
    return {
      left: clamp((window.innerWidth - width) / 2, VIEWPORT_MARGIN, maxLeft),
      top: clamp(window.innerHeight * 0.1, VIEWPORT_MARGIN, maxTop),
    };
  });

  const close = useCallback(() => setAskAiInlineChat(null), [setAskAiInlineChat]);

  const openInPane = useCallback(() => {
    useCanvasStore.getState().retargetChatTabOpposite(inline.sourcePanelId, inline.conversationId);
    void useChatStore.getState().switchConversation(inline.conversationId);
    setAskAiInlineChat(null);
  }, [inline.conversationId, inline.sourcePanelId, setAskAiInlineChat]);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
  } | null>(null);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originLeft: pos.left,
        originTop: pos.top,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pos.left, pos.top]
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
      setPos({
        left: clamp(drag.originLeft + (e.clientX - drag.startX), VIEWPORT_MARGIN, maxLeft),
        top: clamp(drag.originTop + (e.clientY - drag.startY), VIEWPORT_MARGIN, maxTop),
      });
    },
    [width, height]
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const resizeRef = useRef<{
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
  } | null>(null);

  const handleResizeDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originWidth: size.width,
        originHeight: size.height,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [size.width, size.height]
  );

  const handleResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    e.stopPropagation();

    const maxWidth = window.innerWidth - VIEWPORT_MARGIN - resize.startX + resize.originWidth;
    const maxHeight = window.innerHeight - VIEWPORT_MARGIN - resize.startY + resize.originHeight;
    setSize({
      width: clamp(
        resize.originWidth + (e.clientX - resize.startX),
        MIN_WIDTH,
        Math.max(MIN_WIDTH, maxWidth)
      ),
      height: clamp(
        resize.originHeight + (e.clientY - resize.startY),
        MIN_HEIGHT,
        Math.max(MIN_HEIGHT, maxHeight)
      ),
    });
  }, []);

  const endResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  useEffect(() => {
    const onResize = () => {
      const maxW = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      const maxH = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
      const nextW = clamp(width, MIN_WIDTH, maxW);
      const nextH = clamp(height, MIN_HEIGHT, maxH);
      if (nextW !== width || nextH !== height) setSize({ width: nextW, height: nextH });
      setPos((prev) => ({
        left: clamp(prev.left, VIEWPORT_MARGIN, window.innerWidth - nextW - VIEWPORT_MARGIN),
        top: clamp(prev.top, VIEWPORT_MARGIN, window.innerHeight - nextH - VIEWPORT_MARGIN),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width, height]);

  const panelStyle: CSSProperties = { left: pos.left, top: pos.top, width, height };

  return (
    <div
      data-testid="ask-ai-inline-chat"
      data-conversation-id={inline.conversationId}
      role="dialog"
      aria-label="Ask Agent — inline chat"
      className="fixed z-[10001] flex flex-col overflow-hidden rounded-xl border border-border bg-bg-subtle shadow-2xl"
      style={panelStyle}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div
        data-testid="ask-ai-inline-chat-header"
        className="flex flex-shrink-0 cursor-grab select-none items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="flex-1 truncate text-xs font-medium text-fg">Ask Agent</span>
        <button
          type="button"
          data-testid="ask-ai-inline-open-in-pane"
          onClick={openInPane}
          title="Open in chat pane"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <OpenExternalIcon size={13} />
          <span>Open in chat pane</span>
        </button>
        <button
          type="button"
          data-testid="ask-ai-inline-close"
          onClick={close}
          title="Close"
          aria-label="Close inline chat"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <FullChatView
          scoped
          conversationId={inline.conversationId}
          workspacePath={inline.workspacePath}
          hideHeader
        />
      </div>

      <div
        data-testid="ask-ai-inline-resize"
        role="separator"
        aria-label="Resize inline chat"
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 55%, hsl(var(--color-border-hover)) 55% 62%, transparent 62% 74%, hsl(var(--color-border-hover)) 74% 81%, transparent 81%)',
        }}
      />
    </div>
  );
}

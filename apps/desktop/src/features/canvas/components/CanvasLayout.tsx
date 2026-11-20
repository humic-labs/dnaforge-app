import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel as ResizablePanel, type GroupImperativeHandle } from 'react-resizable-panels';
import { useShallow } from 'zustand/react/shallow';
import { Panel } from './Panel';
import { ResizeHandle } from './ResizeHandle';
import { TabPortalProvider } from './TabContentPortalManager';
import { useCanvasStore } from '../store';
import { useTabDrag } from '../hooks/useTabDrag';
import type { LayoutNode } from '../types';
import type { AssistantHostId } from '../../ai/public/assistant-hosts';
import {
  CANVAS_PANEL_MIN_WIDTH_PX,
  canvasMinimumWidths,
  visibleChatPanelIds,
} from './chat-history-width-lease';

const PanelRenderer = React.memo(function PanelRenderer({ panelId }: { panelId: string }) {
  const panel = useCanvasStore((state) => state.panels[panelId]);
  const isFocused = useCanvasStore((state) => state.focusedPanelId === panelId);

  if (!panel) {
    console.warn('[PanelRenderer] Panel not found:', panelId);
    return null;
  }

  return (
    <div
      className="h-full w-full"
      data-testid={`panel-${panelId}`}
      data-panel-focused={isFocused ? 'true' : 'false'}
    >
      <Panel panel={panel} isFocused={isFocused} />
    </div>
  );
});

function getNodeId(n: LayoutNode, idx: number): string {
  if (n.type === 'panel') return `panel-${n.panelId}`;
  return `split-${idx}-${getLayoutSignature(n)}`;
}

function getLayoutSignature(node: LayoutNode): string {
  if (node.type === 'panel') return node.panelId;
  return node.children.map(getLayoutSignature).join('-');
}

interface LayoutRendererProps {
  node: LayoutNode;
  defaultSize?: number;
  depth?: number;
  widthConstrained?: boolean;
  minimumWidths: ReadonlyMap<LayoutNode, number>;
  registerGroup: (id: string, depth: number, handle: GroupImperativeHandle | null) => void;
}

function readRestorableGroupLayout(handle: GroupImperativeHandle): Record<string, number> | null {
  try {
    const layout = handle.getLayout();
    return Object.keys(layout).length > 0 ? layout : null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Could not find Group with id')) {
      return null;
    }
    throw error;
  }
}

function restoreMountedGroupLayout(
  handle: GroupImperativeHandle,
  layout: Record<string, number>
): void {
  if (Object.keys(layout).length === 0) return;
  try {
    handle.setLayout(layout);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Could not find Group with id')) return;
    throw error;
  }
}

interface LayoutNodeContentProps {
  node: LayoutNode;
  depth: number;
  minimumWidths: ReadonlyMap<LayoutNode, number>;
  registerGroup: LayoutRendererProps['registerGroup'];
}

const LayoutNodeContent = React.memo(function LayoutNodeContent({
  node,
  depth,
  minimumWidths,
  registerGroup,
}: LayoutNodeContentProps) {
  if (node.type === 'panel') {
    return <PanelRenderer panelId={node.panelId} />;
  }

  if (node.type === 'split') {
    const orientation = node.direction === 'horizontal' ? 'vertical' : 'horizontal';

    const elements: React.ReactNode[] = [];
    node.children.forEach((child, index) => {
      if (index > 0) {
        elements.push(<ResizeHandle key={`handle-${index}`} direction={node.direction} />);
      }
      elements.push(
        <LayoutRenderer
          key={getNodeId(child, index)}
          node={child}
          defaultSize={node.sizes[index]}
          depth={depth + 1}
          widthConstrained={node.direction === 'vertical'}
          minimumWidths={minimumWidths}
          registerGroup={registerGroup}
        />
      );
    });

    const groupKey = `group-${orientation}-${getLayoutSignature(node)}`;

    return (
      <div className="h-full w-full">
        <Group
          key={groupKey}
          id={groupKey}
          orientation={orientation}
          groupRef={(handle) => registerGroup(groupKey, depth, handle)}
        >
          <>{elements}</>
        </Group>
      </div>
    );
  }

  return null;
});

const LayoutRenderer = React.memo(function LayoutRenderer({
  node,
  defaultSize,
  depth = 0,
  widthConstrained = false,
  minimumWidths,
  registerGroup,
}: LayoutRendererProps) {
  const panelId =
    node.type === 'panel' ? `panel-${node.panelId}` : `split-${getLayoutSignature(node)}`;

  return (
    <ResizablePanel
      id={panelId}
      defaultSize={defaultSize}
      minSize={
        widthConstrained
          ? (minimumWidths.get(node) ?? CANVAS_PANEL_MIN_WIDTH_PX)
          : CANVAS_PANEL_MIN_WIDTH_PX
      }
      className="h-full"
    >
      <div className="h-full w-full">
        <LayoutNodeContent
          node={node}
          depth={depth}
          minimumWidths={minimumWidths}
          registerGroup={registerGroup}
        />
      </div>
    </ResizablePanel>
  );
});

interface CanvasLayoutProps {
  onOpenAssistantSources?: () => void;
  onConfigureHost?: (hostId: AssistantHostId) => void;
}

export function CanvasLayout({ onOpenAssistantSources, onConfigureHost }: CanvasLayoutProps) {
  const layout = useCanvasStore((state) => state.layout);
  const chatPanelIds = useCanvasStore(useShallow(visibleChatPanelIds));
  const [pinnedPanelIds, setPinnedPanelIds] = useState<ReadonlySet<string>>(() => new Set());
  const minimumWidths = useMemo(
    () => canvasMinimumWidths(layout, chatPanelIds, pinnedPanelIds),
    [layout, chatPanelIds, pinnedPanelIds]
  );
  const groupHandlesRef = useRef(
    new Map<string, { depth: number; handle: GroupImperativeHandle }>()
  );
  const unleasedLayoutsRef = useRef<Map<string, Record<string, number>> | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const registerGroup = useCallback(
    (id: string, depth: number, handle: GroupImperativeHandle | null): void => {
      if (!handle) {
        groupHandlesRef.current.delete(id);
        return;
      }
      groupHandlesRef.current.set(id, { depth, handle });
      if (unleasedLayoutsRef.current && !unleasedLayoutsRef.current.has(id)) {
        const layout = readRestorableGroupLayout(handle);
        if (layout) unleasedLayoutsRef.current.set(id, layout);
      }
    },
    []
  );

  const handleChatHistoryPinnedChange = useCallback((panelId: string, pinned: boolean): void => {
    if (pinned && !unleasedLayoutsRef.current) {
      unleasedLayoutsRef.current = new Map();
      for (const [id, { handle }] of groupHandlesRef.current) {
        const layout = readRestorableGroupLayout(handle);
        if (layout) unleasedLayoutsRef.current.set(id, layout);
      }
    }
    setPinnedPanelIds((current) => {
      if (current.has(panelId) === pinned) return current;
      const next = new Set(current);
      if (pinned) next.add(panelId);
      else next.delete(panelId);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const baseline = unleasedLayoutsRef.current;
    if (!baseline) return;
    const frame = window.requestAnimationFrame(() => {
      const groups = Array.from(groupHandlesRef.current.entries()).sort(
        ([, a], [, b]) => a.depth - b.depth
      );
      for (const [id, { handle }] of groups) {
        const groupLayout = baseline.get(id);
        if (groupLayout) restoreMountedGroupLayout(handle, groupLayout);
      }
      if (!pinnedPanelIds.size) {
        unleasedLayoutsRef.current = null;
        return;
      }
      const focusedPanel = Array.from(
        viewportRef.current?.querySelectorAll<HTMLElement>('[data-panel-focused="true"]') ?? []
      ).find((element) => pinnedPanelIds.has(element.dataset.testid?.slice('panel-'.length) ?? ''));
      focusedPanel?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pinnedPanelIds]);

  const requiredCanvasWidth = minimumWidths.get(layout);

  useEffect(() => {
    console.log('[CanvasLayout] Layout changed:', {
      type: layout.type,
      panelId: layout.type === 'panel' ? layout.panelId : 'N/A',
      timestamp: new Date().toISOString(),
    });
  }, [layout]);

  useTabDrag();

  return (
    <TabPortalProvider
      onOpenAssistantSources={onOpenAssistantSources}
      onConfigureHost={onConfigureHost}
      onChatHistoryPinnedChange={handleChatHistoryPinnedChange}
    >
      <div ref={viewportRef} className="h-full overflow-x-auto overflow-y-hidden">
        <div
          className="relative h-full"
          style={requiredCanvasWidth ? { minWidth: requiredCanvasWidth } : undefined}
          data-testid="canvas-layout-width-surface"
        >
          {layout.type === 'panel' ? (
            <Group orientation="horizontal" key={`single-${layout.panelId}`}>
              <ResizablePanel id={`panel-${layout.panelId}`} minSize={CANVAS_PANEL_MIN_WIDTH_PX}>
                <PanelRenderer panelId={layout.panelId} />
              </ResizablePanel>
            </Group>
          ) : (
            <LayoutNodeContent
              node={layout}
              depth={0}
              minimumWidths={minimumWidths}
              registerGroup={registerGroup}
            />
          )}
        </div>
      </div>
    </TabPortalProvider>
  );
}

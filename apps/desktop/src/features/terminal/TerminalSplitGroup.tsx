import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Group, Panel, Separator, type GroupImperativeHandle } from 'react-resizable-panels';
import {
  terminalPaneSizes,
  resizeTerminalPaneSizes,
  TERMINAL_PANE_MINIMUM_PX,
} from './terminal-layout';

export interface TerminalSplitGroupHandle {
  resizePane(id: string, backward: boolean, pixels: number): void;
}

export function TerminalSplitGroup({
  id,
  sessions,
  direction = 'horizontal',
  sizes,
  onResize,
  onReady,
  children,
}: {
  id: string;
  sessions: string[];
  direction?: 'horizontal' | 'vertical';
  sizes?: Record<string, number>;
  onResize(id: string, sizes: Record<string, number>): void;
  onReady(id: string, handle: TerminalSplitGroupHandle | null): void;
  children(id: string): ReactNode;
}) {
  const layout = terminalPaneSizes(sessions, sizes);
  const group = useRef<GroupImperativeHandle>(null);
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    onReady(id, {
      resizePane: (sessionId, backward, pixels) => {
        const handle = group.current;
        if (!handle || !element.current) return;
        const available = Array.from(element.current.children)
          .filter((child) => sessions.includes(child.id))
          .reduce(
            (total, child) =>
              total +
              (direction === 'horizontal'
                ? child.getBoundingClientRect().width
                : child.getBoundingClientRect().height),
            0
          );
        const next = resizeTerminalPaneSizes(
          sessions,
          handle.getLayout(),
          sessionId,
          backward,
          pixels,
          available
        );
        if (next) handle.setLayout(next);
      },
    });
    return () => onReady(id, null);
  }, [id, onReady, sessions, direction]);
  const minimumExtent =
    sessions.length * TERMINAL_PANE_MINIMUM_PX + Math.max(0, sessions.length - 1) * 4;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        width: '100%',
        overflow: 'auto',
      }}
    >
      <Group
        groupRef={group}
        elementRef={element}
        id={`terminal-${id}`}
        orientation={direction}
        defaultLayout={layout}
        onLayoutChanged={(layout) => onResize(id, layout)}
        style={{
          height: direction === 'vertical' ? `max(100%, ${minimumExtent}px)` : '100%',
          width: direction === 'horizontal' ? `max(100%, ${minimumExtent}px)` : '100%',
        }}
      >
        {sessions.map((sessionId, index) => (
          <Fragment key={sessionId}>
            {index > 0 && (
              <Separator
                aria-label={`Resize terminal panes ${index} and ${index + 1}`}
                className={`dnaforge-terminal-split-resizer ${direction}`}
              />
            )}
            <Panel
              id={sessionId}
              minSize={`${TERMINAL_PANE_MINIMUM_PX}px`}
              defaultSize={`${layout[sessionId]}%`}
            >
              {children(sessionId)}
            </Panel>
          </Fragment>
        ))}
      </Group>
    </div>
  );
}

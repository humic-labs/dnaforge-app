import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/ui-persistence';
import { ColumnResizeHandle } from '../ui';

interface WorkspaceSidebarProps {
  visible: boolean;
  width: number;
  onWidthCommit: (width: number) => void;
  filesPanelActive: boolean;
  tools: ReactNode;
  files: ReactNode;
  ariaLabel?: string;
  testId?: string;
}

interface SidebarResizeDrag {
  width: number;
  finish: (commit: boolean) => void;
}

export function WorkspaceSidebar({
  visible,
  width,
  onWidthCommit,
  filesPanelActive,
  tools,
  files,
  ariaLabel,
  testId = 'files-sidebar',
}: WorkspaceSidebarProps) {
  const [liveWidth, setLiveWidth] = useState(width);
  const dragRef = useRef<SidebarResizeDrag | null>(null);
  const previousPropsRef = useRef({ width, visible });
  const onWidthCommitRef = useRef(onWidthCommit);

  useLayoutEffect(() => {
    onWidthCommitRef.current = onWidthCommit;
    const previous = previousPropsRef.current;
    previousPropsRef.current = { width, visible };
    if (width !== previous.width) {
      dragRef.current?.finish(false);
      setLiveWidth(width);
    } else if (previous.visible && !visible) {
      dragRef.current?.finish(true);
    }
  }, [width, visible, onWidthCommit]);

  useLayoutEffect(() => () => dragRef.current?.finish(false), []);

  const handleResizeStart = (event: MouseEvent<HTMLDivElement>) => {
    if (!visible) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = dragRef.current?.width ?? liveWidth;
    dragRef.current?.finish(false);

    const drag: SidebarResizeDrag = {
      width: startWidth,
      finish: (commit) => {
        if (dragRef.current !== drag) return;
        dragRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', endDrag);
        window.removeEventListener('blur', endDrag);
        if (commit) onWidthCommitRef.current(drag.width);
      },
    };
    const handleMouseMove = (move: globalThis.MouseEvent) => {
      if (dragRef.current !== drag) return;
      drag.width = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + move.clientX - startX)
      );
      setLiveWidth(drag.width);
    };
    const endDrag = () => drag.finish(true);
    dragRef.current = drag;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', endDrag);
    window.addEventListener('blur', endDrag);
  };

  return (
    <>
      <aside
        data-testid={testId}
        aria-label={ariaLabel}
        aria-hidden={!visible}
        className={`border-r border-border bg-bg-subtle flex flex-col ${
          visible
            ? 'relative flex-shrink-0'
            : 'absolute top-0 left-0 bottom-0 invisible pointer-events-none'
        }`}
        style={{ width: liveWidth } as CSSProperties}
      >
        {visible ? tools : null}
        <div
          className={
            filesPanelActive
              ? 'flex-1 overflow-y-auto'
              : 'absolute top-0 left-0 right-0 bottom-0 overflow-y-auto invisible pointer-events-none'
          }
        >
          {files}
        </div>
      </aside>
      {visible && (
        <ColumnResizeHandle testId="files-sidebar-resize-handle" onMouseDown={handleResizeStart} />
      )}
    </>
  );
}

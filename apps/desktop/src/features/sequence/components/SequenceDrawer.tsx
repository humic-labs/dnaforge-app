import { useCallback, useRef } from 'react';

interface SequenceDrawerProps {
  width: number;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}

export function SequenceDrawer({ width, onWidthChange, children }: SequenceDrawerProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      const paintedWidth = e.currentTarget.parentElement?.getBoundingClientRect().width;
      startWidth.current = paintedWidth && paintedWidth > 0 ? paintedWidth : width;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = startX.current - moveEvent.clientX;
        onWidthChange(startWidth.current + delta);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, onWidthChange]
  );

  return (
    <div
      className="h-full border-l border-border bg-bg flex"
      style={{ width: `${width}px`, flexShrink: 1, minWidth: 0, maxWidth: '100%' }}
    >
      <div
        data-testid="drawer-drag-handle"
        className="w-1 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />
      <div className="flex-1 min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

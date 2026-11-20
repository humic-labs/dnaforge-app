import { Separator } from 'react-resizable-panels';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
}

export function ResizeHandle({ direction }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';

  return (
    <Separator
      onPointerDown={(event) => {
        if (event.isPrimary && event.button === 0)
          event.currentTarget.setPointerCapture(event.pointerId);
      }}
      className={`
        group relative
        ${isHorizontal ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize'}
        bg-border hover:bg-accent/50 active:bg-accent
        transition-colors duration-150
      `}
    >
      {}
      <div
        className={`
          absolute inset-0
          ${isHorizontal ? '-top-1 -bottom-1' : '-left-1 -right-1'}
        `}
      />
    </Separator>
  );
}

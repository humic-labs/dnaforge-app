export interface JunctionAssemblyHighlightSegment {
  id: string;
  owner: 'left' | 'right' | 'spacer';
  left: number;
  width: number;
  color: string;
  backgroundColor: string;
}

export interface JunctionAssemblyHighlightCursor {
  id: string;
  left: number;
  color: string;
  label: string;
}

const OVERLAP_BOUNDARY_WIDTH_PX = 0;
const OVERLAP_BOUNDARY_HEIGHT_PX = 52;
const OVERLAP_BOUNDARY_COLOR = 'transparent';

interface JunctionAssemblyHighlightOverlayProps {
  rowKind: string;
  height: number;
  segments: JunctionAssemblyHighlightSegment[];
  cursors: JunctionAssemblyHighlightCursor[];
}

export function JunctionAssemblyHighlightOverlay({
  rowKind,
  height,
  cursors,
}: JunctionAssemblyHighlightOverlayProps) {
  if (cursors.length === 0) return null;
  const cursorHeight = Math.min(height, OVERLAP_BOUNDARY_HEIGHT_PX);
  const cursorTop = Math.max(0, height - cursorHeight);

  return (
    <div
      data-testid={`junction-assembly-highlight-overlay-${rowKind}`}
      className="absolute inset-0 z-[8] pointer-events-none"
      style={{ height }}
    >
      {cursors.map((cursor) => (
        <div
          key={cursor.id}
          data-testid={`junction-assembly-highlight-cursor-${rowKind}-${cursor.id}`}
          data-linked-pan-exclude="true"
          data-highlight-cursor-passive="true"
          data-highlight-cursor-hidden="true"
          data-overlap-boundary-role={cursor.id}
          data-overlap-canonical-left-px={cursor.left}
          aria-label={cursor.label}
          className="absolute -translate-x-1/2 pointer-events-none"
          style={{
            left: cursor.left,
            top: cursorTop,
            width: OVERLAP_BOUNDARY_WIDTH_PX,
            height: cursorHeight,
            backgroundColor: OVERLAP_BOUNDARY_COLOR,
            cursor: 'ew-resize',
          }}
        />
      ))}
    </div>
  );
}

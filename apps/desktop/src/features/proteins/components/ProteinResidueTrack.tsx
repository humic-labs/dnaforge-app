import { useCallback, useRef, useState } from 'react';

export interface ProteinResidueSelection {
  start: number;
  end: number;
}

export interface ProteinResidueTrackProps {
  bases: string;
  onContextMenu: (info: {
    x: number;
    y: number;
    selection: ProteinResidueSelection | null;
  }) => void;
}

const RESIDUES_PER_ROW = 60;

export function ProteinResidueTrack({ bases, onContextMenu }: ProteinResidueTrackProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [selection, setSelection] = useState<ProteinResidueSelection | null>(null);
  const anchorRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  const extendSelection = useCallback((from: number, to: number) => {
    setSelection({ start: Math.min(from, to), end: Math.max(from, to) });
  }, []);

  const handleMouseDown = useCallback(
    (position: number, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (e.shiftKey && anchorRef.current !== null) {
        extendSelection(anchorRef.current, position);
      } else {
        anchorRef.current = position;
        setSelection({ start: position, end: position });
      }
      isDraggingRef.current = true;
    },
    [extendSelection]
  );

  const handleMouseEnterResidue = useCallback(
    (position: number) => {
      setHovered(position);
      if (isDraggingRef.current && anchorRef.current !== null) {
        extendSelection(anchorRef.current, position);
      }
    },
    [extendSelection]
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu({ x: e.clientX, y: e.clientY, selection });
    },
    [onContextMenu, selection]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setSelection(null);
      anchorRef.current = null;
    }
  }, []);

  const rows: Array<{ start: number; residues: string[] }> = [];
  for (let i = 0; i < bases.length; i += RESIDUES_PER_ROW) {
    rows.push({ start: i + 1, residues: bases.slice(i, i + RESIDUES_PER_ROW).split('') });
  }

  return (
    <div
      data-testid="protein-residue-track"
      className="font-mono text-xs leading-relaxed text-fg outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onMouseUp={handleMouseUp}
      onMouseLeave={() => setHovered(null)}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="group"
      aria-label="Protein sequence"
    >
      {rows.map((row) => (
        <div key={row.start} className="flex gap-3">
          <span
            className="w-12 flex-shrink-0 select-none text-right text-fg-subtle"
            aria-hidden="true"
          >
            {row.start}
          </span>
          <span className="flex flex-wrap">
            {row.residues.map((residue, idx) => {
              const position = row.start + idx;
              const isSelected =
                selection !== null && position >= selection.start && position <= selection.end;
              const isHovered = hovered === position;
              const showLabel = (position - 1) % 10 === 0;
              return (
                <span
                  key={position}
                  data-testid={`protein-residue-${position}`}
                  data-position={position}
                  className={[
                    'relative inline-flex h-4 w-[9px] select-none items-center justify-center',
                    isSelected ? 'bg-accent/30' : isHovered ? 'bg-bg-muted' : '',
                  ].join(' ')}
                  onMouseDown={(e) => handleMouseDown(position, e)}
                  onMouseEnter={() => handleMouseEnterResidue(position)}
                  title={showLabel ? `${position}` : undefined}
                >
                  {residue}
                </span>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

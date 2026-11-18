import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  memo,
  KeyboardEvent,
  forwardRef,
  useImperativeHandle,
} from 'react';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import { INTERACTION_CLASS } from '../menu/appearance';

const ROW_HEIGHT = 42;
const OVERSCAN = 15;

interface EnzymeCutCountSummary {
  count: number;
  capped: boolean;
}

const RecognitionWithCuts = memo(function RecognitionWithCuts({
  enzyme,
}: {
  enzyme: RestrictionEnzyme;
}): React.ReactElement {
  const seq = enzyme.recognition_sequence || '';
  const cutTop = enzyme.cut_position_top;
  const cutBottom = enzyme.cut_position_bottom;

  if (!seq) {
    return (
      <span
        style={{ fontFamily: 'monospace', fontSize: '11px', color: 'hsl(var(--color-fg-subtle))' }}
      >
        —
      </span>
    );
  }

  const minCut = Math.min(cutTop !== null ? cutTop : 0, cutBottom !== null ? cutBottom : 0);
  const maxCut = Math.max(
    cutTop !== null ? cutTop : seq.length,
    cutBottom !== null ? cutBottom : seq.length
  );

  const leftPad = minCut < 0 ? Math.abs(minCut) : 0;
  const rightPad = maxCut >= seq.length ? maxCut - seq.length + 1 : 0;

  const displayChars: Array<{ char: string; isPad: boolean }> = [];

  for (let i = 0; i < leftPad; i++) {
    displayChars.push({ char: 'N', isPad: true });
  }
  for (const char of seq) {
    displayChars.push({ char, isPad: false });
  }
  for (let i = 0; i < rightPad; i++) {
    displayChars.push({ char: 'N', isPad: true });
  }

  const adjustedCutTop = cutTop !== null ? cutTop + leftPad : null;
  const adjustedCutBottom = cutBottom !== null ? cutBottom + leftPad : null;

  return (
    <div style={cutStyles.container}>
      {}
      <div style={cutStyles.caretRow}>
        {displayChars.map((_, i) => (
          <span key={`top-${i}`} style={cutStyles.caretCell}>
            {adjustedCutTop !== null && i === adjustedCutTop && (
              <span style={cutStyles.topCaret}>▼</span>
            )}
          </span>
        ))}
      </div>
      {}
      <div style={cutStyles.seqRow}>
        {displayChars.map((item, i) => (
          <span
            key={`seq-${i}`}
            style={{
              ...cutStyles.seqChar,
              color: item.isPad ? 'hsl(var(--color-fg-subtle))' : 'hsl(var(--color-fg))',
            }}
          >
            {item.char}
          </span>
        ))}
      </div>
      {}
      <div style={cutStyles.caretRow}>
        {displayChars.map((_, i) => (
          <span key={`bot-${i}`} style={cutStyles.caretCell}>
            {adjustedCutBottom !== null && i === adjustedCutBottom && (
              <span style={cutStyles.bottomCaret}>▲</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
});

const cutStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    lineHeight: 1,
  },
  caretRow: {
    display: 'flex',
    height: '6px',
  },
  caretCell: {
    width: '7px',
    position: 'relative',
  },
  topCaret: {
    fontSize: '6px',
    color: '#0891b2',
    position: 'absolute',
    left: 0,
    bottom: '1px',
    transform: 'translateX(-50%)',
  },
  bottomCaret: {
    fontSize: '6px',
    color: '#0891b2',
    position: 'absolute',
    left: 0,
    top: '1px',
    transform: 'translateX(-50%)',
  },
  seqRow: {
    display: 'flex',
  },
  seqChar: {
    width: '7px',
    textAlign: 'center',
    fontFamily: 'monospace',
    fontSize: '11px',
    color: 'hsl(var(--color-fg))',
  },
};

interface EnzymeListProps {
  enzymes: RestrictionEnzyme[];
  highlightedIndex: number;
  onSelect: (enzyme: RestrictionEnzyme) => void;
  onHighlightChange: (index: number) => void;
  onArrowUp: () => void;
  activeEnzymeNames: Set<string>;
  maxHeight?: number;
  scrollToHighlight?: boolean;
  onEnzymeHover?: (enzyme: RestrictionEnzyme | null) => void;
  cutCounts?: Map<string, EnzymeCutCountSummary>;
  cutCountsLoading?: boolean;
  cutCountLimit?: number;
}

interface EnzymeRowProps {
  enzyme: RestrictionEnzyme;
  index: number;
  isHighlighted: boolean;
  isActive: boolean;
  onSelect: (enzyme: RestrictionEnzyme) => void;
  onHighlightChange: (index: number) => void;
  onEnzymeHover?: (enzyme: RestrictionEnzyme | null) => void;
  cutCountSummary?: EnzymeCutCountSummary;
  cutCountsLoading?: boolean;
  cutCountLimit: number;
  top: number;
}

const EnzymeRow = memo(function EnzymeRow({
  enzyme,
  index,
  isHighlighted,
  isActive,
  onSelect,
  onHighlightChange,
  onEnzymeHover,
  cutCountSummary,
  cutCountsLoading,
  cutCountLimit,
  top,
}: EnzymeRowProps) {
  const cutCountLabel =
    cutCountSummary !== undefined
      ? cutCountSummary.capped
        ? `>${cutCountLimit} cuts`
        : cutCountSummary.count === 1
          ? '1 cut'
          : `${cutCountSummary.count} cuts`
      : cutCountsLoading
        ? 'scanning...'
        : undefined;

  return (
    <div
      data-testid="enzyme-row"
      data-enzyme-name={enzyme.name}
      className={INTERACTION_CLASS}
      data-active={isHighlighted}
      data-selected={isActive}
      onClick={() => onSelect(enzyme)}
      onMouseEnter={() => {
        onHighlightChange(index);
        onEnzymeHover?.(enzyme);
      }}
      onMouseLeave={() => onEnzymeHover?.(null)}
      style={{
        ...styles.item,
        position: 'absolute',
        top,
        left: 0,
        right: 0,
        height: ROW_HEIGHT,
        boxSizing: 'border-box',
      }}
    >
      <div style={styles.enzymeName}>
        {enzyme.name}
        {isActive && <span style={styles.activeIndicator}>✓</span>}
        {cutCountLabel !== undefined && <span style={styles.cutCount}>{cutCountLabel}</span>}
      </div>
      <RecognitionWithCuts enzyme={enzyme} />
    </div>
  );
});

export interface EnzymeListHandle {
  focus: () => void;
  scrollToHighlighted: () => void;
}

export const EnzymeList = forwardRef<EnzymeListHandle, EnzymeListProps>(function EnzymeList(
  {
    enzymes,
    highlightedIndex,
    onSelect,
    onHighlightChange,
    onArrowUp,
    activeEnzymeNames,
    maxHeight = 200,
    scrollToHighlight = false,
    onEnzymeHover,
    cutCounts,
    cutCountsLoading = false,
    cutCountLimit = 10,
  },
  ref
): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const isKeyboardNav = useRef(false);

  const totalHeight = enzymes.length * ROW_HEIGHT;
  const visibleCount = Math.ceil(maxHeight / ROW_HEIGHT);
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    enzymes.length,
    Math.floor(scrollTop / ROW_HEIGHT) + visibleCount + OVERSCAN
  );

  const scrollToHighlightedItem = useCallback(() => {
    if (highlightedIndex < 0 || !containerRef.current) return;
    const itemTop = highlightedIndex * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    const { scrollTop: st, clientHeight } = containerRef.current;
    if (itemTop < st) {
      containerRef.current.scrollTop = itemTop;
    } else if (itemBottom > st + clientHeight) {
      containerRef.current.scrollTop = itemBottom - clientHeight;
    }
  }, [highlightedIndex]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      containerRef.current?.focus();
    },
    scrollToHighlighted: () => {
      if (highlightedIndex >= 0 && containerRef.current) {
        const itemTop = highlightedIndex * ROW_HEIGHT;
        const clientH = containerRef.current.clientHeight;
        containerRef.current.scrollTop = itemTop - clientH / 2 + ROW_HEIGHT / 2;
      }
    },
  }));

  useEffect(() => {
    if (scrollToHighlight) {
      if (highlightedIndex >= 0 && containerRef.current) {
        const itemTop = highlightedIndex * ROW_HEIGHT;
        const clientH = containerRef.current.clientHeight;
        containerRef.current.scrollTop = itemTop - clientH / 2 + ROW_HEIGHT / 2;
      }
    }
  }, [scrollToHighlight, highlightedIndex]);

  useEffect(() => {
    if (isKeyboardNav.current) {
      scrollToHighlightedItem();
      isKeyboardNav.current = false;
    }
  }, [highlightedIndex, scrollToHighlightedItem]);

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        isKeyboardNav.current = true;
        if (highlightedIndex < enzymes.length - 1) {
          onHighlightChange(highlightedIndex + 1);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        isKeyboardNav.current = true;
        if (highlightedIndex > 0) {
          onHighlightChange(highlightedIndex - 1);
        } else {
          onArrowUp();
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && enzymes[highlightedIndex]) {
          onSelect(enzymes[highlightedIndex]);
        }
        break;
    }
  };

  if (enzymes.length === 0) {
    return <div style={{ ...styles.container, ...styles.emptyState }}>No enzymes found</div>;
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      onMouseLeave={() => onEnzymeHover?.(null)}
      style={{ ...styles.container, maxHeight, position: 'relative' }}
    >
      {}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {enzymes.slice(startIndex, endIndex).map((enzyme, i) => {
          const index = startIndex + i;
          return (
            <EnzymeRow
              key={enzyme.name}
              enzyme={enzyme}
              index={index}
              isHighlighted={index === highlightedIndex}
              isActive={activeEnzymeNames.has(enzyme.name)}
              onSelect={onSelect}
              onHighlightChange={onHighlightChange}
              onEnzymeHover={onEnzymeHover}
              cutCountSummary={cutCounts?.get(enzyme.name)}
              cutCountsLoading={cutCountsLoading}
              cutCountLimit={cutCountLimit}
              top={index * ROW_HEIGHT}
            />
          );
        })}
      </div>
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  container: {
    overflowY: 'auto',
    outline: 'none',
  },
  emptyState: {
    padding: '20px',
    textAlign: 'center',
    color: 'hsl(var(--color-fg-subtle))',
    fontSize: '13px',
  },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 12px',
    cursor: 'pointer',
    borderBottom: '1px solid hsl(var(--color-border))',
    transition: 'background-color 0.1s',
  },
  enzymeName: {
    fontWeight: 500,
    fontSize: '13px',
    color: 'hsl(var(--color-fg))',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  activeIndicator: {
    color: 'var(--interaction-selected)',
    fontSize: '12px',
  },
  cutCount: {
    fontSize: '10px',
    color: 'hsl(var(--color-fg-subtle))',
    fontWeight: 400,
  },
};

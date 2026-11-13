import React, { useState, useEffect, useRef } from 'react';
import { isGoldenGateEnzymeName, type RestrictionEnzyme } from '@waypoint/sequence-utils';

interface CutPositionInfo {
  position: number;
  recognitionStart: number;
  recognitionEnd: number;
}

interface ActiveEnzymeInfo {
  enzyme: RestrictionEnzyme;
  cutCount: number | undefined;
  cutPositions: CutPositionInfo[];
  hiddenCutPositionCount?: number;
  color: string;
  hasValidGGPair?: boolean;
}

interface ActiveEnzymeListProps {
  enzymes: ActiveEnzymeInfo[];
  onRemove: (enzymeName: string) => void;
  onClear: () => void;
  highlightEnzyme?: string | null;
  onHighlightProcessed?: () => void;
  onPositionClick?: (position: number, recognitionStart: number, recognitionEnd: number) => void;
  onPositionHover?: (
    info: {
      enzymeName: string;
      position: number;
      recognitionStart: number;
      recognitionEnd: number;
    } | null
  ) => void;
  fillHeight?: boolean;
  onVirtualDigest?: (enzymeNames: string[]) => void;
  activeVirtualDigestEnzyme?: string | null;
  activeVirtualDigestEnzymes?: string[] | null;
  isCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

function RecognitionWithCuts({ enzyme }: { enzyme: RestrictionEnzyme }): React.ReactElement {
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
  const rightPad = maxCut > seq.length ? maxCut - seq.length : 0;

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
          <div key={`top-${i}`} style={cutStyles.caretCell}>
            {adjustedCutTop === i && <span style={cutStyles.topCaret}>▼</span>}
          </div>
        ))}
      </div>
      {}
      <div style={cutStyles.seqRow}>
        {displayChars.map((c, i) => (
          <span
            key={`char-${i}`}
            style={{
              ...cutStyles.seqChar,
              color: c.isPad ? 'hsl(var(--color-fg-subtle))' : 'hsl(var(--color-fg))',
            }}
          >
            {c.char}
          </span>
        ))}
      </div>
      {}
      <div style={cutStyles.caretRow}>
        {displayChars.map((_, i) => (
          <div key={`bot-${i}`} style={cutStyles.caretCell}>
            {adjustedCutBottom === i && <span style={cutStyles.bottomCaret}>▲</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const cutStyles: Record<string, React.CSSProperties> = {
  container: {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    lineHeight: 1,
    cursor: 'text',
    userSelect: 'all',
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
  },
};

export function ActiveEnzymeList({
  enzymes,
  onRemove,
  onClear,
  highlightEnzyme,
  onHighlightProcessed,
  onPositionClick,
  onPositionHover,
  fillHeight = false,
  onVirtualDigest,
  activeVirtualDigestEnzyme,
  activeVirtualDigestEnzymes,
  isCollapsed: externalIsCollapsed,
  onCollapsedChange,
}: ActiveEnzymeListProps): React.ReactElement {
  const [internalIsCollapsed, setInternalIsCollapsed] = useState(false);
  const [flashingEnzyme, setFlashingEnzyme] = useState<string | null>(null);
  const [hoveredPositionKey, setHoveredPositionKey] = useState<string | null>(null);

  const isCollapsed = externalIsCollapsed ?? internalIsCollapsed;
  const setIsCollapsed = (collapsed: boolean) => {
    if (onCollapsedChange) {
      onCollapsedChange(collapsed);
    } else {
      setInternalIsCollapsed(collapsed);
    }
  };
  const [isFading, setIsFading] = useState(false);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (!highlightEnzyme) return;

    setIsCollapsed(false);

    setFlashingEnzyme(highlightEnzyme);
    setIsFading(false);

    requestAnimationFrame(() => {
      const element = itemRefs.current.get(highlightEnzyme);
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    const fadeTimer = setTimeout(() => {
      setIsFading(true);
    }, 1000);

    const clearTimer = setTimeout(() => {
      setFlashingEnzyme(null);
      setIsFading(false);
    }, 1500);

    onHighlightProcessed?.();

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [highlightEnzyme, onHighlightProcessed]);

  const containerStyle = fillHeight
    ? {
        ...styles.container,
        flex: 1,
        display: 'flex',
        flexDirection: 'column' as const,
        minHeight: 0,
      }
    : styles.container;

  const listStyle = fillHeight ? { ...styles.list, flex: 1, maxHeight: 'none' } : styles.list;

  if (enzymes.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={styles.header}>
          <span style={styles.title}>Active Enzymes</span>
        </div>
        <div style={styles.emptyState}>No enzymes selected. Search and click to add.</div>
      </div>
    );
  }

  const digestibleEnzymes = enzymes.filter(
    ({ cutCount }) => cutCount !== undefined && cutCount >= 1
  );
  const digestibleEnzymeNames = digestibleEnzymes.map(({ enzyme }) => enzyme.name);
  const activeDigestKey = activeVirtualDigestEnzymes?.length
    ? activeVirtualDigestEnzymes.join('\u0000')
    : (activeVirtualDigestEnzyme ?? '');
  const digestibleKey = digestibleEnzymeNames.join('\u0000');

  return (
    <div style={containerStyle}>
      <div style={styles.header}>
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          style={styles.collapseButton}
          title={isCollapsed ? 'Expand' : 'Collapse'}
        >
          <span
            style={{
              ...styles.collapseIcon,
              transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            }}
          >
            ▼
          </span>
          <span style={styles.title}>Active Enzymes ({enzymes.length})</span>
        </button>
        <div style={styles.headerRight}>
          {}
          {digestibleEnzymes.length > 0 && onVirtualDigest && (
            <div style={styles.virtualDigestDropdown}>
              <button
                data-testid="virtual-digest-toggle"
                onClick={() => onVirtualDigest(digestibleEnzymeNames)}
                style={{
                  ...styles.virtualDigestButton,
                  ...(activeDigestKey === digestibleKey ? styles.virtualDigestButtonActive : {}),
                }}
                title={
                  digestibleEnzymes.length === 1
                    ? `Virtual digest with ${digestibleEnzymes[0].enzyme.name}`
                    : `Virtual digest with active enzymes: ${digestibleEnzymeNames.join(', ')}`
                }
              >
                {digestibleEnzymes.length === 1
                  ? 'Virtual Digest'
                  : `Digest Active (${digestibleEnzymes.length})`}
              </button>
            </div>
          )}
          <button onClick={onClear} style={styles.clearButton}>
            Clear all
          </button>
        </div>
      </div>
      {!isCollapsed && (
        <div style={listStyle}>
          {enzymes.map(
            ({
              enzyme,
              cutCount,
              cutPositions,
              hiddenCutPositionCount = 0,
              color,
              hasValidGGPair,
            }) => {
              const isHighlighted = flashingEnzyme === enzyme.name;
              const bgColor = isHighlighted
                ? isFading
                  ? 'transparent'
                  : '#fef3c7'
                : 'transparent';
              return (
                <div
                  key={enzyme.name}
                  ref={(el) => {
                    if (el) itemRefs.current.set(enzyme.name, el);
                  }}
                  style={{
                    ...styles.item,
                    borderLeft: `3px solid ${color}`,
                    backgroundColor: bgColor,
                    transition: 'background-color 0.5s ease-out',
                  }}
                >
                  <div style={styles.enzymeRow}>
                    <div style={styles.leftSection}>
                      <span style={{ ...styles.enzymeName, color }}>{enzyme.name}</span>
                      {isGoldenGateEnzymeName(enzyme.name) && (
                        <span
                          style={{
                            ...styles.ggBadge,
                            ...(hasValidGGPair ? styles.ggBadgeReady : styles.ggBadgeNotReady),
                          }}
                          title={
                            hasValidGGPair
                              ? `GoldenGate ready (has forward + reverse sites)`
                              : `Not GoldenGate ready (need one forward and one reverse site)`
                          }
                        >
                          GG
                        </span>
                      )}
                      <RecognitionWithCuts enzyme={enzyme} />
                    </div>
                    <div style={styles.rightSection}>
                      <span style={styles.cutCount}>
                        {cutCount === undefined
                          ? '— cuts'
                          : cutCount === 0
                            ? 'No cuts'
                            : cutCount === 1
                              ? '1 cut'
                              : `${cutCount} cuts`}
                      </span>
                      <button
                        onClick={() => onRemove(enzyme.name)}
                        style={styles.removeButton}
                        title={`Remove ${enzyme.name}`}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  {}
                  {cutPositions.length > 0 && (
                    <div style={styles.positionsContainer}>
                      <span style={styles.positionsLabel}>cuts at</span>
                      <div
                        style={styles.positionsScroll}
                        onMouseLeave={() => {
                          onPositionHover?.(null);
                          setHoveredPositionKey(null);
                        }}
                      >
                        {cutPositions.map((posInfo) => {
                          const chipKey = `${enzyme.name}-${posInfo.position}`;
                          const isHovered = hoveredPositionKey === chipKey;
                          return (
                            <button
                              key={posInfo.position}
                              onClick={() =>
                                onPositionClick?.(
                                  posInfo.position,
                                  posInfo.recognitionStart,
                                  posInfo.recognitionEnd
                                )
                              }
                              onMouseEnter={() => {
                                setHoveredPositionKey(chipKey);
                                onPositionHover?.({
                                  enzymeName: enzyme.name,
                                  position: posInfo.position,
                                  recognitionStart: posInfo.recognitionStart,
                                  recognitionEnd: posInfo.recognitionEnd,
                                });
                              }}
                              onMouseLeave={() => setHoveredPositionKey(null)}
                              style={{
                                ...styles.positionChip,
                                ...(isHovered ? styles.positionChipHover : {}),
                              }}
                              title={`Go to position ${posInfo.position}`}
                            >
                              {posInfo.position}
                            </button>
                          );
                        })}
                        {hiddenCutPositionCount > 0 && (
                          <span style={styles.hiddenPositionsLabel}>
                            +{hiddenCutPositionCount.toLocaleString()} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            }
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderTop: '1px solid hsl(var(--color-border))',
    backgroundColor: 'hsl(var(--color-bg-subtle))',
    userSelect: 'none',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid hsl(var(--color-border))',
  },
  collapseButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  },
  collapseIcon: {
    fontSize: '8px',
    color: 'hsl(var(--color-fg-muted))',
    transition: 'transform 0.15s ease',
  },
  title: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'hsl(var(--color-fg))',
  },
  clearButton: {
    background: 'none',
    border: 'none',
    color: 'hsl(var(--color-fg-muted))',
    fontSize: '11px',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: '4px',
  },
  list: {
    maxHeight: '200px',
    overflowY: 'auto',
  },
  item: {
    padding: '8px 12px',
    borderBottom: '1px solid hsl(var(--color-border))',
  },
  enzymeRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  leftSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  rightSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
  enzymeName: {
    fontWeight: 500,
    fontSize: '13px',
    color: 'hsl(var(--color-fg))',
    minWidth: '70px',
  },
  cutCount: {
    fontSize: '10px',
    color: 'hsl(var(--color-fg-subtle))',
    backgroundColor: 'hsl(var(--color-bg-muted))',
    padding: '1px 5px',
    borderRadius: '8px',
  },
  ggBadge: {
    fontSize: '9px',
    fontWeight: 600,
    padding: '1px 4px',
    borderRadius: '3px',
    letterSpacing: '0.3px',
    flexShrink: 0,
  },
  ggBadgeReady: {
    color: '#059669',
    backgroundColor: '#d1fae5',
  },
  ggBadgeWarning: {
    color: '#d97706',
    backgroundColor: '#fef3c7',
  },
  ggBadgeNotReady: {
    color: 'hsl(var(--color-fg-muted))',
    backgroundColor: 'hsl(var(--color-bg-muted))',
  },
  virtualDigestButton: {
    fontSize: '10px',
    fontWeight: 500,
    color: '#6366f1',
    backgroundColor: '#eef2ff',
    border: '1px solid #c7d2fe',
    padding: '2px 6px',
    borderRadius: '4px',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'all 0.15s ease',
  },
  virtualDigestButtonActive: {
    backgroundColor: '#6366f1',
    color: '#ffffff',
    borderColor: '#6366f1',
  },
  removeButton: {
    background: 'none',
    border: 'none',
    color: 'hsl(var(--color-fg-subtle))',
    fontSize: '16px',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: '1',
  },
  emptyState: {
    padding: '16px 12px',
    textAlign: 'center',
    color: 'hsl(var(--color-fg-subtle))',
    fontSize: '12px',
  },
  positionsContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '6px',
  },
  positionsLabel: {
    fontSize: '10px',
    color: 'hsl(var(--color-fg-subtle))',
    flexShrink: 0,
    letterSpacing: '0.5px',
    paddingBottom: '10px',
  },
  positionsScroll: {
    display: 'flex',
    gap: '3px',
    overflowX: 'auto',
    overflowY: 'hidden',
    paddingBottom: '10px',
    paddingRight: '4px',
    scrollbarWidth: 'thin',
    scrollbarColor: '#d1d5db transparent',
  },
  positionChip: {
    flexShrink: 0,
    padding: '1px 4px',
    fontSize: '10px',
    fontFamily: 'monospace',
    color: 'hsl(var(--color-fg-muted))',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--color-border))',
    borderRadius: '3px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  },
  positionChipHover: {
    backgroundColor: 'hsl(var(--color-bg-muted))',
    borderColor: 'hsl(var(--color-border-hover))',
    color: 'hsl(var(--color-fg))',
  },
  hiddenPositionsLabel: {
    flexShrink: 0,
    padding: '1px 4px',
    fontSize: '10px',
    color: 'hsl(var(--color-fg-subtle))',
    whiteSpace: 'nowrap',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  virtualDigestDropdown: {
    display: 'flex',
    alignItems: 'center',
  },
  virtualDigestSelect: {
    fontSize: '10px',
    fontWeight: 500,
    color: '#6366f1',
    backgroundColor: '#eef2ff',
    border: '1px solid #c7d2fe',
    padding: '2px 4px',
    borderRadius: '4px',
    cursor: 'pointer',
    outline: 'none',
  },
};

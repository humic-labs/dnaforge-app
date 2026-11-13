import { toUserMessage } from '@waypoint/user-messages';
import React, { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react';
import type {
  VirtualDigestDiagnostic,
  VirtualDigestFragment,
  GGStatus,
  GGFragmentType,
} from '../hooks/useVirtualDigest';
import {
  bindDigestTransfer,
  createDigestDrag,
  digestReceiptFor,
  DIGEST_RESULT_MIME_TYPE,
  safelyObserveDigest,
} from '../digest-workflow';
import { useRichSequenceClipboardStore } from '../../sequence-clipboard/public/store';
import { writeRichSequenceClipboard } from '../../sequence-clipboard/public/clipboard-service';
import { getFragmentHex, type AssemblyColorSchemeId } from '../../design/public/colors';
import { useAssemblyColorScheme } from '../../design/public/color-scheme-store';
import { canonicalGoldenGateEnzymeName } from '@waypoint/sequence-utils';
import type { Annotation } from '@waypoint/sequence-utils';
import type {
  DesignAnnotation,
  GoldenGateEnzyme,
  RestrictionDigestEnds,
} from '../../design/public/types';
import {
  extractFragmentAnnotations as remapFragmentAnnotations,
  sourceAnnotationsToDesignAnnotations,
} from '../utils/fragmentToRegion';

export interface RDFragmentDragData {
  type: 'rd-fragment';

  sequence: string;

  sourceSequence?: string;

  upstreamOverhang: string;

  downstreamOverhang: string;

  ggType: GGFragmentType;

  sourceSequenceId: string;

  sourceSequenceName: string;

  sourceStart: number;

  sourceEnd: number;

  fragmentIndex: number;

  enzymeName: string;

  annotations?: DesignAnnotation[];

  sourceAnnotations?: DesignAnnotation[];

  sourceIsCircular?: boolean;

  rdSourceEnzyme?: GoldenGateEnzyme;

  rdSourceEnzymeName?: string;

  rdEnds?: RestrictionDigestEnds;

  siblingOverhangs?: string[];
}

export const RD_FRAGMENT_MIME_TYPE = 'application/x-waypoint-rd-fragment';

interface VirtualDigestPanelProps {
  enzymeName: string;

  sequenceName: string;

  fragments: VirtualDigestFragment[];

  ggStatus: GGStatus;

  digestKind?: 'goldengate' | 'restriction';

  warning?: string;

  diagnostics?: VirtualDigestDiagnostic[];

  overhangLength: number;

  onClose: () => void;

  usedFragmentIndex?: number | null;

  onFragmentHover?: (fragment: VirtualDigestFragment | null) => void;

  onFragmentClick?: (fragment: VirtualDigestFragment) => void;

  hoveredFragmentIndex?: number | null;

  isCollapsed?: boolean;

  onCollapsedChange?: (collapsed: boolean) => void;

  sourceSequence?: string;

  sourceSequenceId?: string;

  sourceAnnotations?: Annotation[];

  sourceIsCircular?: boolean;
}

function GGStatusBadge({ status }: { status: GGStatus }) {
  const config = {
    ready: {
      label: 'GG Ready',
      color: '#059669',
      bg: '#d1fae5',
    },
    'ready-with-warning': {
      label: 'GG Ready',
      color: '#d97706',
      bg: '#fef3c7',
    },
    'not-ready': {
      label: 'Not GG Ready',
      color: '#dc2626',
      bg: '#fee2e2',
    },
  }[status];

  return (
    <span
      style={{
        fontSize: '10px',
        fontWeight: 600,
        color: config.color,
        backgroundColor: config.bg,
        padding: '2px 6px',
        borderRadius: '4px',
      }}
    >
      {config.label}
    </span>
  );
}

function FragmentClassificationBadge({ type }: { type: GGFragmentType }) {
  if (type !== 'insert') return null;

  return (
    <span
      style={{
        fontSize: '9px',
        fontWeight: 600,
        color: '#047857',
        backgroundColor: '#d1fae5',
        padding: '1px 4px',
        borderRadius: '3px',
      }}
      title="Golden Gate ready: this single Type IIS digest fragment is excised with inward-facing compatible 5' overhangs."
    >
      Golden Gate ready
    </span>
  );
}

interface CollisionWarning {
  diagnosticId: string;
  overhang: string;
  message: string;

  affectedEnd: 'upstream' | 'downstream' | 'both';
}

function collisionWarningsForFragment(
  fragmentIndex: number,
  diagnostics: VirtualDigestDiagnostic[]
): CollisionWarning[] | undefined {
  const warnings: CollisionWarning[] = [];

  for (const diagnostic of diagnostics) {
    if (diagnostic.kind !== 'goldengate-duplicate-overhang') continue;
    const affectedEnds =
      diagnostic.affectedEnds?.filter((affected) => affected.fragmentIndex === fragmentIndex) ?? [];
    if (affectedEnds.length === 0) continue;

    const hasUpstream = affectedEnds.some((affected) => affected.end === 'upstream');
    const hasDownstream = affectedEnds.some((affected) => affected.end === 'downstream');
    warnings.push({
      diagnosticId: diagnostic.id,
      overhang: diagnostic.overhang ?? '',
      message: toUserMessage(diagnostic.message, 'assembly.failed'),
      affectedEnd: hasUpstream && hasDownstream ? 'both' : hasUpstream ? 'upstream' : 'downstream',
    });
  }

  return warnings.length > 0 ? warnings : undefined;
}

export function getFragmentColor(
  fragment: VirtualDigestFragment,
  schemeId?: AssemblyColorSchemeId
): string {
  return getFragmentHex(fragment.index, schemeId);
}

function CollisionWarningIcon({ warning }: { warning: CollisionWarning }) {
  return (
    <span
      data-testid="collision-warning"
      style={styles.collisionWarningIcon}
      title={toUserMessage(warning.message, 'assembly.failed')}
    >
      ⚠️
    </span>
  );
}

function FragmentRow({
  fragment,
  overhangLength: _overhangLength,
  onHover,
  onClick,
  isHovered,
  isUsed,
  onDragStart,
  isDraggable,
  onCopy,
  isCopied,
  collisionWarnings,
  fragmentIndex,
}: {
  fragment: VirtualDigestFragment;
  overhangLength: number;
  onHover?: (hovered: boolean) => void;
  onClick?: () => void;
  isHovered: boolean;
  isUsed?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  isDraggable?: boolean;
  onCopy?: () => void;
  isCopied?: boolean;
  collisionWarnings?: CollisionWarning[];
  fragmentIndex: number;
}) {
  const [isCopyHovered, setIsCopyHovered] = useState(false);
  const assemblyColorScheme = useAssemblyColorScheme();
  const fragmentColor = getFragmentColor(fragment, assemblyColorScheme);
  const canDrag = isDraggable && !isUsed;

  const upstreamWarning = collisionWarnings?.find(
    (w) => w.affectedEnd === 'upstream' || w.affectedEnd === 'both'
  );
  const downstreamWarning = collisionWarnings?.find(
    (w) => w.affectedEnd === 'downstream' || w.affectedEnd === 'both'
  );
  const hasCollision = collisionWarnings && collisionWarnings.length > 0;

  return (
    <div
      data-testid={`fragment-row-${fragmentIndex}`}
      draggable={canDrag}
      style={{
        ...styles.fragmentRow,
        backgroundColor: isHovered
          ? '#f0f9ff'
          : isUsed
            ? '#f9fafb'
            : hasCollision
              ? '#fef3c7'
              : 'transparent',
        borderLeftColor: fragmentColor,
        borderLeftWidth: 3,
        borderLeftStyle: 'solid',
        opacity: isUsed ? 0.6 : 1,
        cursor: canDrag ? 'grab' : 'pointer',
      }}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onClick={onClick}
      onDragStart={canDrag ? onDragStart : undefined}
      title={
        canDrag
          ? 'Drag to add to assembly, or click to highlight'
          : 'Click to highlight in sequence viewer'
      }
    >
      <div style={styles.fragmentHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ ...styles.fragmentName, color: fragmentColor }}>
            Fragment {fragment.index + 1}
          </span>
          <FragmentClassificationBadge type={fragment.ggType} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={styles.fragmentLength}>{fragment.length.toLocaleString()} bp</span>
          {onCopy && (
            <div
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCopy();
                }}
                onMouseEnter={() => !isCopied && setIsCopyHovered(true)}
                onMouseLeave={() => !isCopied && setIsCopyHovered(false)}
                style={{
                  ...styles.copyButton,
                  ...(isCopied
                    ? styles.copyButtonSuccess
                    : isCopyHovered
                      ? styles.copyButtonHover
                      : {}),
                }}
                title="Copy fragment sequence to clipboard"
              >
                {isCopied ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
              {isCopied && <span style={styles.copiedText}>Copied</span>}
            </div>
          )}
          {isUsed && <span style={styles.usedBadge}>In Use</span>}
        </div>
      </div>

      <div style={styles.overhangRow}>
        <span style={styles.positionLabel}>{fragment.startPosition.toLocaleString()}</span>
        <span
          data-testid="upstream-overhang"
          style={{
            ...styles.overhangSequence,
            ...(upstreamWarning ? styles.overhangCollision : {}),
          }}
        >
          {fragment.upstream.sequence}
        </span>
        {upstreamWarning && <CollisionWarningIcon warning={upstreamWarning} />}
        <span style={styles.overhangArrow}>→</span>
        <span
          data-testid="downstream-overhang"
          style={{
            ...styles.overhangSequence,
            ...(downstreamWarning ? styles.overhangCollision : {}),
          }}
        >
          {fragment.downstream.sequence}
        </span>
        {downstreamWarning && <CollisionWarningIcon warning={downstreamWarning} />}
        <span style={styles.positionLabel}>{fragment.endPosition.toLocaleString()}</span>
        {fragment.hasInternalSites && (
          <span
            style={styles.internalSiteWarning}
            title={`${fragment.internalSites.length} internal cut site${fragment.internalSites.length > 1 ? 's' : ''}`}
          >
            ⚠️
          </span>
        )}
      </div>
    </div>
  );
}

export function VirtualDigestPanel({
  enzymeName,
  sequenceName,
  fragments,
  ggStatus,
  digestKind = 'restriction',
  warning,
  diagnostics = [],
  overhangLength,
  onClose,
  usedFragmentIndex,
  onFragmentHover,
  onFragmentClick,
  hoveredFragmentIndex,
  isCollapsed = false,
  onCollapsedChange,
  sourceSequence,
  sourceSequenceId,
  sourceAnnotations,
  sourceIsCircular = true,
}: VirtualDigestPanelProps) {
  const materialRevision = React.useMemo(
    () => ({}),
    [
      fragments,
      sourceSequence,
      sourceSequenceId,
      sourceAnnotations,
      sourceIsCircular,
      enzymeName,
      sequenceName,
    ]
  );
  const currentMaterialRevision = useRef<object | null>(materialRevision);
  useLayoutEffect(() => {
    currentMaterialRevision.current = materialRevision;
    return () => {
      currentMaterialRevision.current = null;
    };
  }, [materialRevision]);

  const [copiedFragmentIndex, setCopiedFragmentIndex] = useState<number | null>(null);

  const dragImageRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    dragImageRef.current = img;
  }, []);

  const handleHeaderClick = () => {
    onCollapsedChange?.(!isCollapsed);
  };

  const sourceEndForFragment = useCallback((fragment: VirtualDigestFragment): number => {
    return fragment.wrapsOrigin ? fragment.startPosition + fragment.length : fragment.endPosition;
  }, []);

  const enzymeLabelForFragment = useCallback(
    (fragment: VirtualDigestFragment): string => {
      const names = Array.from(
        new Set(
          [
            fragment.upstream.enzymeName,
            fragment.downstream.enzymeName,
            ...fragment.upstream.enzymeNames,
            ...fragment.downstream.enzymeNames,
          ].filter(Boolean)
        )
      );
      return names.length > 0 ? names.join(' + ') : enzymeName;
    },
    [enzymeName]
  );

  const extractFragmentSequence = useCallback(
    (fragment: VirtualDigestFragment): string => {
      if (!sourceSequence) return '';

      const _seqLen = sourceSequence.length;
      if (fragment.wrapsOrigin) {
        return (
          sourceSequence.slice(fragment.startPosition) +
          sourceSequence.slice(0, fragment.endPosition)
        );
      } else {
        return sourceSequence.slice(fragment.startPosition, fragment.endPosition);
      }
    },
    [sourceSequence]
  );

  const extractFragmentAnnotations = useCallback(
    (fragment: VirtualDigestFragment): DesignAnnotation[] => {
      if (!sourceAnnotations || sourceAnnotations.length === 0 || !sourceSequence) return [];
      return remapFragmentAnnotations(
        fragment,
        sourceSequence.length,
        sourceAnnotationsToDesignAnnotations(sourceAnnotations)
      );
    },
    [sourceAnnotations, sourceSequence]
  );

  const computeSiblingOverhangs = useCallback(
    (fragment: VirtualDigestFragment): string[] | undefined => {
      if (fragments.length <= 1) return undefined;

      const siblingOverhangs = new Set<string>();
      for (const other of fragments) {
        if (other.index === fragment.index) continue;
        siblingOverhangs.add(other.upstream.sequence.toUpperCase());
        siblingOverhangs.add(other.downstream.sequence.toUpperCase());
      }

      return siblingOverhangs.size > 0 ? Array.from(siblingOverhangs) : undefined;
    },
    [fragments]
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, fragment: VirtualDigestFragment) => {
      if (currentMaterialRevision.current !== materialRevision || !fragments.includes(fragment))
        return;
      if (!sourceSequence || !sourceSequenceId) return;

      const fragmentSequence = extractFragmentSequence(fragment);
      const fragmentAnnotations = extractFragmentAnnotations(fragment);
      const fullSourceAnnotations = sourceAnnotationsToDesignAnnotations(sourceAnnotations ?? []);
      const siblingOverhangs = computeSiblingOverhangs(fragment);
      const fragmentEnzymeLabel = enzymeLabelForFragment(fragment);
      const rdSourceEnzyme = canonicalGoldenGateEnzymeName(fragmentEnzymeLabel);
      const rdEnds = {
        upstream: fragment.upstream.rdEnd,
        downstream: fragment.downstream.rdEnd,
      };

      const dragData: RDFragmentDragData = {
        type: 'rd-fragment',
        sequence: fragmentSequence,
        sourceSequence,
        upstreamOverhang: fragment.upstream.sequence,
        downstreamOverhang: fragment.downstream.sequence,
        ggType: fragment.ggType,
        sourceSequenceId: sourceSequenceId,
        sourceSequenceName: sequenceName,
        sourceStart: fragment.startPosition,
        sourceEnd: sourceEndForFragment(fragment),
        fragmentIndex: fragment.index,
        enzymeName: fragmentEnzymeLabel,
        annotations: fragmentAnnotations,
        sourceAnnotations: fullSourceAnnotations,
        sourceIsCircular,
        rdSourceEnzyme,
        rdSourceEnzymeName: fragmentEnzymeLabel,
        rdEnds,
        siblingOverhangs,
      };

      e.dataTransfer.setData(RD_FRAGMENT_MIME_TYPE, JSON.stringify(dragData));
      e.dataTransfer.setData('text/plain', JSON.stringify(dragData));
      e.dataTransfer.effectAllowed = 'copyMove';
      safelyObserveDigest(() => {
        const key = createDigestDrag(dragData, digestReceiptFor(fragments), fragment);
        if (key) e.dataTransfer.setData(DIGEST_RESULT_MIME_TYPE, key);
      });

      if (dragImageRef.current) {
        e.dataTransfer.setDragImage(dragImageRef.current, 0, 0);
      }

      const committed = useRichSequenceClipboardStore.getState().setCopiedRegion({
        sequence: fragmentSequence,
        sourceSequence,
        sourceId: sourceSequenceId,
        sourceName: `${sequenceName} (${fragmentEnzymeLabel} fragment ${fragment.index + 1})`,
        start: fragment.startPosition,
        end: sourceEndForFragment(fragment),
        annotations: fragmentAnnotations,
        sourceAnnotations: fullSourceAnnotations,
        sourceIsCircular,
        sourceType: 'rd',
        ggType: fragment.ggType,
        rdOverhangs: {
          upstream: fragment.upstream.sequence,
          downstream: fragment.downstream.sequence,
        },
        rdSourceEnzyme,
        rdSourceEnzymeName: fragmentEnzymeLabel,
        rdEnds,
        rdSiblingOverhangs: siblingOverhangs,
      });
      bindDigestTransfer(committed, digestReceiptFor(fragments), fragment);
    },
    [
      fragments,
      materialRevision,
      sourceSequence,
      sourceSequenceId,
      sourceAnnotations,
      sourceIsCircular,
      sequenceName,
      enzymeName,
      extractFragmentSequence,
      extractFragmentAnnotations,
      computeSiblingOverhangs,
      enzymeLabelForFragment,
      sourceEndForFragment,
    ]
  );

  const handleCopyFragment = useCallback(
    async (fragment: VirtualDigestFragment) => {
      if (currentMaterialRevision.current !== materialRevision || !fragments.includes(fragment))
        return;
      const receipt = digestReceiptFor(fragments);
      const copy = safelyObserveDigest(() => receipt?.beginUse(fragment, 'copy'));
      if (!sourceSequence || !sourceSequenceId) {
        safelyObserveDigest(() =>
          copy?.fail('validation', { status: 'blocked', outcomeKind: 'digest_use_refused' })
        );
        return;
      }

      const fragmentSequence = extractFragmentSequence(fragment);
      const fragmentAnnotations = extractFragmentAnnotations(fragment);
      const fullSourceAnnotations = sourceAnnotationsToDesignAnnotations(sourceAnnotations ?? []);
      const siblingOverhangs = computeSiblingOverhangs(fragment);
      const fragmentEnzymeLabel = enzymeLabelForFragment(fragment);
      try {
        await writeRichSequenceClipboard(
          {
            sequence: fragmentSequence,
            sourceSequence,
            sourceId: sourceSequenceId,
            sourceName: `${sequenceName} (${fragmentEnzymeLabel} fragment ${fragment.index + 1})`,
            start: fragment.startPosition,
            end: sourceEndForFragment(fragment),
            annotations: fragmentAnnotations,
            sourceAnnotations: fullSourceAnnotations,
            sourceIsCircular,
            sourceType: 'rd',
            ggType: fragment.ggType,
            rdOverhangs: {
              upstream: fragment.upstream.sequence,
              downstream: fragment.downstream.sequence,
            },
            rdSourceEnzyme: canonicalGoldenGateEnzymeName(fragmentEnzymeLabel),
            rdSourceEnzymeName: fragmentEnzymeLabel,
            rdEnds: {
              upstream: fragment.upstream.rdEnd,
              downstream: fragment.downstream.rdEnd,
            },
            rdSiblingOverhangs: siblingOverhangs,
          },
          (committed) => {
            if (currentMaterialRevision.current !== materialRevision) return;
            safelyObserveDigest(() =>
              copy?.complete({ outcomeKind: 'digest_use_accepted', affectedCount: 1 })
            );
            bindDigestTransfer(committed, receipt, fragment);
          }
        );
        if (currentMaterialRevision.current !== materialRevision) return;

        setCopiedFragmentIndex(fragment.index);

        setTimeout(() => setCopiedFragmentIndex(null), 2000);
      } catch (err) {
        if (currentMaterialRevision.current === materialRevision) {
          safelyObserveDigest(() => copy?.fail('unknown', { outcomeKind: 'digest_use_refused' }));
        }
        console.error('Failed to copy fragment sequence:', err);
      }
    },
    [
      fragments,
      materialRevision,
      sourceSequence,
      sourceSequenceId,
      sourceAnnotations,
      sourceIsCircular,
      sequenceName,
      enzymeName,
      extractFragmentSequence,
      extractFragmentAnnotations,
      computeSiblingOverhangs,
      enzymeLabelForFragment,
      sourceEndForFragment,
    ]
  );

  const isDraggable = Boolean(sourceSequence && sourceSequenceId);

  const canCopy = Boolean(sourceSequence);

  const showGoldenGateWarnings = digestKind === 'goldengate';
  const goldenGateDuplicateDiagnostics = React.useMemo(
    () =>
      showGoldenGateWarnings
        ? diagnostics.filter((diagnostic) => diagnostic.kind === 'goldengate-duplicate-overhang')
        : [],
    [diagnostics, showGoldenGateWarnings]
  );
  const hasCollisions = goldenGateDuplicateDiagnostics.length > 0;

  return (
    <div
      data-testid="virtual-digest-panel"
      style={styles.container}
      onMouseLeave={() => onFragmentHover?.(null)}
    >
      <div style={styles.header}>
        <button
          onClick={handleHeaderClick}
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
          <div style={styles.headerLeft}>
            <span style={styles.title}>Virtual Digest</span>
            <span style={styles.subtitle}>
              {enzymeName} • {fragments.length} fragment{fragments.length !== 1 ? 's' : ''}
            </span>
          </div>
        </button>
        <div style={styles.headerRight}>
          {digestKind === 'goldengate' && <GGStatusBadge status={ggStatus} />}
          <button onClick={onClose} style={styles.closeButton} title="Close Virtual Digest">
            ×
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <>
          {warning && (
            <div style={styles.warningBanner}>
              <span style={styles.warningIcon}>⚠️</span>
              <span>{warning}</span>
            </div>
          )}

          {hasCollisions && (
            <div data-testid="collision-warning-banner" style={styles.collisionBanner}>
              <span style={styles.warningIcon}>⚠️</span>
              <span data-testid="collision-warning-tooltip">
                Duplicate overhangs detected:{' '}
                {goldenGateDuplicateDiagnostics
                  .map((diagnostic) => diagnostic.overhang)
                  .filter(Boolean)
                  .join(', ')}{' '}
                - may cause mis-ligation
              </span>
            </div>
          )}

          <div style={styles.fragmentList}>
            {fragments.length === 0 ? (
              <div style={styles.emptyState}>
                No fragments available. Select active enzymes that cut this sequence.
              </div>
            ) : (
              fragments.map((fragment) => (
                <FragmentRow
                  key={fragment.index}
                  fragment={fragment}
                  overhangLength={overhangLength}
                  onHover={(hovered) => onFragmentHover?.(hovered ? fragment : null)}
                  onClick={() => onFragmentClick?.(fragment)}
                  isHovered={hoveredFragmentIndex === fragment.index}
                  isUsed={usedFragmentIndex === fragment.index}
                  onDragStart={(e) => handleDragStart(e, fragment)}
                  isDraggable={isDraggable}
                  onCopy={canCopy ? () => handleCopyFragment(fragment) : undefined}
                  isCopied={copiedFragmentIndex === fragment.index}
                  collisionWarnings={
                    showGoldenGateWarnings
                      ? collisionWarningsForFragment(fragment.index, diagnostics)
                      : undefined
                  }
                  fragmentIndex={fragment.index}
                />
              ))
            )}
          </div>

          <div style={styles.footer}>
            <span style={styles.footerText}>
              {overhangLength > 0
                ? `${overhangLength} bp maximum overhang`
                : 'Physical restriction digest ends'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export type { CollisionWarning };

const styles: Record<string, React.CSSProperties> = {
  container: {
    backgroundColor: '#ffffff',
    borderTop: '1px solid #e5e7eb',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '300px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid #e5e7eb',
    backgroundColor: '#f9fafb',
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
    color: '#6b7280',
    transition: 'transform 0.15s ease',
  },
  headerLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    textAlign: 'left',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  title: {
    fontWeight: 600,
    fontSize: '12px',
    color: '#374151',
  },
  subtitle: {
    fontSize: '10px',
    color: '#9ca3af',
  },
  closeButton: {
    background: 'none',
    border: 'none',
    color: '#6b7280',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: '1',
  },
  warningBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 16px',
    backgroundColor: '#fef3c7',
    borderBottom: '1px solid #fcd34d',
    fontSize: '12px',
    color: '#92400e',
  },
  warningIcon: {
    fontSize: '12px',
  },
  fragmentList: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 0',
  },
  fragmentRow: {
    padding: '6px 12px',
    borderBottom: '1px solid #f3f4f6',
    transition: 'background-color 0.15s ease',
    cursor: 'pointer',
  },
  fragmentHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '2px',
  },
  fragmentName: {
    fontWeight: 500,
    fontSize: '13px',
    color: '#111827',
  },
  fragmentLength: {
    fontSize: '11px',
    color: '#6b7280',
    fontFamily: 'monospace',
  },
  overhangRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '4px',
  },
  overhangSequence: {
    fontFamily: 'monospace',
    fontSize: '12px',
    color: '#059669',
    fontWeight: 600,
    backgroundColor: '#d1fae5',
    padding: '1px 4px',
    borderRadius: '2px',
  },
  overhangArrow: {
    fontSize: '11px',
    color: '#9ca3af',
  },
  overhangLabel: {
    fontSize: '10px',
    color: '#9ca3af',
    marginLeft: '4px',
  },
  positionLabel: {
    fontSize: '10px',
    color: '#9ca3af',
    fontFamily: 'monospace',
    minWidth: '40px',
  },
  internalSiteWarning: {
    fontSize: '11px',
    marginLeft: '4px',
    cursor: 'help',
  },
  emptyState: {
    padding: '24px 16px',
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: '12px',
  },
  footer: {
    padding: '8px 16px',
    borderTop: '1px solid #e5e7eb',
    backgroundColor: '#f9fafb',
  },
  footerText: {
    fontSize: '11px',
    color: '#6b7280',
  },
  useButton: {
    padding: '2px 6px',
    fontSize: '10px',
    fontWeight: 500,
    color: '#059669',
    backgroundColor: '#d1fae5',
    border: '1px solid #10b981',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  copyButton: {
    padding: '3px',
    color: '#6b7280',
    backgroundColor: 'transparent',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyButtonHover: {
    color: '#374151',
    backgroundColor: '#f3f4f6',
    borderColor: '#9ca3af',
    transform: 'scale(1.05)',
  },
  copyButtonSuccess: {
    color: '#059669',
    backgroundColor: '#d1fae5',
    borderColor: '#10b981',
  },
  copiedText: {
    position: 'absolute' as const,
    top: '100%',
    marginTop: '2px',
    fontSize: '9px',
    fontWeight: 500,
    color: '#059669',
    whiteSpace: 'nowrap' as const,
  },
  usedBadge: {
    padding: '2px 6px',
    fontSize: '10px',
    fontWeight: 500,
    color: '#6b7280',
    backgroundColor: '#f3f4f6',
    borderRadius: '4px',
  },
  collisionBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 16px',
    backgroundColor: '#fef3c7',
    borderBottom: '1px solid #fcd34d',
    fontSize: '12px',
    color: '#92400e',
  },
  collisionWarningIcon: {
    fontSize: '11px',
    marginLeft: '2px',
    cursor: 'help',
  },
  overhangCollision: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
    border: '1px solid #f59e0b',
  },
};

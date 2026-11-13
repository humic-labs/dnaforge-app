'use client';

import { memo, useMemo, useCallback, type CSSProperties } from 'react';
import type {
  ResidueLocation,
  Structure3dColorMode,
  StructureSelectionGesture,
  StructureColoration,
  StructureAtomicDetail,
} from '../types';
import { HIGHLIGHT_COLORS } from '../types';
import { isModifiedResidue } from '../hooks/useSequenceData';
import {
  colorsForColoration,
  molecularColorCss,
  residueColorationStyle,
} from '../utils/structureColoration';
import type { ResidueIdentityRelation } from '../utils/polymerResidueDisplay';
import { residueLabelWidthCss } from '../utils/residueLabelLayout';

export type ResidueBoxEntryKind = 'polymer' | 'ligand';

interface ResidueBoxProps {
  residue: {
    position: number;
    labelSeqId?: number;
    name: string;
    displayLabel?: string;
    name3: string;
    parentCompId?: string;
    value?: number;
    coloration?: StructureColoration;
    atomicDetail?: StructureAtomicDetail;
    alphaCarbonColoration?: StructureColoration;
  };
  entryKind?: ResidueBoxEntryKind;
  displayOneLetterCode?: string;
  displayPosition?: number;
  polymerIndex?: number;
  identityRelation?: ResidueIdentityRelation;
  chainId: string;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
  colorMode: Structure3dColorMode;
  chainColor?: string;
  detailVisible?: boolean;
  isHovered: boolean;
  isSelected: boolean;
  isSelectionHighlighted?: boolean;
  hasSelectionBefore?: boolean;
  hasSelectionAfter?: boolean;
  showPositionLabel?: boolean;
  onHover: (residue: ResidueLocation | null) => void;
  onSelect: (residue: ResidueLocation, gesture: StructureSelectionGesture) => void;
}

function hexToRgba(hex: number, alpha: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function contrastingTextColor(color: number): string {
  const channel = (shift: number) => {
    const value = ((color >> shift) & 0xff) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

function hexToRgbCss(hex: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

function cssHexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return hex;
  const value = Number.parseInt(normalized, 16);
  return hexToRgba(value, alpha);
}

interface ResidueFrameStyleOptions {
  backgroundColor?: string;
  inlineInsetPx?: number;
  blockInsetPx?: number;
  zIndex?: number;
}

function cssPx(value: number): string {
  return value === 0 ? '0' : `${value}px`;
}

function groupedResidueFrameStyle(
  color: string,
  hasBefore: boolean,
  hasAfter: boolean,
  {
    backgroundColor = 'transparent',
    inlineInsetPx = 0,
    blockInsetPx = 0,
    zIndex = 0,
  }: ResidueFrameStyleOptions = {}
): CSSProperties {
  const edgeInsetPx = Math.max(1, inlineInsetPx);

  return {
    position: 'absolute',
    top: cssPx(-blockInsetPx),
    bottom: cssPx(-blockInsetPx),
    left: hasBefore ? cssPx(-edgeInsetPx) : cssPx(-inlineInsetPx),
    right: hasAfter ? cssPx(-edgeInsetPx) : cssPx(-inlineInsetPx),
    zIndex,
    pointerEvents: 'none',
    backgroundColor,
    borderTop: `1px solid ${color}`,
    borderBottom: `1px solid ${color}`,
    borderLeft: hasBefore ? 'none' : `1px solid ${color}`,
    borderRight: hasAfter ? 'none' : `1px solid ${color}`,
    borderTopLeftRadius: hasBefore ? '0' : '2px',
    borderBottomLeftRadius: hasBefore ? '0' : '2px',
    borderTopRightRadius: hasAfter ? '0' : '2px',
    borderBottomRightRadius: hasAfter ? '0' : '2px',
  };
}

export const ResidueBox = memo(function ResidueBox({
  residue,
  entryKind = 'polymer',
  displayOneLetterCode,
  displayPosition,
  polymerIndex,
  identityRelation,
  chainId,
  baseChain,
  labelAsymId,
  authAsymId,
  entityId,
  operator,
  colorMode,
  chainColor,
  detailVisible = true,
  isHovered,
  isSelected,
  isSelectionHighlighted = false,
  hasSelectionBefore = false,
  hasSelectionAfter = false,
  showPositionLabel = false,
  onHover,
  onSelect,
}: ResidueBoxProps) {
  const isLigand = entryKind === 'ligand';
  const hasSelectionFrame = isSelected || isSelectionHighlighted;

  const location: ResidueLocation = useMemo(
    () => ({
      chain: chainId,
      position: residue.position,
      labelCompId: residue.name3,
      ...(isLigand ? { compId: residue.name3 } : {}),
      baseChain,
      labelAsymId,
      authAsymId,
      entityId,
      labelSeqId: residue.labelSeqId,
      operator,
    }),
    [
      chainId,
      residue.position,
      residue.name3,
      isLigand,
      residue.labelSeqId,
      baseChain,
      labelAsymId,
      authAsymId,
      entityId,
      operator,
    ]
  );

  const handleMouseEnter = useCallback(() => {
    onHover(location);
  }, [onHover, location]);

  const handleMouseLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const gesture: StructureSelectionGesture = e.shiftKey
        ? 'range'
        : e.metaKey || e.ctrlKey
          ? 'toggle'
          : 'replace';
      onSelect(location, gesture);
    },
    [onSelect, location]
  );

  const backgroundColor = useMemo(() => {
    if (hasSelectionFrame) return 'transparent';
    if (isLigand) {
      if (!detailVisible) return 'rgba(148, 163, 184, 0.22)';
      if (chainColor && (colorMode === 'chain' || colorMode === 'element')) {
        return cssHexToRgba(chainColor, 0.18);
      }
    }
    return residue.atomicDetail && residue.alphaCarbonColoration?.kind === 'uniform'
      ? hexToRgba(residue.alphaCarbonColoration.color, 0.13)
      : 'transparent';
  }, [
    hasSelectionFrame,
    isLigand,
    detailVisible,
    chainColor,
    colorMode,
    residue.atomicDetail,
    residue.alphaCarbonColoration,
  ]);

  const selectionFrameStyle = useMemo(() => {
    if (!hasSelectionFrame) return {};
    return groupedResidueFrameStyle(
      hexToRgbCss(HIGHLIGHT_COLORS.selected.outline),
      hasSelectionBefore,
      hasSelectionAfter,
      { backgroundColor: HIGHLIGHT_COLORS.selected.bg }
    );
  }, [hasSelectionFrame, hasSelectionBefore, hasSelectionAfter]);

  const uniformColor =
    !isLigand && residue.coloration?.kind === 'uniform' ? residue.coloration.color : undefined;
  const hasTile = uniformColor !== undefined;

  const hoverFrameStyle = useMemo(() => {
    return {
      ...groupedResidueFrameStyle(hexToRgbCss(HIGHLIGHT_COLORS.hover.outline), false, false, {
        zIndex: 3,
        ...(hasTile ? { blockInsetPx: 1, inlineInsetPx: 1 } : {}),
      }),
      ...(isHovered ? { opacity: 1 } : {}),
    };
  }, [isHovered, hasTile]);

  const widthClass = isLigand ? 'px-1' : '';
  const roundedClass = isLigand ? 'rounded-sm' : 'rounded-none';
  const nativeColorStyle = residue.coloration
    ? residueColorationStyle(residue.coloration)
    : undefined;
  const labelStyle: CSSProperties | undefined =
    uniformColor === undefined ? nativeColorStyle : { color: contrastingTextColor(uniformColor) };
  const tileStyle: CSSProperties | undefined =
    uniformColor === undefined
      ? undefined
      : {
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          borderRadius: 0,
          backgroundColor: molecularColorCss(uniformColor),
          ...(residue.atomicDetail ? { boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.45)' } : {}),
          pointerEvents: 'none',
        };
  const fallbackTextColor =
    !hasSelectionFrame &&
    detailVisible &&
    chainColor &&
    (colorMode === 'chain' || colorMode === 'element')
      ? chainColor
      : undefined;
  const residueTextColor = nativeColorStyle?.color ?? fallbackTextColor;

  const isModified = isModifiedResidue(residue.name3, residue.parentCompId);
  const renderedOneLetterCode = displayOneLetterCode ?? residue.displayLabel ?? residue.name;
  const renderedPosition = displayPosition ?? residue.position;
  const identityTitle =
    identityRelation && identityRelation !== 'exact'
      ? `Polymer residue ${renderedPosition}: ${renderedOneLetterCode}; structure coordinates: ${residue.name3} (${identityRelation})`
      : undefined;
  const colorationTitle =
    residue.coloration?.kind === 'unavailable'
      ? 'This coloring cannot be mapped to an individual residue.'
      : residue.coloration?.kind === 'unrepresented'
        ? 'Loaded in this structure, but not drawn in 3D.'
        : residue.coloration?.kind === 'multiple'
          ? `Structure colors: ${residue.coloration.colors.map(molecularColorCss).join(', ')}`
          : undefined;
  const alphaCarbonTitle = !residue.atomicDetail
    ? undefined
    : residue.alphaCarbonColoration?.kind === 'uniform'
      ? `Atomic-detail background: alpha carbon ${molecularColorCss(residue.alphaCarbonColoration.color)}.`
      : residue.alphaCarbonColoration?.kind === 'multiple'
        ? 'Visible alpha-carbon representations have different colors; no single background color is available.'
        : residue.alphaCarbonColoration?.kind === 'unavailable'
          ? 'The visible alpha-carbon color cannot be mapped to this residue.'
          : residue.alphaCarbonColoration?.kind === 'unrepresented'
            ? 'No alpha carbon is drawn in the atomic-detail overlay.'
            : 'The alpha-carbon color has not been resolved for this residue.';

  return (
    <div
      className={`
        group ${widthClass} h-5 scroll-mt-8 flex items-center justify-center relative overflow-visible pointer-events-auto
        text-[10px] font-mono cursor-pointer select-none
        ${roundedClass} transition-colors
        ${detailVisible ? 'text-fg' : 'text-fg-muted'}
      `}
      style={{
        backgroundColor,
        color: residueTextColor,
        ...(isLigand ? {} : { width: residueLabelWidthCss(renderedOneLetterCode) }),
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      data-testid={`residue-${chainId}-${residue.position}`}
      data-coordinate-status="modeled"
      data-polymer-index={polymerIndex}
      data-chain-id={chainId}
      data-position={residue.position}
      data-label-seq-id={residue.labelSeqId}
      data-comp-id={isLigand ? residue.name3 : undefined}
      data-base-chain={baseChain}
      data-label-asym-id={labelAsymId}
      data-auth-asym-id={authAsymId}
      data-entity-id={entityId}
      data-operator={operator}
      data-residue-name={residue.name}
      data-residue-name3={residue.name3}
      data-source-residue-name={displayOneLetterCode}
      data-coordinate-residue-name={residue.name}
      data-identity-relation={identityRelation}
      data-detail-state={detailVisible ? 'detail' : 'context'}
      data-coloration-kind={residue.coloration?.kind}
      data-atomic-detail={residue.atomicDetail}
      data-alpha-carbon-coloration-kind={residue.alphaCarbonColoration?.kind}
      data-alpha-carbon-colors={
        residue.alphaCarbonColoration
          ? colorsForColoration(residue.alphaCarbonColoration).map(molecularColorCss).join(',')
          : undefined
      }
      data-molecular-colors={
        residue.coloration
          ? colorsForColoration(residue.coloration).map(molecularColorCss).join(',')
          : undefined
      }
      data-state={isSelected ? 'selected' : isHovered ? 'hovered' : undefined}
      title={
        [
          identityTitle,
          colorationTitle,
          alphaCarbonTitle,
          residue.atomicDetail === 'backbone'
            ? 'Backbone atoms drawn in atomic detail.'
            : residue.atomicDetail === 'atoms'
              ? 'Atoms drawn in atomic detail.'
              : undefined,
        ]
          .filter(Boolean)
          .join('\n') || undefined
      }
    >
      {tileStyle && <span aria-hidden="true" style={tileStyle} data-testid="residue-color-tile" />}
      {hasSelectionFrame ? (
        <span
          aria-hidden="true"
          style={selectionFrameStyle}
          data-testid={`residue-${chainId}-${residue.position}-interaction-frame`}
        />
      ) : null}
      <span
        aria-hidden="true"
        className="opacity-0 group-hover:opacity-100"
        style={hoverFrameStyle}
        data-testid={`residue-${chainId}-${residue.position}-hover-frame`}
      />
      {showPositionLabel && (
        <span
          className="absolute left-1/2 z-10 -translate-x-1/2 text-[7px] text-fg-subtle leading-none select-none whitespace-nowrap pointer-events-none"
          style={{ top: '-7px' }}
        >
          {renderedPosition}
        </span>
      )}
      <span className="relative z-10" data-testid="residue-label" style={labelStyle}>
        {renderedOneLetterCode}
      </span>
      {isModified && (
        <span className="absolute bottom-0 left-1/2 z-10 h-1 w-1 -translate-x-1/2 rounded-full bg-black dark:bg-white" />
      )}
    </div>
  );
});

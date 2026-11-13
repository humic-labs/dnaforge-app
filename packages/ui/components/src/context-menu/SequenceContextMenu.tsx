import React, { useEffect, useRef, useCallback, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatShortcut, JETBRAINS_MONO_FONT_NAME } from '../keyboard/shortcuts';
import { clampFixedMenuPosition } from './positioning';
import {
  sequenceContextMenuFlags,
  type SequenceContextMenuFlags,
} from './sequence-context-menu-flags';
import type { SequenceContextMenuProps } from './sequence-context-menu-props';

export type { SequenceContextMenuProps };

function getMenuStyles() {
  const menuItem: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'subgrid',
    gridColumn: '1 / -1',
    alignItems: 'center',
    width: '100%',
    padding: '3px 10px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: '13px',
    color: 'hsl(var(--color-fg))',
  };

  return {
    menuItem,
    menuItemLabel: {
      flexShrink: 0,
    } as React.CSSProperties,
    menuItemTarget: {
      minWidth: 0,
      maxWidth: 'none',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '12px',
      fontWeight: 500,
      color: 'hsl(var(--color-success))',
    } as React.CSSProperties,
    menuItemTargetMuted: {
      minWidth: 0,
      maxWidth: 'none',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '12px',
      fontWeight: 400,
      color: 'hsl(var(--color-fg-subtle))',
    } as React.CSSProperties,
    primary: {
      ...menuItem,
      color: 'hsl(var(--color-accent))',
      fontWeight: 500,
    } as React.CSSProperties,
    creation: {
      ...menuItem,
      color: 'hsl(var(--color-success))',
      fontWeight: 600,
    } as React.CSSProperties,
    destructive: {
      ...menuItem,
      color: 'hsl(var(--color-error))',
      fontWeight: 500,
    } as React.CSSProperties,
    agent: {
      ...menuItem,
      color: 'hsl(38, 92%, 48%)',
      fontWeight: 600,
    } as React.CSSProperties,
    hoverBg: 'hsl(var(--color-bg-muted))',
  };
}

function Divider() {
  return (
    <div
      data-testid="sequence-context-menu-divider"
      style={{
        height: '1px',
        gridColumn: '1 / -1',
        backgroundColor: 'hsl(var(--color-border))',
        margin: '4px 0',
      }}
    />
  );
}

type MenuItemTargetTone = 'feature' | 'muted';

function MenuItemContent({
  label,
  targetLabel,
  targetTone = 'feature',
  shortcut,
}: {
  label: string;
  targetLabel?: string;
  targetTone?: MenuItemTargetTone;
  shortcut?: string;
}) {
  const styles = getMenuStyles();
  return (
    <>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span style={styles.menuItemLabel}>{label}</span>
        {targetLabel && (
          <span
            data-testid="sequence-context-menu-target"
            style={targetTone === 'feature' ? styles.menuItemTarget : styles.menuItemTargetMuted}
            title={targetLabel}
          >
            {' '}
            ({targetLabel})
          </span>
        )}
      </span>
      <span
        data-testid={shortcut ? 'sequence-context-menu-shortcut' : undefined}
        data-shortcut-column="true"
        aria-hidden="true"
        style={{
          minWidth: '4ch',
          justifySelf: 'end',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          fontFamily: `'${JETBRAINS_MONO_FONT_NAME}', 'Roboto Mono', monospace`,
          fontSize: 11,
          opacity: 0.6,
        }}
      >
        {shortcut}
      </span>
    </>
  );
}

function MenuItem({
  label,
  targetLabel,
  targetTone,
  shortcut,
  onClick,
  style: customStyle,
  hoverBg,
  onHoverChange,
}: {
  label: string;
  targetLabel?: string;
  targetTone?: MenuItemTargetTone;
  shortcut?: string;
  onClick: () => void;
  style?: React.CSSProperties;
  hoverBg: string;
  onHoverChange?: (hovering: boolean) => void;
}) {
  const logLabel = targetLabel ? `${label} (${targetLabel})` : label;
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log(`[MenuItem] mousedown fired for "${logLabel}"`);
        onClick();
      }}
      style={customStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = hoverBg;
        onHoverChange?.(true);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
        onHoverChange?.(false);
      }}
    >
      <MenuItemContent
        label={label}
        targetLabel={targetLabel}
        targetTone={targetTone}
        shortcut={shortcut}
      />
    </button>
  );
}

type MenuSectionProps = {
  flags: SequenceContextMenuFlags;
  styles: ReturnType<typeof getMenuStyles>;
  onItem: (action: () => void) => void;
  props: SequenceContextMenuProps;
};

function CopyExtractMenuItems({ flags, styles, onItem, props }: MenuSectionProps) {
  return (
    <>
      {flags.hasSelection && props.onCopySequence && (
        <MenuItem
          label="Copy Sequence"
          shortcut={props.shortcutHints?.copySequence ?? formatShortcut(['cmd', 'c'])}
          onClick={() => onItem(props.onCopySequence!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasSelection && props.onCopyReverseComplement && (
        <MenuItem
          label="Copy Sequence (Reverse Complement)"
          shortcut={props.shortcutHints?.copyReverseComplement}
          onClick={() => onItem(props.onCopyReverseComplement!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasSelection && props.onCopyTranslation && (
        <MenuItem
          label="Copy Translation"
          shortcut={props.shortcutHints?.copyTranslation}
          onClick={() => onItem(props.onCopyTranslation!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedTranscript && props.onCopyTranscriptDna && (
        <MenuItem
          label="Copy transcript DNA"
          targetLabel={props.clickedTranscript.name}
          onClick={() => onItem(props.onCopyTranscriptDna!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedTranscript && props.onCopyTranscriptRna && (
        <MenuItem
          label="Copy transcript RNA"
          targetLabel={props.clickedTranscript.name}
          onClick={() => onItem(props.onCopyTranscriptRna!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedTranscript && props.onChooseTranscriptIsoform && (
        <MenuItem
          label="Choose isoform…"
          targetLabel={props.clickedTranscript.name}
          onClick={() => onItem(props.onChooseTranscriptIsoform!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedCDS && props.onCopyCDSTranslation && (
        <MenuItem
          label="Copy CDS Translation"
          targetLabel={props.clickedCDS.name}
          onClick={() => onItem(props.onCopyCDSTranslation!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
          onHoverChange={props.onPreviewCDS}
        />
      )}
      {props.clickedCDS &&
        props.onCreateAminoAcidSequence &&
        (props.createAminoAcidSequenceDisabled ? (
          <div
            data-testid="create-amino-acid-sequence-disabled"
            style={{
              ...styles.menuItem,
              color: 'hsl(var(--color-fg-subtle))',
              cursor: 'not-allowed',
            }}
            title="This CDS has no valid translation (internal stop codon or length not a multiple of 3)"
          >
            <MenuItemContent
              label="Create amino acid sequence"
              targetLabel="unavailable"
              targetTone="muted"
            />
          </div>
        ) : (
          <MenuItem
            label="Create amino acid sequence"
            targetLabel={props.clickedCDS.name}
            onClick={() => onItem(props.onCreateAminoAcidSequence!)}
            style={styles.creation}
            hoverBg={styles.hoverBg}
          />
        ))}
      {flags.hasCopyActions &&
        (flags.hasStructureAction ||
          flags.hasAskAiAction ||
          flags.hasCreationSection ||
          flags.hasTargetEditActions ||
          flags.hasSequenceViewActions ||
          flags.hasPasteAction ||
          flags.hasEditSequenceAction) && <Divider />}
    </>
  );
}

function StructureAskMenuItems({ flags, styles, onItem, props }: MenuSectionProps) {
  const structureFeature =
    props.structureAnnotation !== undefined ? props.structureAnnotation : props.clickedCDS;
  return (
    <>
      {structureFeature && flags.hasStructureAction && (
        <MenuItem
          label="View Structure"
          targetLabel={structureFeature.name}
          onClick={() => onItem(props.onViewStructure!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasStructureAction &&
        (flags.hasAskAiAction ||
          flags.hasCreationSection ||
          flags.hasTargetEditActions ||
          flags.hasSequenceViewActions ||
          flags.hasPasteAction ||
          flags.hasEditSequenceAction) && <Divider />}
      {flags.hasSelection && props.onAskAI && (
        <MenuItem
          label="Ask Agent"
          shortcut={props.askAiShortcut}
          onClick={() => onItem(props.onAskAI!)}
          style={styles.agent}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasAskAiAction &&
        (flags.hasCreationSection ||
          flags.hasTargetEditActions ||
          flags.hasSequenceViewActions ||
          flags.hasPasteAction ||
          flags.hasEditSequenceAction) && <Divider />}
    </>
  );
}

function AnnotationPrimerCreateMenuItems({ flags, styles, onItem, props }: MenuSectionProps) {
  return (
    <>
      {flags.hasAddAnnotationAction && props.selectionRange && props.onAddAnnotation && (
        <MenuItem
          label="Add Annotation"
          shortcut={props.shortcutHints?.addAnnotation}
          onClick={() => onItem(() => props.onAddAnnotation!(props.selectionRange!))}
          style={styles.creation}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasSaveOrfAction && props.clickedORF && props.onSaveORFAsAnnotation && (
        <MenuItem
          label="Add ORF as CDS"
          targetLabel={`${props.clickedORF.length} bp`}
          targetTone="muted"
          onClick={() => onItem(() => props.onSaveORFAsAnnotation!(props.clickedORF!))}
          style={styles.creation}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedAnnotation &&
        props.clickedAnnotationIsCdsExtensionPreview &&
        props.onCommitCdsExtension && (
          <MenuItem
            label="Extend existing CDS annotation"
            targetLabel={props.clickedAnnotation.name}
            onClick={() => onItem(props.onCommitCdsExtension!)}
            style={styles.creation}
            hoverBg={styles.hoverBg}
          />
        )}
      {props.clickedAnnotation &&
        !props.clickedAnnotationIsCdsExtensionPreview &&
        props.onEditAnnotation && (
          <MenuItem
            label="Edit Annotation"
            onClick={() => onItem(() => props.onEditAnnotation!(props.clickedAnnotation!))}
            style={styles.creation}
            hoverBg={styles.hoverBg}
          />
        )}
      {props.clickedAnnotation &&
        !props.clickedAnnotationIsCdsExtensionPreview &&
        props.onDeleteAnnotation && (
          <MenuItem
            label="Delete Annotation"
            onClick={() => onItem(() => props.onDeleteAnnotation!(props.clickedAnnotation!))}
            style={styles.destructive}
            hoverBg={styles.hoverBg}
          />
        )}
      {flags.hasAnnotationSection && flags.hasPrimerCreationGroup && <Divider />}
      {props.onAttachPrimers && (
        <MenuItem
          label="Attach Primers"
          onClick={() => onItem(props.onAttachPrimers!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasSelection && props.onCreateForwardPrimer && (
        <MenuItem
          label="Create Forward Primer →"
          onClick={() => onItem(props.onCreateForwardPrimer!)}
          style={styles.creation}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasSelection && props.onCreateReversePrimer && (
        <MenuItem
          label="Create Reverse Primer ←"
          onClick={() => onItem(props.onCreateReversePrimer!)}
          style={styles.creation}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasCreationSection &&
        (flags.hasTargetEditActions ||
          flags.hasSequenceViewActions ||
          flags.hasPasteAction ||
          flags.hasEditSequenceAction) && <Divider />}
    </>
  );
}

function TargetViewMenuItems({ flags, styles, onItem, props }: MenuSectionProps) {
  return (
    <>
      {props.onReverseComplementAssemblyPart && (
        <MenuItem
          label="Flip assembly part (reverse complement)"
          onClick={() => onItem(props.onReverseComplementAssemblyPart!)}
          style={styles.primary}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedPrimer && props.onCopyPrimerBases && (
        <MenuItem
          label="Copy bases"
          onClick={() => onItem(props.onCopyPrimerBases!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedPrimer && props.onEditPrimerBinding && (
        <MenuItem
          label="Edit binding site"
          targetLabel={props.clickedPrimer.name}
          targetTone="muted"
          onClick={() => onItem(props.onEditPrimerBinding!)}
          style={styles.primary}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedPrimer && props.onEditPrimer && (
        <MenuItem
          label="Open primer"
          targetLabel={props.clickedPrimer.name}
          targetTone="muted"
          onClick={() => onItem(props.onEditPrimer!)}
          style={styles.primary}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.clickedPrimer && props.onDetachPrimer && (
        <MenuItem
          label="Detach Primer"
          onClick={() => onItem(props.onDetachPrimer!)}
          style={styles.destructive}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasTargetEditActions &&
        (flags.hasSequenceViewActions || flags.hasPasteAction || flags.hasEditSequenceAction) && (
          <Divider />
        )}
      {flags.hasSelection && props.onInvertSelection && (
        <MenuItem
          label="Select inverse"
          shortcut={props.shortcutHints?.invertSelection}
          onClick={() => onItem(props.onInvertSelection!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.onReindexHere && (
        <MenuItem
          label="Re-index here"
          onClick={() => onItem(props.onReindexHere!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {props.onFlipOrientation && (
        <MenuItem
          label="Reverse complement viewing direction"
          onClick={() => onItem(props.onFlipOrientation!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasResetSequenceViewAction && props.onResetSequenceView && (
        <MenuItem
          label="Reset sequence view"
          onClick={() => onItem(props.onResetSequenceView!)}
          style={styles.menuItem}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasSequenceViewActions && (flags.hasPasteAction || flags.hasEditSequenceAction) && (
        <Divider />
      )}
      {props.onPaste && (
        <MenuItem
          label="Paste"
          shortcut={props.shortcutHints?.paste}
          targetLabel={props.pasteTargetLabel}
          onClick={() => onItem(props.onPaste!)}
          style={styles.primary}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.hasPasteAction && flags.hasEditSequenceAction && <Divider />}
      {props.isOnNucleotideRow && props.onEditSequence && (
        <MenuItem
          label="Edit Sequence"
          onClick={() => onItem(props.onEditSequence!)}
          style={styles.creation}
          hoverBg={styles.hoverBg}
        />
      )}
      {flags.showEmptyHint && (
        <div
          style={{
            gridColumn: '1 / -1',
            padding: '3px 10px',
            color: 'hsl(var(--color-fg-subtle))',
            fontSize: '12px',
            fontStyle: 'italic',
          }}
        >
          Select sequence first
        </div>
      )}
    </>
  );
}

function SequenceContextMenuItems(section: MenuSectionProps) {
  return (
    <>
      <CopyExtractMenuItems {...section} />
      <StructureAskMenuItems {...section} />
      <AnnotationPrimerCreateMenuItems {...section} />
      <TargetViewMenuItems {...section} />
    </>
  );
}

export function SequenceContextMenu(props: SequenceContextMenuProps): React.ReactElement | null {
  const { x, y, isOpen, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y });
  const styles = getMenuStyles();
  const flags = sequenceContextMenuFlags(props);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        e.stopPropagation();
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isOpen, onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      const nextPosition = clampFixedMenuPosition({
        x,
        y,
        menuWidth: rect?.width ?? 200,
        menuHeight: rect?.height ?? 250,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        padding: 10,
      });

      setAdjustedPosition((current) =>
        current.x === nextPosition.x && current.y === nextPosition.y ? current : nextPosition
      );
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [x, y, isOpen]);

  const handleItemClick = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose]
  );

  if (!isOpen) return null;
  const menuHost = typeof document === 'undefined' ? null : document.body;

  const menu = (
    <div
      ref={menuRef}
      data-testid="sequence-context-menu"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) max-content',
        columnGap: '16px',
        position: 'fixed',
        left: adjustedPosition.x,
        top: adjustedPosition.y,
        backgroundColor: 'hsl(var(--color-bg-subtle))',
        border: '1px solid hsl(var(--color-border))',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        padding: '0',
        minWidth: '180px',
        maxWidth: 'calc(100vw - 20px)',
        boxSizing: 'border-box',
        zIndex: 10000,
        fontFamily: 'var(--font-sans)',
        fontSize: '13px',
        maxHeight: 'calc(100vh - 20px)',
        overflowY: 'auto',
      }}
    >
      <SequenceContextMenuItems
        flags={flags}
        styles={styles}
        onItem={handleItemClick}
        props={props}
      />
    </div>
  );

  return menuHost ? createPortal(menu, menuHost) : menu;
}

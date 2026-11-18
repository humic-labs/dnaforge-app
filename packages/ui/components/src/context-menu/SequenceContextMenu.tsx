import React, { useEffect, useRef, useCallback, useLayoutEffect, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import {
  focusTargetAllows,
  inputTargetAllows,
  subscribeInputRevocation,
} from '@waypoint/platform/input-ownership';
import { formatShortcut } from '../keyboard/shortcuts';
import { MenuRow, MenuSeparator, MenuStatus, MenuSurface } from '../menu/presentation';
import { useMenu } from '../menu/use-menu';
import { clampFixedMenuPosition } from './positioning';
import { sequenceContextMenuFlags } from './sequence-context-menu-flags';
import type { SequenceContextMenuProps } from './sequence-context-menu-props';

export type { SequenceContextMenuProps };

type SequenceMenuAction = {
  id: string;
  label: string;
  run: () => void;
  shortcut?: string;
  targetLabel?: string;
  targetTone?: 'feature' | 'muted';
  intent?: 'primary' | 'creation' | 'destructive' | 'agent';
  disabled?: boolean;
  title?: string;
  testId?: string;
  onHoverChange?: (hovering: boolean) => void;
};

function sequenceMenuSections(props: SequenceContextMenuProps): SequenceMenuAction[][] {
  const flags = sequenceContextMenuFlags(props);
  const sections: SequenceMenuAction[][] = [];
  let section: SequenceMenuAction[] = [];
  const add = (
    id: string,
    label: string,
    run: (() => void) | undefined,
    detail: Partial<SequenceMenuAction> = {}
  ) => {
    if (run) section.push({ ...detail, id, label, run });
  };
  const next = () => {
    if (section.length) sections.push(section);
    section = [];
  };
  if (flags.hasSelection) {
    add('copy-sequence', 'Copy Sequence', props.onCopySequence, {
      shortcut: props.shortcutHints?.copySequence ?? formatShortcut(['cmd', 'c']),
    });
    add(
      'copy-reverse-complement',
      'Copy Sequence (Reverse Complement)',
      props.onCopyReverseComplement,
      { shortcut: props.shortcutHints?.copyReverseComplement }
    );
    add('copy-translation', 'Copy Translation', props.onCopyTranslation, {
      shortcut: props.shortcutHints?.copyTranslation,
    });
  }
  if (props.clickedTranscript) {
    const targetLabel = props.clickedTranscript.name;
    add('copy-transcript-dna', 'Copy transcript DNA', props.onCopyTranscriptDna, { targetLabel });
    add('copy-transcript-rna', 'Copy transcript RNA', props.onCopyTranscriptRna, { targetLabel });
    add('choose-isoform', 'Choose isoform…', props.onChooseTranscriptIsoform, { targetLabel });
  }
  if (props.clickedCDS) {
    add('copy-cds-translation', 'Copy CDS Translation', props.onCopyCDSTranslation, {
      targetLabel: props.clickedCDS.name,
      onHoverChange: props.onPreviewCDS,
    });
    add(
      'create-amino-acid-sequence',
      'Create amino acid sequence',
      props.onCreateAminoAcidSequence,
      {
        targetLabel: props.createAminoAcidSequenceDisabled ? 'unavailable' : props.clickedCDS.name,
        targetTone: props.createAminoAcidSequenceDisabled ? 'muted' : 'feature',
        intent: 'creation',
        disabled: props.createAminoAcidSequenceDisabled,
        title: props.createAminoAcidSequenceDisabled
          ? 'This CDS has no valid translation (internal stop codon or length not a multiple of 3)'
          : undefined,
        testId: props.createAminoAcidSequenceDisabled
          ? 'create-amino-acid-sequence-disabled'
          : undefined,
      }
    );
  }
  next();
  const structureFeature =
    props.structureAnnotation !== undefined ? props.structureAnnotation : props.clickedCDS;
  if (structureFeature && flags.hasStructureAction)
    add('view-structure', 'View Structure', props.onViewStructure, {
      targetLabel: structureFeature.name,
    });
  next();
  if (flags.hasSelection)
    add('ask-agent', 'Ask Agent', props.onAskAI, {
      shortcut: props.askAiShortcut,
      intent: 'agent',
    });
  next();
  if (flags.hasAddAnnotationAction && props.selectionRange && props.onAddAnnotation) {
    const { selectionRange, onAddAnnotation } = props;
    add('add-annotation', 'Add Annotation', () => onAddAnnotation(selectionRange), {
      shortcut: props.shortcutHints?.addAnnotation,
      intent: 'creation',
    });
  }
  if (flags.hasSaveOrfAction && props.clickedORF && props.onSaveORFAsAnnotation) {
    const { clickedORF, onSaveORFAsAnnotation } = props;
    add('add-orf-as-cds', 'Add ORF as CDS', () => onSaveORFAsAnnotation(clickedORF), {
      targetLabel: `${clickedORF.length} bp`,
      targetTone: 'muted',
      intent: 'creation',
    });
  }
  if (props.clickedAnnotation) {
    const annotation = props.clickedAnnotation;
    if (props.clickedAnnotationIsCdsExtensionPreview) {
      add('extend-cds', 'Extend existing CDS annotation', props.onCommitCdsExtension, {
        targetLabel: annotation.name,
        intent: 'creation',
      });
    } else {
      const { onEditAnnotation, onDeleteAnnotation } = props;
      add(
        'edit-annotation',
        'Edit Annotation',
        onEditAnnotation ? () => onEditAnnotation(annotation) : undefined,
        { intent: 'creation' }
      );
      add(
        'delete-annotation',
        'Delete Annotation',
        onDeleteAnnotation ? () => onDeleteAnnotation(annotation) : undefined,
        { intent: 'destructive' }
      );
    }
  }
  next();
  add('attach-primers', 'Attach Primers', props.onAttachPrimers);
  if (flags.hasSelection) {
    add('create-forward-primer', 'Create Forward Primer →', props.onCreateForwardPrimer, {
      intent: 'creation',
    });
    add('create-reverse-primer', 'Create Reverse Primer ←', props.onCreateReversePrimer, {
      intent: 'creation',
    });
  }
  next();
  add(
    'flip-assembly-part',
    'Flip assembly part (reverse complement)',
    props.onReverseComplementAssemblyPart,
    { intent: 'primary' }
  );
  if (props.clickedPrimer) {
    const targetLabel = props.clickedPrimer.name;
    add('copy-primer-bases', 'Copy bases', props.onCopyPrimerBases);
    add('edit-primer-binding', 'Edit binding site', props.onEditPrimerBinding, {
      targetLabel,
      targetTone: 'muted',
      intent: 'primary',
    });
    add('open-primer', 'Open primer', props.onEditPrimer, {
      targetLabel,
      targetTone: 'muted',
      intent: 'primary',
    });
    add('detach-primer', 'Detach Primer', props.onDetachPrimer, { intent: 'destructive' });
  }
  next();
  if (flags.hasSelection)
    add('invert-selection', 'Select inverse', props.onInvertSelection, {
      shortcut: props.shortcutHints?.invertSelection,
    });
  add('reindex', 'Re-index here', props.onReindexHere);
  add('flip-view', 'Reverse complement viewing direction', props.onFlipOrientation);
  if (flags.hasResetSequenceViewAction)
    add('reset-view', 'Reset sequence view', props.onResetSequenceView);
  next();
  add('paste', 'Paste', props.onPaste, {
    shortcut: props.shortcutHints?.paste,
    targetLabel: props.pasteTargetLabel,
    intent: 'primary',
  });
  next();
  if (props.isOnNucleotideRow)
    add('edit-sequence', 'Edit Sequence', props.onEditSequence, { intent: 'creation' });
  next();
  return sections;
}

const LABEL_TONE = {
  primary: 'text-accent font-medium',
  creation: 'text-success font-semibold',
  destructive: '',
  agent: 'text-warning font-semibold',
} as const;

function SequenceMenuLabel({ action }: { action: SequenceMenuAction }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={action.intent ? LABEL_TONE[action.intent] : undefined}>{action.label}</span>
      {action.targetLabel ? (
        <span
          data-testid="sequence-context-menu-target"
          className={`min-w-0 truncate text-xs ${action.targetTone === 'muted' ? 'text-fg-subtle' : 'font-medium text-success'}`}
          title={action.targetLabel}
        >
          ({action.targetLabel})
        </span>
      ) : null}
    </span>
  );
}

export function SequenceContextMenu(props: SequenceContextMenuProps): React.ReactElement | null {
  const { x, y, isOpen, onClose, rootRef } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuId = useId();
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y });
  const sections = sequenceMenuSections(props);
  const actions = sections.flat();
  const menu = useMenu({
    items: actions.map((action) => ({
      id: action.id,
      textValue: action.label,
      disabled: action.disabled,
    })),
    defaultOpen: isOpen,
    onActivate: (id) => actions.find((action) => action.id === id)?.run(),
    onClose: () => {
      if (isOpen) onClose();
    },
    onFocusItem: (id) => {
      const item = itemRefs.current.get(id);
      if (item?.isConnected && focusTargetAllows(item)) item.focus({ preventScroll: true });
    },
  });
  const {
    bindSurface,
    close,
    send,
    state: { session },
    stateRef,
  } = menu;
  const bindMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      rootRef?.(node);
      bindSurface(node);
    },
    [rootRef, bindSurface]
  );
  useLayoutEffect(() => {
    if (isOpen && stateRef.current.phase === 'closed') send({ type: 'open', menuId: 'root' });
    else if (!isOpen && stateRef.current.phase !== 'closed')
      send({ type: 'close', session: stateRef.current.session, reason: 'handoff' });
  }, [isOpen, send, stateRef]);
  useEffect(() => {
    if (!isOpen || !menu.isOpen) return;
    const element = menuRef.current;
    if (!element) return;
    const handleOutside = (event: MouseEvent) => {
      if (!element.contains(event.target as Node)) close('outside-pointer', session);
    };
    const handleBlur = () => close('window-blur', session);
    const unsubscribe = subscribeInputRevocation(element, () => close('owner-revoked', session));
    document.addEventListener('mousedown', handleOutside, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      unsubscribe();
      document.removeEventListener('mousedown', handleOutside, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen, menu.isOpen, session, close]);
  useLayoutEffect(() => {
    if (!isOpen || !menu.isOpen) return;
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
      send({ type: 'positioned', session });
    };
    updatePosition();
    const first = itemRefs.current.get(stateRef.current.levels[0]?.activeId ?? '');
    if (first?.isConnected && focusTargetAllows(first)) first.focus({ preventScroll: true });
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [x, y, isOpen, menu.isOpen, session, send, stateRef]);
  if (!isOpen || !menu.isOpen) return null;
  const surface = (
    <MenuSurface
      ref={bindMenu}
      role="menu"
      aria-label="Sequence actions"
      data-testid="sequence-context-menu"
      density="compact"
      selection={false}
      shortcuts
      onKeyDown={menu.handleKeyDown}
      style={{
        position: 'fixed',
        left: adjustedPosition.x,
        top: adjustedPosition.y,
        minWidth: 180,
        maxWidth: 'calc(100vw - 20px)',
        maxHeight: 'calc(100vh - 20px)',
        overflowY: 'auto',
        zIndex: 10000,
      }}
    >
      {sections.map((section, index) => (
        <React.Fragment key={section[0].id}>
          {index > 0 ? <MenuSeparator data-testid="sequence-context-menu-divider" /> : null}
          {section.map((action) => (
            <MenuRow
              key={action.id}
              id={`${menuId}-${action.id}`}
              ref={(node) => {
                if (node) itemRefs.current.set(action.id, node);
                else itemRefs.current.delete(action.id);
              }}
              role="menuitem"
              tabIndex={action.id === menu.activeId ? 0 : -1}
              disabled={action.disabled}
              active={action.id === menu.activeId}
              tone={action.intent === 'destructive' ? 'danger' : 'default'}
              title={action.title}
              data-testid={action.testId}
              data-menu-item-id={action.id}
              shortcut={
                <span
                  data-testid={action.shortcut ? 'sequence-context-menu-shortcut' : undefined}
                  data-shortcut-column="true"
                >
                  {action.shortcut}
                </span>
              }
              onFocus={() => menu.point(action.id)}
              onMouseEnter={() => {
                menu.point(action.id);
                action.onHoverChange?.(true);
              }}
              onMouseLeave={() => action.onHoverChange?.(false)}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (inputTargetAllows(event.currentTarget, 'pointer', event.nativeEvent))
                  menu.activate(action.id);
              }}
              onClick={(event) => {
                if (event.detail === 0) menu.activate(action.id);
              }}
            >
              <SequenceMenuLabel action={action} />
            </MenuRow>
          ))}
        </React.Fragment>
      ))}
      {sequenceContextMenuFlags(props).showEmptyHint ? (
        <MenuStatus>
          <span className="italic">Select sequence first</span>
        </MenuStatus>
      ) : null}
    </MenuSurface>
  );
  return typeof document === 'undefined' ? surface : createPortal(surface, document.body);
}

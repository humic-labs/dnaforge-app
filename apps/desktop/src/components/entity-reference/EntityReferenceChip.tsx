import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { stripDisplayExtension } from '../../utils/fileTypes';
import { DEFAULT_TOOLTIP_DELAY_MS } from '../../shared/components/Tooltip';
import { usePresentationEligibility } from '../../presentation/PresentationSurface';
import { iconForEntityKind } from '../icons/entity-icon-registry';
import type { EntityColorContext } from '../../shared/entity-color-family';
import { ActionMenu } from '../ActionMenu';

function pointerIsOnChipRemove(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.entity-reference-chip__remove'));
}

export type EntityReferenceAction = 'open' | 'reveal';

export interface EntityReferenceChipProps {
  entityType: string;
  kindLabel?: string;
  iconOverride?: ReactNode;
  iconContext?: EntityColorContext;
  showKindLabel?: boolean;
  label: string;
  preserveExtension?: boolean;
  detail?: unknown;
  primaryAction?: EntityReferenceAction;
  busy?: boolean;
  onOpen?: () => void | Promise<void>;
  onReveal?: () => void | Promise<void>;
  unavailable?: boolean;
  localOnly?: boolean;
  testId?: string;
  labelTestId?: string;
  detailTestId?: string;
  iconPlacement?: 'start' | 'end';
  endSlot?: ReactNode;
  attachmentPhase?: 'draft' | 'sent';
}

interface MenuAction {
  id: EntityReferenceAction;
  label: string;
  run: () => void | Promise<void>;
}

const ENTITY_DETAIL_LABELS: Readonly<Record<string, string>> = {
  alignment: 'Alignment',
  annotation: 'Annotation',
  assembly: 'Assembly',
  directory: 'Folder',
  file: 'File',
  folder: 'Folder',
  notebook: 'Notebook',
  oligo: 'Primer',
  page: 'Notebook',
  'page-link': 'Notebook',
  primer: 'Primer',
  protein: 'Protein',
  sequence: 'Sequence',
  sequence_region: 'Sequence region',
  structure: 'Structure',
  text: 'File',
};

function entityDetailLabel(entityType: string): string {
  return (
    ENTITY_DETAIL_LABELS[entityType] ??
    entityType
      .replace(/[-_]+/g, ' ')
      .replace(/^./, (firstCharacter) => firstCharacter.toUpperCase())
  );
}

function EntityReferenceChipInner({
  entityType,
  kindLabel: kindLabelOverride,
  iconOverride,
  iconContext,
  showKindLabel = false,
  label,
  preserveExtension = false,
  primaryAction,
  busy = false,
  onOpen,
  onReveal,
  unavailable = false,
  localOnly = false,
  testId = 'entity-reference-chip',
  labelTestId = 'entity-reference-chip-label',
  detailTestId = 'entity-reference-chip-detail',
  iconPlacement = 'end',
  endSlot,
  attachmentPhase,
}: EntityReferenceChipProps) {
  const displayLabel = preserveExtension ? label : stripDisplayExtension(label);
  const kindLabel = kindLabelOverride ?? entityDetailLabel(entityType);
  const displayDetail = `${displayLabel} · ${kindLabel}${unavailable ? ' · Unavailable' : ''}`;
  const resolvedPrimaryAction =
    primaryAction ?? (onOpen ? 'open' : onReveal ? 'reveal' : undefined);
  const primaryActionHandler =
    resolvedPrimaryAction === 'open'
      ? onOpen
      : resolvedPrimaryAction === 'reveal'
        ? onReveal
        : undefined;
  const hasPrimaryAction = Boolean(primaryActionHandler);
  const [hovered, setHovered] = useState(false);
  const [detailReady, setDetailReady] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const chipRef = useRef<HTMLSpanElement>(null);
  const generatedId = useId().replace(/:/g, '');
  const detailId = `entity-reference-detail-${generatedId}`;
  const canPresent = usePresentationEligibility('presentation');
  const showDetail =
    canPresent && !menuOpen && (focused || (attachmentPhase ? detailReady : hovered));
  const [detailPosition, setDetailPosition] = useState<{
    left: number;
    edge: 'top' | 'bottom';
    offset: number;
  } | null>(null);
  const defaultIcon = useMemo(
    () => iconForEntityKind(entityType, 'h-3.5 w-3.5', iconContext),
    [entityType, iconContext]
  );
  const icon = iconOverride ?? defaultIcon;
  const actions = useMemo<MenuAction[]>(() => {
    if (unavailable || busy) return [];
    return [
      ...(onOpen ? ([{ id: 'open', label: 'Open', run: onOpen }] satisfies MenuAction[]) : []),
      ...(onReveal
        ? ([{ id: 'reveal', label: 'Show in Explorer', run: onReveal }] satisfies MenuAction[])
        : []),
    ];
  }, [busy, onOpen, onReveal, unavailable]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const openMenu = useCallback(() => {
    if (actions.length === 0) return;
    setHovered(false);
    setMenuOpen(true);
  }, [actions.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnScroll = () => closeMenu();
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (!attachmentPhase || !hovered || menuOpen) {
      setDetailReady(false);
      return;
    }
    const timer = window.setTimeout(() => setDetailReady(true), DEFAULT_TOOLTIP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [attachmentPhase, hovered, menuOpen]);

  useEffect(() => {
    if (!hovered) return;
    const onPointerMove = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (chipRef.current?.contains(target)) return;
      setHovered(false);
    };
    document.addEventListener('pointermove', onPointerMove);
    return () => document.removeEventListener('pointermove', onPointerMove);
  }, [hovered]);

  useLayoutEffect(() => {
    const chip = chipRef.current;
    if (!showDetail || !chip) {
      setDetailPosition(null);
      return;
    }
    const place = () => {
      const rect = chip.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 128));
      const placeAbove = rect.bottom + 36 > window.innerHeight && rect.top >= 36;
      const edge = placeAbove ? 'bottom' : 'top';
      const offset = placeAbove ? window.innerHeight - rect.top + 4 : rect.bottom + 4;
      setDetailPosition((previous) => {
        if (previous?.left === left && previous.edge === edge && previous.offset === offset)
          return previous;
        return { left, edge, offset };
      });
    };
    place();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    observer?.observe(chip);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [showDetail]);

  const runPrimaryAction = useCallback(() => {
    if (unavailable || busy || !primaryActionHandler) return;
    setHovered(false);
    setFocused(false);
    void primaryActionHandler();
  }, [busy, primaryActionHandler, unavailable]);

  const onChipKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        openMenu();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        runPrimaryAction();
      }
    },
    [openMenu, runPrimaryAction]
  );

  return (
    <>
      <span
        ref={chipRef}
        data-testid={testId}
        data-entity-reference-chip="true"
        data-entity-type={entityType}
        data-local-only={localOnly ? 'true' : undefined}
        className={`entity-reference-chip${unavailable ? ' entity-reference-chip--unavailable' : ''}${
          attachmentPhase ? ` entity-reference-chip--${attachmentPhase}` : ''
        }`}
        role={hasPrimaryAction || unavailable ? 'link' : undefined}
        tabIndex={hasPrimaryAction || unavailable ? 0 : -1}
        aria-label={displayLabel ? `${displayLabel}, ${kindLabel}` : kindLabel}
        aria-disabled={unavailable ? 'true' : undefined}
        aria-busy={busy ? 'true' : undefined}
        aria-describedby={showDetail ? detailId : undefined}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        onMouseEnter={(event) => {
          if (pointerIsOnChipRemove(event.target)) return;
          setHovered(true);
        }}
        onMouseMove={(event) => {
          if (pointerIsOnChipRemove(event.target)) {
            setHovered(false);
            return;
          }
          setHovered(true);
        }}
        onMouseLeave={() => setHovered(false)}
        onClick={runPrimaryAction}
        onContextMenu={(event) => {
          if (actions.length === 0) return;
          event.preventDefault();
          openMenu();
        }}
        onKeyDown={onChipKeyDown}
      >
        {iconPlacement === 'start' && icon ? (
          <span aria-hidden="true" className="entity-reference-chip__icon">
            {icon}
          </span>
        ) : null}
        {showKindLabel && (
          <span className="shrink-0 text-[10px] font-medium text-fg-muted">
            {kindLabel}
            <span aria-hidden="true"> · </span>
          </span>
        )}
        <span className="entity-reference-chip__label" data-testid={labelTestId}>
          {displayLabel}
        </span>
        {iconPlacement === 'end' && icon ? (
          <span aria-hidden="true" className="entity-reference-chip__icon">
            {icon}
          </span>
        ) : null}
        {endSlot}
      </span>
      {showDetail && detailPosition
        ? createPortal(
            <span
              id={detailId}
              className="entity-reference-chip__detail ph-no-capture rr-block"
              data-testid={detailTestId}
              data-ph-no-capture
              data-analytics-block
              data-ph-mask
              style={{
                left: detailPosition.left,
                top: detailPosition.edge === 'top' ? detailPosition.offset : undefined,
                bottom: detailPosition.edge === 'bottom' ? detailPosition.offset : undefined,
                maxWidth: `min(32rem, calc(100vw - ${detailPosition.left + 8}px))`,
              }}
              role="tooltip"
            >
              {displayDetail}
            </span>,
            document.body
          )
        : null}
      <ActionMenu
        open={menuOpen}
        anchorRef={chipRef}
        onClose={closeMenu}
        label={`Actions for ${displayLabel}`}
        testId={`${testId}-menu`}
        entries={actions.map((action) => ({
          id: action.id,
          label: action.label,
          testId: `${testId}-menu-${action.id}`,
          onSelect: () => {
            void action.run();
          },
        }))}
      />
    </>
  );
}

export const EntityReferenceChip = memo(EntityReferenceChipInner);

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
import {
  entityTypeIconKind,
  namedEntityTypePresentation,
  resolveNamedEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import { DEFAULT_TOOLTIP_DELAY_MS } from '../../shared/components/Tooltip';
import { usePresentationEligibility } from '../../presentation/PresentationSurface';
import { iconForEntityKind, referenceIconPresentation } from '../icons/entity-icon-registry';
import type { EntityColorContext } from '../../shared/entity-color-family';
import { ActionMenu } from '../ActionMenu';
import { useReferenceEntityType, type ReferenceTypeLookup } from './useReferenceEntityType';
import { ReferenceChipSurface } from '../ui/controls';

function pointerIsOnChipRemove(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.entity-reference-chip__remove'));
}

export type EntityReferenceAction = 'open' | 'reveal';

export interface EntityReferenceChipProps {
  entityType: string;
  kindLabel?: string;
  typeLookup?: ReferenceTypeLookup;
  iconKind?: string;
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
  endSlot?: ReactNode;
  attachmentPhase?: 'draft' | 'sent';
}

interface MenuAction {
  id: EntityReferenceAction;
  label: string;
  run: () => void | Promise<void>;
}

function EntityReferenceChipInner({
  entityType,
  typeLookup,
  kindLabel: kindLabelOverride,
  iconKind: iconKindOverride,
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
  endSlot,
  attachmentPhase,
}: EntityReferenceChipProps) {
  const displayLabel = preserveExtension ? label : stripDisplayExtension(label);
  const resolvedType = useReferenceEntityType(typeLookup);
  const fallback = namedEntityTypePresentation(resolveNamedEntityType({ type: entityType }));
  const kindLabel = resolvedType?.kindLabel ?? kindLabelOverride ?? fallback.kindLabel;
  const iconKind =
    resolvedType?.iconKind ??
    iconKindOverride ??
    (entityTypeIconKind(entityType) ? fallback.iconKind : entityType);
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
  const defaultIcon = useMemo(() => {
    const { kind, context } = referenceIconPresentation({
      type: entityType,
      iconKind,
      namedTypeKey: resolvedType?.namedTypeKey,
      path: resolvedType?.path,
      registryKind: resolvedType?.registryKind,
      iconContext: {
        ...iconContext,
        ...(resolvedType?.registryKind ? { kind: resolvedType.registryKind } : {}),
        ...resolvedType?.iconContext,
      },
    });
    return iconForEntityKind(kind, 'h-3.5 w-3.5', context);
  }, [entityType, iconKind, iconContext, resolvedType]);
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
      <ReferenceChipSurface
        ref={chipRef}
        data-testid={testId}
        data-entity-reference-chip="true"
        data-entity-type={entityType}
        data-local-only={localOnly ? 'true' : undefined}
        unavailable={unavailable}
        attachmentPhase={attachmentPhase}
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
        {icon ? (
          <span aria-hidden="true" className="entity-reference-chip__icon">
            {icon}
          </span>
        ) : null}
        <span className="entity-reference-chip__label" data-testid={labelTestId}>
          {displayLabel}
        </span>
        {endSlot}
      </ReferenceChipSurface>
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

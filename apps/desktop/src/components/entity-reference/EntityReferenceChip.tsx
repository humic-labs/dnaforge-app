import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { stripDisplayExtension } from '../../utils/fileTypes';
import { DEFAULT_TOOLTIP_DELAY_MS } from '../../shared/components/Tooltip';
import { safeFocus } from '../../shared/utils/safeFocus';
import { iconForEntityKind } from '../icons/entity-icon-registry';
import { PortalMenu } from '../PortalMenu';

function pointerIsOnChipRemove(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.entity-reference-chip__remove'));
}

export type EntityReferenceAction = 'open' | 'reveal';

export interface EntityReferenceChipProps {
  entityType: string;
  kindLabel?: string;
  iconOverride?: ReactNode;
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
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generatedId = useId().replace(/:/g, '');
  const detailId = `entity-reference-detail-${generatedId}`;
  const showDetail = !menuOpen && (focused || (attachmentPhase ? detailReady : hovered));
  const defaultIcon = useMemo(() => iconForEntityKind(entityType, 'h-3.5 w-3.5'), [entityType]);
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

  const restoreFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      safeFocus(chipRef.current);
    });
  }, []);

  const closeMenu = useCallback(
    (shouldRestoreFocus: boolean) => {
      setMenuOpen(false);
      if (shouldRestoreFocus) restoreFocus();
    },
    [restoreFocus]
  );

  const openMenu = useCallback(() => {
    if (actions.length === 0) return;
    setHovered(false);
    setMenuOpen(true);
  }, [actions.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => safeFocus(itemRefs.current[0]));
    const closeOnScroll = () => closeMenu(true);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.cancelAnimationFrame(frame);
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

  const runPrimaryAction = useCallback(() => {
    if (unavailable || busy || !primaryActionHandler) return;
    setHovered(false);
    setFocused(false);
    void primaryActionHandler();
  }, [busy, primaryActionHandler, unavailable]);

  const runMenuAction = useCallback(
    (action: MenuAction) => {
      setMenuOpen(false);
      const result = action.run();
      if (action.id === 'reveal') {
        void Promise.resolve(result).finally(restoreFocus);
      }
    },
    [restoreFocus]
  );

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

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (actions.length === 0) return;
      const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
      let nextIndex: number | null = null;
      if (event.key === 'ArrowDown') nextIndex = (Math.max(currentIndex, -1) + 1) % actions.length;
      if (event.key === 'ArrowUp')
        nextIndex = (currentIndex <= 0 ? actions.length : currentIndex) - 1;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = actions.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        safeFocus(itemRefs.current[nextIndex]);
      }
    },
    [actions.length]
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
        {showDetail ? (
          <span
            id={detailId}
            className="entity-reference-chip__detail"
            data-testid={detailTestId}
            role="tooltip"
          >
            {displayDetail}
          </span>
        ) : null}
      </span>
      <PortalMenu
        open={menuOpen}
        anchorRef={chipRef}
        onRequestClose={() => closeMenu(true)}
        role="menu"
        data-testid={`${testId}-menu`}
        className="entity-reference-chip__menu py-1"
      >
        <div onKeyDown={onMenuKeyDown}>
          {actions.map((action, index) => (
            <button
              key={action.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-testid={`${testId}-menu-${action.id}`}
              className="entity-reference-chip__menu-item"
              onClick={() => runMenuAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </PortalMenu>
    </>
  );
}

export const EntityReferenceChip = memo(EntityReferenceChipInner);

import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from 'react';
import {
  ASSEMBLY_SEGMENT_RAIL_WIDTH,
  getAssemblyPartSurfaceColor,
  getAssemblySegmentRailColor,
  hexToRgba,
} from '../../design/public/colors';

export const PRODUCT_INTERSTITIAL_WIDTH_CLASS = 'w-[128px]';

interface ProductSegmentCardProps {
  shellTestId: string;
  cardTestId: string;
  color: string;
  isDragging: boolean;
  density?: 'compact' | 'form';
  tone?: 'default' | 'warning' | 'error';
  surface?: 'fragment' | 'neutral';
  isSelected?: boolean;
  children: ReactNode;
  onRegister?: (node: HTMLDivElement | null) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus?: () => void;
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
  shellStyle?: CSSProperties;
  topInset?: boolean;
  bottomInset?: boolean;
  cardData?: Record<string, string | number | boolean | undefined>;
  role?: 'button';
  ariaLabel?: string;
  draggable?: boolean;
}

export function ProductSegmentCard({
  shellTestId,
  cardTestId,
  color,
  isDragging,
  density = 'compact',
  tone = 'default',
  surface = 'fragment',
  isSelected = false,
  children,
  onRegister,
  onPointerEnter,
  onPointerLeave,
  onClick,
  onKeyDown,
  onFocus,
  onBlur,
  shellStyle,
  topInset = false,
  bottomInset = false,
  cardData,
  role,
  ariaLabel,
  draggable = true,
}: ProductSegmentCardProps) {
  const railColor = getAssemblySegmentRailColor(surface, color);
  const baseSurface =
    surface === 'fragment' ? getAssemblyPartSurfaceColor(color) : 'hsl(var(--color-bg))';
  const cardStyle = {
    '--segment-surface': baseSurface,
    '--segment-outline-color': railColor,
    '--segment-handle-bg': hexToRgba(railColor, 0.13),
    '--segment-handle-bg-hover': hexToRgba(railColor, 0.22),
    borderLeftColor: railColor,
    borderLeftWidth: ASSEMBLY_SEGMENT_RAIL_WIDTH,
    backgroundColor: 'var(--segment-surface)',
    touchAction: draggable ? 'none' : 'auto',
  } as CSSProperties & Record<string, string | number>;

  return (
    <div
      data-testid={shellTestId}
      className="relative"
      ref={onRegister}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      style={shellStyle}
    >
      <div
        data-testid={cardTestId}
        data-assembly-product-segment-card="true"
        data-dragging={isDragging ? 'true' : 'false'}
        data-selected={isSelected ? 'true' : 'false'}
        role={role}
        aria-label={ariaLabel}
        aria-selected={role ? undefined : isSelected}
        tabIndex={0}
        {...dataAttributes(cardData)}
        className={`relative flex overflow-visible rounded-md border ${
          density === 'form' ? 'items-center gap-2 p-1.5' : 'items-start gap-2 p-2'
        } ${
          isDragging || isSelected
            ? 'border-[var(--segment-outline-color)] shadow-lg ring-1 ring-[var(--segment-outline-color)]'
            : tone === 'error'
              ? 'border-error/70 bg-error/10 ring-1 ring-error/20 hover:border-error focus-within:border-error'
              : tone === 'warning'
                ? 'border-amber-500/30 hover:border-[var(--segment-outline-color)] hover:bg-amber-500/15 focus-within:border-[var(--segment-outline-color)]'
                : 'border-border hover:border-[var(--segment-outline-color)] focus-within:border-[var(--segment-outline-color)]'
        }`}
        style={cardStyle}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <CardInset position="top" active={topInset && !isDragging} />
        <CardInset position="bottom" active={bottomInset && !isDragging} />
        {children}
      </div>
    </div>
  );
}

export function ProductSegmentDragHandle({
  testId,
  label,
  isDragging,
  onPointerDown,
}: {
  testId: string;
  label: string;
  isDragging: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onPointerDown={onPointerDown}
      onClick={(event) => event.stopPropagation()}
      className="mt-0.5 flex h-7 w-6 shrink-0 self-start items-center justify-center rounded bg-[var(--segment-handle-bg)] text-fg-muted transition-colors hover:bg-[var(--segment-handle-bg-hover)] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg-subtle/40 active:cursor-grabbing"
      style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M8 6h2v2H8V6zm6 0h2v2h-2V6zM8 11h2v2H8v-2zm6 0h2v2h-2v-2zm-6 5h2v2H8v-2zm6 0h2v2h-2v-2z" />
      </svg>
    </button>
  );
}

function CardInset({ position, active }: { position: 'top' | 'bottom'; active: boolean }) {
  if (!active) return null;
  const positionClass =
    position === 'top' ? 'top-[-1px] rounded-b-md border-b' : 'bottom-[-1px] rounded-t-md border-t';

  return (
    <span
      aria-hidden
      data-testid={`assembly-segment-${position}-inset`}
      className={`pointer-events-none absolute left-1/2 z-10 h-[7px] -translate-x-1/2 border-x border-border bg-bg ${positionClass} ${PRODUCT_INTERSTITIAL_WIDTH_CLASS}`}
    />
  );
}

function dataAttributes(
  data: Record<string, string | number | boolean | undefined> | undefined
): Record<string, string | number | boolean> {
  if (!data) return {};
  return Object.fromEntries(
    Object.entries(data).filter((entry): entry is [string, string | number | boolean] => {
      return entry[1] !== undefined;
    })
  );
}

import type { HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { INTERACTION_CLASS } from '@waypoint/ui-components';

import { ChevronRotatableIcon, SpinnerIcon } from '../../../components/icons';

export interface TreeRowProps extends HTMLAttributes<HTMLDivElement> {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  isSelected: boolean;
  isExpanded?: boolean;
  isDropActive?: boolean;
  isLoading?: boolean;
  onToggleExpand?: () => void;
  toggleLabel?: string;
  toggleTestId?: string;
  labelClassName?: string;
  labelTitle?: string;
  [dataAttr: `data-${string}`]: unknown;
}

const ROW_BASE = `${INTERACTION_CLASS} relative w-full flex items-center gap-1.5 py-1 pr-2 text-left text-sm cursor-pointer select-none`;

const ROW_DROP_ACTIVE =
  'data-[drop-active=true]:bg-accent/25 data-[drop-active=true]:ring-1 ' +
  'data-[drop-active=true]:ring-inset data-[drop-active=true]:ring-accent';

const ROW_SELECTED = 'text-accent';
const ROW_UNSELECTED = 'text-fg';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(function TreeRow(
  {
    depth,
    icon,
    label,
    trailing,
    isSelected,
    isExpanded,
    isDropActive,
    isLoading,
    onToggleExpand,
    toggleLabel,
    toggleTestId,
    labelClassName,
    labelTitle,
    className,
    style,
    ...rest
  },
  ref
) {
  const paddingLeft = 8 + depth * 16;
  const hasChevron = isExpanded !== undefined;

  const chevronContent = isLoading ? (
    <SpinnerIcon />
  ) : hasChevron ? (
    <ChevronRotatableIcon expanded={isExpanded} />
  ) : null;

  const chevronSlot =
    onToggleExpand && hasChevron && !isLoading ? (
      <button
        type="button"
        aria-label={toggleLabel}
        data-testid={toggleTestId}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpand();
        }}
        className={`${INTERACTION_CLASS} flex flex-shrink-0 items-center`}
      >
        <span className="w-3 flex-shrink-0">{chevronContent}</span>
      </button>
    ) : (
      <span className="w-3 flex-shrink-0">{chevronContent}</span>
    );

  return (
    <div
      ref={ref}
      {...rest}
      data-selected={isSelected || undefined}
      {...(isDropActive ? { 'data-drop-active': 'true' } : {})}
      style={{ ...style, paddingLeft }}
      className={cx(
        ROW_BASE,
        isSelected ? ROW_SELECTED : ROW_UNSELECTED,
        ROW_DROP_ACTIVE,
        className
      )}
    >
      {chevronSlot}
      {icon}
      <span className={cx('truncate', labelClassName)} title={labelTitle}>
        {label}
      </span>
      {trailing}
    </div>
  );
});

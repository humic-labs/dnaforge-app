import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { EditIcon } from '../../components/icons';

export const InlineEditableValue = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & { children: ReactNode; compact?: boolean }
>(function InlineEditableValue({ children, compact = false, className = '', ...props }, ref) {
  return (
    <button
      type="button"
      ref={ref}
      {...props}
      className={`${INTERACTION_CLASS} group/field-edit relative block min-w-0 rounded-md border border-transparent pr-6 text-left ${
        compact
          ? 'w-full truncate py-0.5 pl-1'
          : 'min-h-10 w-full whitespace-pre-wrap break-words py-2 pl-3 text-sm'
      } ${className}`}
    >
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-fg-subtle opacity-0 group-hover/field-edit:opacity-100 group-focus-visible/field-edit:opacity-100"
      >
        <EditIcon size={12} />
      </span>
    </button>
  );
});

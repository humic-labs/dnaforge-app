import { forwardRef } from 'react';
import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost';
  showTooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { className, icon, label, size = 'md', variant = 'default', showTooltip = true, ...props },
    ref
  ) => {
    const sizes = {
      sm: 'h-8 w-8',
      md: 'h-10 w-10',
    };

    const variants = {
      default: 'border border-border',
      ghost: '',
    };

    const button = (
      <button
        ref={ref}
        aria-label={label}
        data-interaction-border={variant === 'default' || undefined}
        className={cn(
          INTERACTION_CLASS,
          'inline-flex items-center justify-center rounded-full',
          'text-fg-muted',
          'transition-colors duration-fast ease-out',
          'disabled:pointer-events-none',
          sizes[size],
          variants[variant],
          className
        )}
        {...props}
      >
        {icon}
      </button>
    );

    return showTooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
  }
);

IconButton.displayName = 'IconButton';

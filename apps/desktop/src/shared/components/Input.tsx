import { toUserMessage } from '@waypoint/user-messages';
import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-fg">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'h-10 w-full rounded-md border px-3 text-sm',
            'bg-bg text-fg placeholder:text-fg-subtle',
            'border-border focus:border-accent',
            'transition-colors duration-fast ease-out',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            error && 'border-error focus:border-error focus-visible:ring-error',
            className
          )}
          {...props}
        />
        {error && (
          <span className="text-sm text-error">{toUserMessage(error, 'validation.invalid')}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

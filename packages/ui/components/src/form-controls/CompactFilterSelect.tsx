import type { ReactElement } from 'react';

export interface CompactFilterSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface CompactFilterSelectProps<T extends string> {
  value: T;
  options: readonly CompactFilterSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  density?: 'compact' | 'default';
  testId?: string;
  title?: string;
}

export function CompactFilterSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
  disabled = false,
  density = 'compact',
  testId,
  title,
}: CompactFilterSelectProps<T>): ReactElement {
  return (
    <div className={`relative min-w-0 ${className}`}>
      <select
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        data-testid={testId}
        data-compact-filter-select="true"
        title={title}
        onChange={(event) => onChange(event.target.value as T)}
        className={`w-full cursor-pointer appearance-none truncate rounded-md border border-border bg-bg-base pl-2 pr-6 text-fg shadow-sm outline-none transition-colors hover:border-fg-muted focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50 ${
          density === 'compact' ? 'h-6 py-0.5 text-[11px]' : 'h-7 py-1 text-[13px]'
        }`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-muted">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M2.5 4L5 6.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </div>
  );
}

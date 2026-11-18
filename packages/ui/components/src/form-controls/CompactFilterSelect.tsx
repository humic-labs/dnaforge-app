import type { ReactElement } from 'react';
import type { MenuDensity } from '../menu/appearance';
import { MenuNativeSelect } from '../menu/presentation';

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
  density?: MenuDensity;
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
      <MenuNativeSelect
        value={value}
        disabled={disabled}
        density={density}
        aria-label={ariaLabel}
        data-testid={testId}
        data-compact-filter-select="true"
        title={title}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </MenuNativeSelect>
    </div>
  );
}

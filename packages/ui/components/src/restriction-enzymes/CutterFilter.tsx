import { toUserMessage } from '@waypoint/user-messages';
import React from 'react';
import type { CutterFilter as CutterFilterType } from '@waypoint/sequence-utils';
import { CompactFilterSelect } from '../form-controls';

interface CutterFilterProps {
  value: CutterFilterType;
  onChange: (filter: CutterFilterType) => void;
  compact?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

const FILTER_OPTIONS: Array<{ value: CutterFilterType; label: string }> = [
  { value: 'both', label: 'All' },
  { value: 'single', label: 'Single cutters' },
  { value: 'double', label: 'Double cutters' },
  { value: 'single-double', label: 'Single & double cutters' },
  { value: 'none', label: 'Active only' },
];

export function CutterFilter({
  value,
  onChange,
  compact = false,
  disabled = false,
  disabledReason,
}: CutterFilterProps): React.ReactElement {
  return (
    <div
      className={
        compact
          ? 'flex items-center gap-1 flex-1'
          : 'flex items-center gap-2 px-3 py-2 border-b border-border'
      }
      title={disabled ? toUserMessage(disabledReason, 'primer.failed') : undefined}
    >
      <label
        className={
          compact
            ? 'text-[11px] font-medium text-fg-muted whitespace-nowrap'
            : 'text-xs font-medium text-fg-muted min-w-[50px]'
        }
      >
        Show
      </label>
      <CompactFilterSelect
        value={disabled ? 'both' : value}
        options={FILTER_OPTIONS}
        onChange={onChange}
        ariaLabel="Restriction enzyme cutter filter"
        className="flex-1"
        disabled={disabled}
        density={compact ? 'compact' : 'form'}
      />
    </div>
  );
}

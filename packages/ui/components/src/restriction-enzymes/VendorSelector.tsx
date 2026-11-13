import React from 'react';
import { VENDOR_CODES, type VendorCode } from '@waypoint/sequence-utils';
import { CompactFilterSelect } from '../form-controls';

interface VendorSelectorProps {
  value: VendorCode;
  onChange: (vendor: VendorCode) => void;
  compact?: boolean;
}

export function VendorSelector({
  value,
  onChange,
  compact = false,
}: VendorSelectorProps): React.ReactElement {
  return (
    <div
      className={
        compact
          ? 'flex items-center gap-1 max-w-[160px] shrink-0'
          : 'flex items-center gap-2 px-3 py-2 border-b border-border'
      }
    >
      <label
        className={
          compact
            ? 'text-[11px] font-medium text-fg-muted whitespace-nowrap'
            : 'text-xs font-medium text-fg-muted min-w-[50px]'
        }
      >
        Vendor
      </label>
      <CompactFilterSelect
        value={value}
        options={Object.entries(VENDOR_CODES).map(([code, name]) => ({
          value: code as VendorCode,
          label: name,
        }))}
        onChange={onChange}
        ariaLabel="Restriction enzyme vendor filter"
        className="flex-1"
        density={compact ? 'compact' : 'default'}
      />
    </div>
  );
}

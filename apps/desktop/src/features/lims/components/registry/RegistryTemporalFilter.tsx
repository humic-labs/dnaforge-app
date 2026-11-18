import { useState } from 'react';
import { parseLimsTemporalField } from '@waypoint/scientific-artifacts/shared/lims-temporal';
import type { LimsRegistryDateFilter } from '../../../../shared/lims';
import { RegistryTemporalInput } from '../../../../shared/components/RegistryTemporalInput';
import { Button } from '../../../../shared/components/Button';
import {
  temporalFieldValue,
  type TemporalFieldType,
} from '../../../../shared/registry-temporal-input';

export function RegistryTemporalFilter({
  label,
  type,
  filter,
  apply,
}: {
  label: string;
  type: TemporalFieldType;
  filter?: LimsRegistryDateFilter;
  apply(mode: LimsRegistryDateFilter['mode'] | null, value?: string): void;
}) {
  const [mode, setMode] = useState<LimsRegistryDateFilter['mode']>(filter?.mode ?? 'on');
  const [text, setText] = useState(() => {
    if (type !== 'datetime' || !filter?.value) return filter?.value ?? '';
    const instant = Date.parse(filter.value);
    if (!Number.isFinite(instant)) return '';
    return JSON.stringify({
      kind: 'timed',
      local: new Date(instant).toISOString().slice(0, -1),
      zone: 'UTC',
      instant,
    });
  });
  const needsValue = mode !== 'missing' && mode !== 'unresolved';
  const reading = needsValue ? parseLimsTemporalField(type, temporalFieldValue(type, text)) : null;
  return (
    <div className="space-y-2 text-xs font-normal normal-case">
      <label className="block">
        {label}
        <select
          aria-label={'Filter condition for ' + label}
          className="block w-full rounded border border-border bg-bg p-1"
          value={mode}
          onChange={(e) => setMode(e.target.value as LimsRegistryDateFilter['mode'])}
        >
          <option value="on">{type === 'datetime' ? 'At' : 'On'}</option>
          <option value="before">Before</option>
          <option value="after">After</option>
          <option value="missing">Missing</option>
          <option value="unresolved">Unresolved</option>
        </select>
      </label>
      {needsValue && (
        <RegistryTemporalInput
          label={'Filter value for ' + label}
          type={type}
          text={text}
          change={setText}
        />
      )}
      <div className="flex gap-1">
        <Button
          type="button"
          size="xs"
          disabled={needsValue && reading?.kind !== 'exact'}
          onClick={() => {
            const point = reading?.kind === 'exact' ? reading.value : undefined;
            apply(
              mode,
              point?.kind === 'timed' ? new Date(point.instant).toISOString() : point?.date
            );
          }}
        >
          Apply
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => {
            apply(null);
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

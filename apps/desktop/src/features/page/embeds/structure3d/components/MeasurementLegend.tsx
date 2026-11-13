import type { ResidueMeasurement } from '../utils/residueMeasurement';

const displayNumber = (value: number) => Number(value.toPrecision(4)).toString();

export function MeasurementLegend({
  measurement,
  compact = false,
}: {
  measurement: ResidueMeasurement;
  compact?: boolean;
}) {
  return (
    <div
      data-testid="measurement-legend"
      role="figure"
      aria-label={`${measurement.name} color key`}
      className={
        compact
          ? 'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 text-xs'
          : 'space-y-1 text-xs'
      }
    >
      <div className="min-w-0 truncate font-medium" title={measurement.name}>
        {measurement.name}
      </div>
      <div
        className="max-w-56 truncate text-fg-muted"
        title={`${measurement.units || 'value'} · ${measurement.scale.transform}`}
      >
        {measurement.units || 'value'} · {measurement.scale.transform}
      </div>
      <div
        className={`h-2 rounded ${compact ? 'col-span-2' : ''}`}
        style={{ background: `linear-gradient(to right, ${measurement.scale.colors.join(',')})` }}
      />
      <div className="flex justify-between gap-4">
        <span title={String(measurement.scale.domain[0])}>
          {displayNumber(measurement.scale.domain[0])}
        </span>
        <span title={String(measurement.scale.domain[1])}>
          {displayNumber(measurement.scale.domain[1])}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded"
          style={{ backgroundColor: measurement.scale.missingColor }}
        />{' '}
        No measurement
      </div>
    </div>
  );
}

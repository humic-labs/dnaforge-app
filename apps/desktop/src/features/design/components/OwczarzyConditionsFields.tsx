import type { TmConditions } from '../algorithms/tm-model';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_SURFACE_CLASS,
} from '../../../components/SettingsSubsection';

export interface OwczarzyConditionsFieldsProps {
  conditions: TmConditions;
  onChange: (patch: Partial<TmConditions>) => void;
  compact?: boolean;
}

const FIELDS = [
  { key: 'monovalentMm', testId: 'tm-monovalent', label: 'Monovalent Na⁺/K⁺ (mM)', step: 10 },
  { key: 'divalentMm', testId: 'tm-divalent', label: 'Divalent Mg²⁺ (mM)', step: 0.5 },
  { key: 'dntpMm', testId: 'tm-dntp', label: 'dNTP (mM)', step: 0.1 },
] as const;

export function OwczarzyConditionsFields({
  conditions,
  onChange,
  compact = false,
}: OwczarzyConditionsFieldsProps) {
  return (
    <div
      data-testid="tm-owczarzy-conditions"
      className={
        compact
          ? 'flex flex-col gap-1.5'
          : `flex flex-col gap-2 rounded-md p-3 ${SETTINGS_SURFACE_CLASS}`
      }
    >
      {!compact && (
        <span className="text-xs font-medium text-fg">Reaction conditions (Owczarzy)</span>
      )}
      {FIELDS.map((field) => (
        <label key={field.key} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-fg-muted">{field.label}</span>
          <input
            data-testid={field.testId}
            type="number"
            min={0}
            step={field.step}
            value={conditions[field.key]}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next >= 0) onChange({ [field.key]: next });
            }}
            className={
              compact
                ? `${SETTINGS_FIELD_CLASS} max-w-20 text-right tabular-nums`
                : `${SETTINGS_FIELD_CLASS} w-20 text-right tabular-nums`
            }
          />
        </label>
      ))}
      {!compact && (
        <span className="text-xs text-fg-muted">
          Owczarzy 2004/2008 salt correction. Free Mg²⁺ = Mg²⁺ − dNTP.
        </span>
      )}
    </div>
  );
}

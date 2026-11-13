import type { ReactNode } from 'react';
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SettingsSubsectionHeader,
} from '../../../components/SettingsSubsection';
import type { TmModel, TmConditions } from '../algorithms/tm-model';
import { tmModelLabel, isOwczarzyModel } from '../algorithms/tm-model';
import { OwczarzyConditionsFields } from './OwczarzyConditionsFields';
import { TmModelSelect } from './TmModelSelect';

export interface PrimerCalculatorDrawerProps {
  tmModel: TmModel;
  onChangeModel: (model: TmModel) => void;
  concNm: number;
  onChangeConcNm: (nm: number) => void;
  conditions: TmConditions;
  onChangeConditions: (patch: Partial<TmConditions>) => void;
  onReset?: () => void;
  compact?: boolean;
  compactExtra?: ReactNode;
}

export function PrimerCalculatorDrawer({
  tmModel,
  onChangeModel,
  concNm,
  onChangeConcNm,
  conditions,
  onChangeConditions,
  onReset,
  compact = false,
  compactExtra,
}: PrimerCalculatorDrawerProps) {
  const owczarzy = isOwczarzyModel(tmModel);

  return (
    <div
      data-testid="primer-calculator-drawer"
      className={compact ? 'flex flex-col gap-2' : 'flex flex-col gap-3 p-4'}
    >
      {!compact && (
        <SettingsSubsectionHeader
          title="Tm calculation"
          description="Which algorithm computes primer melting temperatures across designs and manual primers."
        />
      )}

      {compact ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TmModelSelect value={tmModel} onChange={onChangeModel} />
          <label className="inline-flex items-center gap-1 text-xs text-fg-muted">
            <input
              id="tm-primer-conc"
              data-testid="tm-primer-conc"
              type="number"
              min={1}
              step={50}
              value={concNm}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next > 0) onChangeConcNm(next);
              }}
              className="w-14 rounded-md border border-border bg-bg px-1.5 py-1 text-xs tabular-nums text-fg focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <span>nM</span>
          </label>
          {compactExtra}
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg">Algorithm / polymerase</span>
            <TmModelSelect value={tmModel} onChange={onChangeModel} settingsAppearance />
          </label>

          <div className="flex flex-col gap-1">
            <label htmlFor="tm-primer-conc" className="text-xs font-medium text-fg">
              Primer concentration (nM)
            </label>
            <input
              id="tm-primer-conc"
              data-testid="tm-primer-conc"
              type="number"
              min={1}
              step={50}
              value={concNm}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next > 0) onChangeConcNm(next);
              }}
              className={`${SETTINGS_FIELD_CLASS} w-28`}
            />
            <span className="text-xs text-fg-muted">
              Tm is concentration-dependent. 500 nM is NEB&apos;s standard Q5 reaction
              concentration.
            </span>
          </div>
        </>
      )}

      {owczarzy && (
        <OwczarzyConditionsFields
          conditions={conditions}
          onChange={onChangeConditions}
          compact={compact}
        />
      )}

      {tmModel.kind === 'neb' && !compact && (
        <p data-testid="tm-model-neb-note" className="text-xs text-fg-muted">
          {tmModelLabel(tmModel)} values are fetched from tmapi.neb.com when online; offline, a
          local estimate is shown and marked pending until it can be verified.
        </p>
      )}

      {onReset && (
        <div className="flex justify-end pt-2">
          <button
            type="button"
            data-testid="primer-tm-reset-defaults"
            onClick={onReset}
            className={SETTINGS_SECONDARY_BUTTON_CLASS}
          >
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}

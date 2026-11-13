import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SettingsIcon } from '../../../components/icons';
import { PortalMenu } from '../../../components/PortalMenu';
import {
  applyDesignPcrTmModel,
  refreshDesignPrimerTmsFromSettings,
  resetDesignPcrTmSettingsToDefaults,
} from '../apply-design-pcr-tm';
import { createAppTmCalculator, useSettingsStore } from '../../junction-workbench/public/settings';
import { isOwczarzyModel, type TmConditions } from '../algorithms/tm-model';
import type { AssemblyMethod } from '../types';
import { useDesignStore } from '../store';
import { primerRuleTemperatureStatus } from '../algorithms/primer-rule-temperature-status';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { OwczarzyConditionsFields } from './OwczarzyConditionsFields';
import { TmModelSelect } from './TmModelSelect';

const MIX_FIELD =
  'w-14 rounded-md border border-border bg-bg px-1.5 py-1 text-xs tabular-nums text-fg focus:outline-none focus:ring-1 focus:ring-accent';

export function AssemblyPcrTmConfigurator({
  designId,
  polymerase,
  method,
  readout,
}: {
  designId: string;
  polymerase?: string | null;
  method?: AssemblyMethod;
  readout?: ReactNode;
}) {
  const design = useDesignStore((s) => s.designs[designId]);
  const constraints = design?.primerDesignConstraints;
  const updateConstraints = (targetPcrTm: number, overlapLength: number) => {
    useDesignStore.getState().updateDesign(designId, {
      primerDesignConstraints: { targetPcrTm, overlapLength },
    });
  };
  const primerConcNm = useSettingsStore((s) => s.primerConcNm);
  const setPrimerConcNm = useSettingsStore((s) => s.setPrimerConcNm);
  const tmConditions = useSettingsStore((s) => s.tmConditions);
  const setTmConditions = useSettingsStore((s) => s.setTmConditions);
  const defaultPcrTm = useSettingsStore((s) => s.defaultPcrTm);
  const setDefaultPcrTm = useSettingsStore((s) => s.setDefaultPcrTm);
  const selectedModel = useSettingsStore((s) => s.tmModel);
  const modelExplicit = useSettingsStore((s) => s.tmModelExplicit);
  const tmModel = createAppTmCalculator(polymerase).resolution.model;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const regions = design?.regions;
  const spacers = design?.spacers;
  const designPrimers = design?.designPrimers;
  const assemblyMethod = design?.assemblyMethod;
  const temperatureStatus = useMemo(
    () =>
      regions && spacers && designPrimers && assemblyMethod
        ? primerRuleTemperatureStatus(
            {
              regions,
              spacers,
              designPrimers,
              assemblyMethod,
              primerDesignConstraints: constraints,
            },
            createAppTmCalculator(polymerase)
          )
        : null,
    [
      regions,
      spacers,
      designPrimers,
      assemblyMethod,
      constraints,
      polymerase,
      primerConcNm,
      tmConditions,
      selectedModel,
      modelExplicit,
    ]
  );

  const refreshTms = () => {
    refreshDesignPrimerTmsFromSettings(designId);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        safeFocus(triggerRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div data-testid="assembly-pcr-tm-configurator" className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <TmModelSelect
          value={tmModel}
          onChange={(model) => {
            applyDesignPcrTmModel(designId, model);
          }}
        />
        <button
          ref={triggerRef}
          type="button"
          data-testid="assembly-pcr-mix-settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Polymerase mix settings"
          title="nM, target Tm, and salt conditions"
          onClick={() => setOpen((current) => !current)}
          className="inline-flex h-[27px] w-[27px] items-center justify-center rounded-md border border-border text-fg-muted hover:border-fg-muted hover:text-fg"
        >
          <SettingsIcon size={12} />
        </button>
      </div>
      {readout}
      {temperatureStatus && temperatureStatus.unreachable > 0 ? (
        <button
          type="button"
          data-testid="assembly-primer-target-unreachable"
          title={`Local binding Tm ${temperatureStatus.minimum.toFixed(1)}–${temperatureStatus.maximum.toFixed(1)}°C. Target is outside the available range for ${temperatureStatus.unreachable} of ${temperatureStatus.primerCount} primers.`}
          onClick={() => setOpen(true)}
          className="text-xs text-amber-600 hover:underline"
        >
          Target {temperatureStatus.target}°C outside local Tm range
        </button>
      ) : null}
      <PortalMenu
        open={open}
        anchorRef={triggerRef}
        onRequestClose={() => setOpen(false)}
        role="dialog"
        horizontalAlign="end"
        preferredSide="bottom"
        closeOnEscape={false}
        surfaceVariant="settings"
        className="w-[220px] border border-border p-2 text-fg"
        aria-label="Polymerase mix settings"
        data-testid="assembly-pcr-mix-settings-panel"
      >
        <div className="flex flex-col gap-2">
          <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
            <span>Concentration</span>
            <span className="inline-flex items-center gap-1">
              <input
                data-testid="tm-primer-conc"
                type="number"
                min={1}
                step={50}
                value={primerConcNm}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next > 0) {
                    setPrimerConcNm(next);
                    refreshTms();
                  }
                }}
                className={MIX_FIELD}
              />
              <span>nM</span>
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
            <span>Use primer rules</span>
            <input
              type="checkbox"
              aria-label="Use primer rules"
              checked={constraints !== undefined}
              onChange={(event) => {
                useDesignStore.getState().updateDesign(designId, {
                  primerDesignConstraints: event.target.checked
                    ? { targetPcrTm: defaultPcrTm, overlapLength: 30 }
                    : undefined,
                });
              }}
            />
          </label>
          {constraints ? (
            <>
              <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
                <span>PCR target (°C)</span>
                <PrimerRuleNumberInput
                  label="PCR target (°C)"
                  min={40}
                  max={75}
                  value={constraints.targetPcrTm}
                  onChange={(next) => updateConstraints(next, constraints.overlapLength)}
                />
              </label>
              {method !== 'goldengate' ? (
                <label className="flex items-center justify-between gap-2 text-xs text-fg-muted">
                  <span>Overlap (bp)</span>
                  <PrimerRuleNumberInput
                    label="Overlap (bp)"
                    min={15}
                    max={60}
                    value={constraints.overlapLength}
                    integer
                    onChange={(next) => updateConstraints(constraints.targetPcrTm, next)}
                  />
                </label>
              ) : null}
              {temperatureStatus ? (
                <div
                  role="status"
                  data-testid="assembly-primer-rules-status"
                  className="text-xs text-fg-muted"
                >
                  Local binding Tm {temperatureStatus.minimum.toFixed(1)}–
                  {temperatureStatus.maximum.toFixed(1)}°C; target {temperatureStatus.target}°C.
                  {temperatureStatus.unreachable > 0 ? (
                    <p>
                      Target is outside the available local binding-site Tm range for{' '}
                      {temperatureStatus.unreachable} of {temperatureStatus.primerCount} primers.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <p className="text-xs text-fg-muted">
                Apply on the next Update. Binding lengths from 10–60 bp are chosen closest to the
                PCR target. Review the resulting Tm.
              </p>
            </>
          ) : null}
          {method === 'goldengate' && !constraints ? (
            <label
              className="flex items-center justify-between gap-2 text-xs text-fg-muted"
              title="Sizes Golden Gate PBS on the next Update. Manual PBS edits stay."
            >
              <span>PBS target</span>
              <span className="inline-flex items-center gap-1">
                <input
                  data-testid="assembly-workbench-default-pcr-tm"
                  type="number"
                  min={40}
                  max={75}
                  step={1}
                  value={defaultPcrTm}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next) && next >= 40 && next <= 75) {
                      setDefaultPcrTm(next);
                    }
                  }}
                  className={MIX_FIELD}
                />
                <span>°C</span>
              </span>
            </label>
          ) : null}
          {isOwczarzyModel(tmModel) ? (
            <OwczarzyConditionsFields
              conditions={tmConditions}
              onChange={(patch: Partial<TmConditions>) => {
                setTmConditions(patch);
                refreshTms();
              }}
              compact
            />
          ) : null}
          <div className="flex justify-end border-t border-border pt-2">
            <button
              type="button"
              data-testid="assembly-pcr-reset-defaults"
              onClick={() => resetDesignPcrTmSettingsToDefaults(designId)}
              className="text-xs font-medium text-accent hover:underline"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      </PortalMenu>
    </div>
  );
}

function PrimerRuleNumberInput({
  label,
  value,
  min,
  max,
  integer = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={integer ? 1 : 'any'}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const next = Number(raw);
        if (
          raw !== '' &&
          Number.isFinite(next) &&
          next >= min &&
          next <= max &&
          (!integer || Number.isInteger(next))
        )
          onChange(next);
      }}
      onBlur={() => setDraft(String(value))}
      className={MIX_FIELD}
    />
  );
}

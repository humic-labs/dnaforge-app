import type { OligoOrderType } from '../oligo-modifications';
import type { TmConditions, TmModel } from '../../design/public/algorithms/tm-model';
import { isOwczarzyModel } from '../../design/public/algorithms/tm-model';
import type { UsePrimerTmResult } from '../hooks/usePrimerTm';
import type { PrimerDirection } from '../types';
import { PrimerLengthField } from './PrimerLengthField';
import { TmModelSelect } from '../../design/public/components/TmModelSelect';
import { OwczarzyConditionsFields } from '../../design/public/components/OwczarzyConditionsFields';

const MIN_PRIMER_LENGTH = 10;

function primerFormSegClass(active: boolean): string {
  return `rounded px-1 py-1 text-xs transition-colors ${
    active ? 'bg-bg font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
  }`;
}

type PrimerComputedMetrics = { tm: number | null; gc: number; length: number };

export function PrimerFormMetricsStrip({
  bindingPositionControl,
  hasTemplateContext,
  direction,
  onDirectionChange,
  trimmedSeqLength,
  maxBindingLength,
  onBindingLengthChange,
  canPull3Prime,
  computed,
  displayTm,
  primerTm,
  orderType,
  tmModel,
  onTmModelChange,
  tmConditions,
  onTmConditionsChange,
  gcOff,
}: {
  bindingPositionControl?: {
    value: number;
    min: number;
    max: number;
    editable: boolean;
    wrap: boolean;
    onChange: (value: number) => void;
  };
  hasTemplateContext: boolean;
  direction: PrimerDirection;
  onDirectionChange: (direction: PrimerDirection) => void;
  trimmedSeqLength: number;
  maxBindingLength: number;
  onBindingLengthChange: (length: number) => void;
  canPull3Prime: boolean;
  computed: PrimerComputedMetrics | null;
  displayTm: number | null;
  primerTm: UsePrimerTmResult;
  orderType: OligoOrderType;
  tmModel: TmModel;
  onTmModelChange: (model: TmModel) => void;
  tmConditions: TmConditions;
  onTmConditionsChange: (patch: Partial<TmConditions>) => void;
  gcOff: boolean;
}) {
  return (
    <>
      <div data-testid="primer-metrics" className="flex flex-wrap items-start gap-x-1.5 gap-y-2">
        {hasTemplateContext && (
          <div className="flex w-[68px] shrink-0 flex-col gap-1">
            <span className="text-[10px] font-medium text-fg-muted">Direction</span>
            <div className="grid h-8 grid-cols-2 rounded-md bg-bg-muted p-0.5">
              <button
                type="button"
                aria-label="Forward primer"
                aria-pressed={direction === 'forward'}
                title="Forward primer"
                className={primerFormSegClass(direction === 'forward')}
                onClick={() => onDirectionChange('forward')}
              >
                Fwd
              </button>
              <button
                type="button"
                aria-label="Reverse primer"
                aria-pressed={direction === 'reverse'}
                title="Reverse primer"
                className={primerFormSegClass(direction === 'reverse')}
                onClick={() => onDirectionChange('reverse')}
              >
                Rev
              </button>
            </div>
          </div>
        )}
        <div className="flex w-[60px] shrink-0 flex-col gap-1">
          <span className="shrink-0 text-[10px] font-medium text-fg-muted">Length</span>
          {hasTemplateContext ? (
            <PrimerLengthField
              className="w-full"
              value={trimmedSeqLength}
              min={MIN_PRIMER_LENGTH}
              max={maxBindingLength}
              onChange={onBindingLengthChange}
              editable={canPull3Prime}
            />
          ) : (
            <span className="flex h-8 items-center text-sm font-semibold tabular-nums text-fg">
              {trimmedSeqLength} nt
            </span>
          )}
        </div>
        {bindingPositionControl && (
          <div
            className="flex shrink-0 flex-col gap-1"
            style={{ width: Math.max(72, String(bindingPositionControl.max).length * 9 + 28) }}
          >
            <span
              className="text-[10px] font-medium text-fg-muted"
              title="3′ base position; moves the whole primer without changing its sequence"
            >
              3′ position
            </span>
            <PrimerLengthField {...bindingPositionControl} quantity="position" className="w-full" />
          </div>
        )}
        <div className="flex min-w-[56px] shrink-0 flex-col gap-1">
          <span className="shrink-0 text-[10px] font-medium text-fg-muted">Tm</span>
          {computed && displayTm != null ? (
            <span
              data-testid="primer-computed-values"
              className="flex h-8 shrink-0 items-center gap-1 text-sm font-semibold tabular-nums text-fg"
            >
              <span data-testid="primer-tm-value">{displayTm.toFixed(1)}&deg;C</span>
              {primerTm.modelKind === 'neb' && primerTm.unavailable && (
                <span
                  data-testid="primer-tm-neb-unavailable"
                  title="NEB is unavailable right now — showing the SantaLucia estimate instead"
                  aria-label="NEB unavailable, showing the SantaLucia estimate"
                  className="text-warning"
                >
                  &#9888;
                </span>
              )}
            </span>
          ) : (
            <span
              className="flex h-8 shrink-0 items-center text-sm text-fg-muted"
              title={
                orderType === 'rna'
                  ? 'RNA thermodynamics require an RNA-specific model.'
                  : undefined
              }
            >
              &mdash;
            </span>
          )}
        </div>
        <div className="flex w-8 shrink-0 flex-col gap-1">
          <span className="shrink-0 text-[10px] font-medium text-fg-muted">GC</span>
          <span
            className={`flex h-8 items-center text-sm font-semibold tabular-nums ${gcOff ? 'text-warning' : 'text-fg'}`}
          >
            {computed ? `${Math.round(computed.gc)}%` : '—'}
          </span>
        </div>
      </div>
      {orderType === 'dna' && (
        <div className="grid min-w-0 grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] items-center gap-3">
          <span className="text-xs font-medium text-fg">Tm model</span>
          <TmModelSelect
            testId="primer-tm-model-inline"
            value={tmModel}
            onChange={onTmModelChange}
            settingsAppearance
          />
        </div>
      )}
      {orderType === 'dna' && isOwczarzyModel(tmModel) && (
        <OwczarzyConditionsFields
          conditions={tmConditions}
          onChange={onTmConditionsChange}
          compact
        />
      )}
    </>
  );
}

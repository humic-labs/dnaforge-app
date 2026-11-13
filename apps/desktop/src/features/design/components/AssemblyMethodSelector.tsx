import { useMemo } from 'react';
import type { AssemblyMethod, DesignRegion, GoldenGateEnzyme } from '../types';
import { ENZYME_SPECS } from '../types';
import { DownwardSelect } from '../../../shared/components/DownwardSelect';
import { InternalCutSiteBadge } from './InternalCutSiteBadge';
import {
  countInternalSites,
  formatInternalCutCountLabel,
  summarizeInternalSitesByEnzyme,
} from '../validation/golden-gate-overhangs';

const GOLDEN_GATE_ENZYMES = Object.keys(ENZYME_SPECS) as GoldenGateEnzyme[];

const METHOD_OPTIONS: Array<{ value: AssemblyMethod; label: string }> = [
  { value: 'gibson', label: 'Gibson' },
  { value: 'nebuilder', label: 'NEBuilder' },
  { value: 'goldengate', label: 'GoldenGate' },
];

interface AssemblyMethodSelectorProps {
  method: AssemblyMethod;
  enzyme: GoldenGateEnzyme;
  onChange: (method: AssemblyMethod, enzyme: GoldenGateEnzyme) => void;
  regions?: readonly DesignRegion[];
  disabledMethod?: boolean;
  disabledEnzyme?: boolean;
  methodTitle?: string;
  enzymeTitle?: string;
}

export function AssemblyMethodSelector({
  method,
  enzyme,
  onChange,
  disabledMethod = false,
  disabledEnzyme = false,
  methodTitle = 'Select assembly method',
  enzymeTitle,
  regions = [],
}: AssemblyMethodSelectorProps) {
  const defaultEnzymeTitle = `${ENZYME_SPECS[enzyme].site} recognition site`;
  const internalSitesByEnzyme = useMemo(() => summarizeInternalSitesByEnzyme(regions), [regions]);
  const methodLabel = METHOD_OPTIONS.find((option) => option.value === method)?.label ?? method;

  return (
    <div className="flex items-center gap-1.5">
      <DownwardSelect
        testId="assembly-method-select"
        ariaLabel={methodTitle}
        title={methodTitle}
        value={method}
        label={methodLabel}
        disabled={disabledMethod}
        options={METHOD_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          testId: `assembly-method-option-${option.value}`,
        }))}
        onChange={(next) => {
          const newEnzyme = next === 'goldengate' ? enzyme : 'BsaI';
          onChange(next, newEnzyme);
        }}
      />

      {method === 'goldengate' && (
        <DownwardSelect
          testId="assembly-enzyme-select"
          ariaLabel={enzymeTitle ?? defaultEnzymeTitle}
          title={
            formatInternalCutCountLabel(countInternalSites(internalSitesByEnzyme[enzyme] ?? [])) ??
            enzymeTitle ??
            defaultEnzymeTitle
          }
          value={enzyme}
          label={enzyme}
          warn={countInternalSites(internalSitesByEnzyme[enzyme] ?? []) > 0}
          warnIcon={<InternalCutSiteBadge />}
          disabled={disabledEnzyme}
          options={GOLDEN_GATE_ENZYMES.map((enzymeId) => {
            const siteCount = countInternalSites(internalSitesByEnzyme[enzymeId] ?? []);
            return {
              value: enzymeId,
              label: enzymeId,
              detail: formatInternalCutCountLabel(siteCount),
              warn: siteCount > 0,
              testId: `assembly-enzyme-option-${enzymeId}`,
              data: { 'data-internal-site-count': String(siteCount) },
            };
          })}
          onChange={(next) => onChange('goldengate', next)}
        />
      )}
    </div>
  );
}

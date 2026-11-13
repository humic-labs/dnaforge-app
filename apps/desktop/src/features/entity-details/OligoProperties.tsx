import { useMemo } from 'react';
import { PrimerFormMetricsStrip, usePrimerTm } from '../primers/public/metadata-controls';
import { parseIdtOligoNotation } from '../primers/public/oligo-modifications';
import { useSettingsStore } from '../junction-workbench/public/settings';
import { calculateGcContent } from '../design/public/algorithms/tm-calculator';
import type { OligoDetailsValues } from './types';

export function OligoProperties({ value }: { value: OligoDetailsValues }) {
  const parsed = useMemo(
    () => parseIdtOligoNotation(value.notation, { orderType: value.orderType }),
    [value]
  );
  const primerTm = usePrimerTm(
    value.orderType === 'dna' && !parsed.errors.length ? parsed.bases : ''
  );
  const tmModel = useSettingsStore((state) => state.tmModel);
  const setTmModel = useSettingsStore((state) => state.setTmModel);
  const tmConditions = useSettingsStore((state) => state.tmConditions);
  const setTmConditions = useSettingsStore((state) => state.setTmConditions);
  const computed =
    parsed.errors.length || !parsed.bases
      ? null
      : { length: parsed.bases.length, gc: calculateGcContent(parsed.bases), tm: primerTm.tm };
  return (
    <section aria-label="Oligo properties" className="space-y-2">
      <PrimerFormMetricsStrip
        hasTemplateContext={false}
        direction="forward"
        onDirectionChange={() => {}}
        trimmedSeqLength={parsed.bases.length}
        maxBindingLength={parsed.bases.length}
        onBindingLengthChange={() => {}}
        canPull3Prime={false}
        computed={computed}
        displayTm={value.orderType === 'rna' ? null : primerTm.tm}
        primerTm={primerTm}
        orderType={value.orderType}
        tmModel={tmModel}
        onTmModelChange={setTmModel}
        tmConditions={tmConditions}
        onTmConditionsChange={setTmConditions}
        gcOff={Boolean(computed && (computed.gc < 40 || computed.gc > 60))}
      />
      {parsed.errors[0] ? (
        <p role="alert" className="text-xs text-error">
          {parsed.errors[0]}
        </p>
      ) : null}
    </section>
  );
}

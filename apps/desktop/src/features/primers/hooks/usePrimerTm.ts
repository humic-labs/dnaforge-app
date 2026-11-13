import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../junction-workbench/public/settings';
import type { TmResult, TmSource } from '../../design/public/algorithms/compute-tm';
import { trackToolError } from '../../../lib/analytics';
import { primerServices } from '../primer-services';

const NEB_DEBOUNCE_MS = 450;
const MIN_NEB_LEN = 10;
const MIN_LOCAL_LEN = 6;

export interface UsePrimerTmResult {
  tm: number | null;
  ta: number | null;
  source: TmSource | null;
  verified: boolean;
  unavailable: boolean;
  modelKind: 'local' | 'neb';
}

export function usePrimerTm(sequence: string): UsePrimerTmResult {
  const tmModel = useSettingsStore((s) => s.tmModel);
  const tmModelExplicit = useSettingsStore((s) => s.tmModelExplicit);
  const concNm = useSettingsStore((s) => s.primerConcNm);
  const conditions = useSettingsStore((s) => s.tmConditions);

  const calculator = useMemo(
    () =>
      primerServices.tmCalculation.createCalculator({
        onProviderError: (error) =>
          console.warn(
            '[usePrimerTm] Selected Tm provider unavailable; showing the marked local fallback.',
            error
          ),
      }),
    [tmModel, tmModelExplicit, concNm, conditions]
  );
  const model = calculator.resolution.model;

  const cleaned = useMemo(
    () =>
      sequence
        .trim()
        .toUpperCase()
        .replace(/[^ACGT]/g, ''),
    [sequence]
  );
  const local = useMemo(
    () => (cleaned.length >= MIN_LOCAL_LEN ? calculator.estimate(cleaned) : null),
    [calculator, cleaned]
  );

  const [neb, setNeb] = useState<TmResult | null>(null);

  useEffect(() => {
    if (model.kind !== 'neb' || cleaned.length < MIN_NEB_LEN) {
      setNeb(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setNeb(null);
    const timer = setTimeout(() => {
      void calculator
        .compute(cleaned, { signal: controller.signal })
        .then((result) => {
          if (cancelled) return;
          setNeb(result);
          if (result.pendingNebVerification) {
            trackToolError('primers', 'sidebar', 'provider_unavailable');
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && (!(error instanceof Error) || error.name !== 'AbortError')) {
            console.error('[usePrimerTm] Tm calculation failed unexpectedly.', error);
          }
        });
    }, NEB_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [calculator, model, cleaned]);

  if (model.kind === 'local') {
    return {
      tm: local,
      ta: null,
      source: local == null ? null : 'local',
      verified: false,
      unavailable: false,
      modelKind: 'local',
    };
  }

  const verified = neb?.verified ?? false;
  const hasSeq = cleaned.length >= MIN_NEB_LEN;
  return {
    tm: neb?.tm ?? local,
    ta: neb?.ta ?? null,
    source: neb ? neb.provenance.source : hasSeq ? 'neb-q5-offline' : null,
    verified,
    unavailable: neb?.pendingNebVerification === true,
    modelKind: 'neb',
  };
}

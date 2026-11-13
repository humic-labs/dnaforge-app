import {
  containsDegenerateBases,
  expandDegenerateSequence,
  IUPAC_EXPANSION,
} from '@waypoint/sequence-utils';
import { calculateTmNN, type TmOptions } from './tm-calculator';
import { isOwczarzyModel, type TmModel, type TmConditions } from './tm-model';

export const MIN_LOCAL_TM_LEN = 6;

export function localTmOptions(
  model: TmModel,
  conditions: TmConditions,
  concNm: number
): TmOptions {
  if (isOwczarzyModel(model)) {
    return {
      primerConc: concNm,
      naConc: conditions.monovalentMm,
      mgConc: conditions.divalentMm,
      dntpConc: conditions.dntpMm,
      saltMethod: 'owczarzy',
    };
  }
  return { primerConc: concNm };
}

const RANGE_EXPANSION_CAP = 64;

function normalizeBases(sequence: string): string {
  let out = '';
  for (const ch of sequence.trim().toUpperCase()) {
    if (IUPAC_EXPANSION[ch]) out += ch;
  }
  return out;
}

export function localTmForModel(
  sequence: string,
  model: TmModel,
  conditions: TmConditions,
  concNm: number
): number | null {
  const cleaned = normalizeBases(sequence);
  if (cleaned.length < MIN_LOCAL_TM_LEN) return null;
  return calculateTmNN(cleaned, localTmOptions(model, conditions, concNm));
}

export type LocalTmReadout =
  | { kind: 'value'; tm: number }
  | { kind: 'range'; minTm: number; maxTm: number; meanTm: number; combinations: number }
  | {
      kind: 'indeterminate';
      reason: 'too-short' | 'too-degenerate';
      detail: string;
    };

export function localTmRangeForModel(
  sequence: string,
  model: TmModel,
  conditions: TmConditions,
  concNm: number
): LocalTmReadout {
  const cleaned = normalizeBases(sequence);
  if (cleaned.length < MIN_LOCAL_TM_LEN) {
    return {
      kind: 'indeterminate',
      reason: 'too-short',
      detail: `Select at least ${MIN_LOCAL_TM_LEN} bases to estimate a melting temperature.`,
    };
  }

  const options = localTmOptions(model, conditions, concNm);

  if (!containsDegenerateBases(cleaned)) {
    return { kind: 'value', tm: calculateTmNN(cleaned, options) };
  }

  const expansions = expandDegenerateSequence(cleaned, {
    maxCombinations: RANGE_EXPANSION_CAP,
  });
  if (!expansions) {
    return {
      kind: 'indeterminate',
      reason: 'too-degenerate',
      detail:
        'This selection has too many degenerate positions to give a melting-temperature range.',
    };
  }

  let minTm = Infinity;
  let maxTm = -Infinity;
  let total = 0;
  for (const variant of expansions) {
    const tm = calculateTmNN(variant, options);
    if (tm < minTm) minTm = tm;
    if (tm > maxTm) maxTm = tm;
    total += tm;
  }

  return {
    kind: 'range',
    minTm,
    maxTm,
    meanTm: Math.round((total / expansions.length) * 10) / 10,
    combinations: expansions.length,
  };
}

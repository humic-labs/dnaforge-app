import {
  expandDegenerateSequence,
  IUPAC_EXPANSION,
  IUPAC_COMPLEMENT,
} from '@waypoint/sequence-utils';
import { owczarzySaltCorrectedTmC } from './tm-owczarzy';

const NN_PARAMS: Record<string, { dH: number; dS: number }> = {
  'AA/TT': { dH: -7.9, dS: -22.2 },
  'AT/TA': { dH: -7.2, dS: -20.4 },
  'TA/AT': { dH: -7.2, dS: -21.3 },
  'CA/GT': { dH: -8.5, dS: -22.7 },
  'GT/CA': { dH: -8.4, dS: -22.4 },
  'CT/GA': { dH: -7.8, dS: -21.0 },
  'GA/CT': { dH: -8.2, dS: -22.2 },
  'CG/GC': { dH: -10.6, dS: -27.2 },
  'GC/CG': { dH: -9.8, dS: -24.4 },
  'GG/CC': { dH: -8.0, dS: -19.9 },
};

const INIT_PARAMS = {
  initGC: { dH: 0.1, dS: -2.8 },

  initAT: { dH: 2.3, dS: 4.1 },

  symmetry: { dH: 0, dS: -1.4 },
};

const R = 1.987;

function getNNKey(base1: string, base2: string): string {
  const b1 = base1.toUpperCase();
  const b2 = base2.toUpperCase();
  const c1 = IUPAC_COMPLEMENT[b1];
  const c2 = IUPAC_COMPLEMENT[b2];

  if (!c1 || !c2) return '';

  const key1 = `${b1}${b2}/${c1}${c2}`;
  const key2 = `${c1}${c2}/${b1}${b2}`;
  const key3 = `${c2}${c1}/${b2}${b1}`;
  const key4 = `${b2}${b1}/${c2}${c1}`;

  if (NN_PARAMS[key1]) return key1;
  if (NN_PARAMS[key2]) return key2;
  if (NN_PARAMS[key3]) return key3;
  if (NN_PARAMS[key4]) return key4;

  return '';
}

function isSelfComplementary(sequence: string): boolean {
  const upper = sequence.toUpperCase();
  const len = upper.length;

  for (let i = 0; i < len; i++) {
    if (upper[i] !== IUPAC_COMPLEMENT[upper[len - 1 - i]]) {
      return false;
    }
  }
  return true;
}

export interface TmOptions {
  primerConc?: number;

  naConc?: number;

  mgConc?: number;

  dntpConc?: number;

  saltMethod?: 'default' | 'owczarzy';
}

export const LOCAL_TM_DEFAULT_PRIMER_CONC_NM = 250;

const DEFAULT_OPTIONS: Required<TmOptions> = {
  primerConc: LOCAL_TM_DEFAULT_PRIMER_CONC_NM,
  naConc: 50,
  mgConc: 0,
  dntpConc: 0,
  saltMethod: 'default',
};

export function calculateTmNN(sequence: string, options: TmOptions = {}): number {
  if (PURE_ACGT_ANY_CASE.test(sequence)) {
    return tmForConcreteSequence(sequence.toUpperCase(), options);
  }

  const normalized = normalizeTmSequence(sequence);
  if (!HAS_DEGENERATE.test(normalized)) {
    return tmForConcreteSequence(normalized, options);
  }

  const expansions = expandDegenerateSequence(normalized, {
    maxCombinations: TM_EXPANSION_CAP,
  });

  if (!expansions) {
    return tmForConcreteSequence(representativeConcreteSequence(normalized), options);
  }

  if (expansions.length === 1) {
    return tmForConcreteSequence(expansions[0], options);
  }

  let total = 0;
  for (const variant of expansions) total += tmForConcreteSequence(variant, options);
  return Math.round((total / expansions.length) * 10) / 10;
}

const TM_EXPANSION_CAP = 64;

const PURE_ACGT_ANY_CASE = /^[ACGTacgt]*$/;
const NON_BASE_CHAR = /[^ACGTURYSWKMBDHVN]/g;
const HAS_DEGENERATE = /[URYSWKMBDHVN]/;

function normalizeTmSequence(sequence: string): string {
  return sequence.toUpperCase().replace(NON_BASE_CHAR, '');
}

function representativeConcreteSequence(normalized: string): string {
  let out = '';
  for (const ch of normalized) out += IUPAC_EXPANSION[ch][0];
  return out;
}

function tmForConcreteSequence(sequence: string, options: TmOptions = {}): number {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const upper = sequence;

  if (upper.length < 6) {
    return calculateTmWallace(upper);
  }

  let dH = 0;
  let dS = 0;

  for (let i = 0; i < upper.length - 1; i++) {
    const key = getNNKey(upper[i], upper[i + 1]);
    if (key && NN_PARAMS[key]) {
      dH += NN_PARAMS[key].dH;
      dS += NN_PARAMS[key].dS;
    }
  }

  const firstBase = upper[0];
  const lastBase = upper[upper.length - 1];

  if (firstBase === 'G' || firstBase === 'C') {
    dH += INIT_PARAMS.initGC.dH;
    dS += INIT_PARAMS.initGC.dS;
  } else {
    dH += INIT_PARAMS.initAT.dH;
    dS += INIT_PARAMS.initAT.dS;
  }

  if (lastBase === 'G' || lastBase === 'C') {
    dH += INIT_PARAMS.initGC.dH;
    dS += INIT_PARAMS.initGC.dS;
  } else {
    dH += INIT_PARAMS.initAT.dH;
    dS += INIT_PARAMS.initAT.dS;
  }

  if (isSelfComplementary(upper)) {
    dH += INIT_PARAMS.symmetry.dH;
    dS += INIT_PARAMS.symmetry.dS;
  }

  const N = upper.length;

  const Ct = opts.primerConc * 1e-9;
  const concTerm = isSelfComplementary(upper) ? Ct : Ct / 4;
  const dH_cal = dH * 1000;

  if (opts.saltMethod === 'owczarzy') {
    const tm1M = dH_cal / (dS + R * Math.log(concTerm)) - 273.15;
    const fGC = calculateGcContent(upper) / 100;
    const tmC = owczarzySaltCorrectedTmC(tm1M, fGC, N, {
      monovalentM: opts.naConc / 1000,
      divalentM: opts.mgConc / 1000,
      dntpM: opts.dntpConc / 1000,
    });
    return Math.round(tmC * 10) / 10;
  }

  const Na = opts.naConc / 1000;
  if (Na > 0) {
    dS += 0.368 * (N - 1) * Math.log(Na);
  }
  const Tm = dH_cal / (dS + R * Math.log(concTerm)) - 273.15;
  return Math.round(Tm * 10) / 10;
}

export function calculateTmWallace(sequence: string): number {
  const upper = sequence.toUpperCase();
  let gc = 0;
  let at = 0;

  for (const base of upper) {
    if (base === 'G' || base === 'C') gc++;
    else if (base === 'A' || base === 'T') at++;
  }

  return 2 * at + 4 * gc;
}

export function calculateGcContent(sequence: string): number {
  const upper = sequence.toUpperCase();
  let gc = 0;

  for (const base of upper) {
    if (base === 'G' || base === 'C') gc++;
  }

  return upper.length > 0 ? Math.round((gc / upper.length) * 1000) / 10 : 0;
}

export function estimateTm(sequence: string): number {
  return calculateTmNN(sequence);
}

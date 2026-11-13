import { calculateTmNN, type TmOptions } from './tm-calculator';
import { computeTm, type ComputeTmDeps, type TmResult } from './compute-tm';
import {
  DEFAULT_TM_CONDITIONS,
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_MODEL,
  NEB_TM_OPTIONS,
  isOwczarzyModel,
  tmModelLabel,
  type ReactionContext,
  type TmConditions,
  type TmModel,
} from './tm-model';

export type TmModelSource = 'call-override' | 'reaction' | 'user-setting' | 'default';

export interface TmModelResolution {
  model: TmModel;
  source: TmModelSource;

  reason: string;
}

export interface TmResolutionInputs {
  override?: TmModel | null;

  reaction?: ReactionContext | null;

  userSetting?: TmModel | null;

  userSettingIsExplicit?: boolean;
}

const NEB_BY_PRODCODE = new Map(NEB_TM_OPTIONS.map((option) => [option.prodcode, option]));

export function tmModelFromReaction(reaction: ReactionContext | null | undefined): TmModel | null {
  const raw = reaction?.polymerase?.trim();
  if (!raw) return null;
  const token = raw.toLowerCase();

  const byCode = NEB_BY_PRODCODE.get(token);
  if (byCode) return { kind: 'neb', prodcode: byCode.prodcode, polymerase: byCode.family };

  const match = NEB_TM_OPTIONS.find(
    (option) =>
      token === option.family ||
      token.startsWith(`${option.family} `) ||
      token.startsWith(option.familyLabel.toLowerCase())
  );
  if (!match) return null;
  return { kind: 'neb', prodcode: match.prodcode, polymerase: match.family };
}

export function resolveTmModelWithSource(inputs: TmResolutionInputs): TmModelResolution {
  if (inputs.override) {
    return {
      model: inputs.override,
      source: 'call-override',
      reason: `Explicitly requested for this calculation (${tmModelLabel(inputs.override)}).`,
    };
  }

  const fromReaction = tmModelFromReaction(inputs.reaction);
  if (fromReaction) {
    return {
      model: fromReaction,
      source: 'reaction',
      reason: `This design records ${inputs.reaction?.polymerase} as its polymerase, which is more specific than the app-wide setting.`,
    };
  }

  if (inputs.userSetting && inputs.userSettingIsExplicit) {
    return {
      model: inputs.userSetting,
      source: 'user-setting',
      reason: `App-wide Tm model chosen in settings (${tmModelLabel(inputs.userSetting)}).`,
    };
  }

  const fallback = inputs.userSetting ?? DEFAULT_TM_MODEL;
  return {
    model: fallback,
    source: 'default',
    reason: `No polymerase recorded and no explicit setting; using the default (${tmModelLabel(fallback)}).`,
  };
}

export interface SyncTmEstimate {
  tm: number;

  model: TmModel;
  source: TmModelSource;

  pendingNebVerification: boolean;
}

export interface TmCalculator {
  readonly resolution: TmModelResolution;

  estimate(sequence: string): number;

  estimateWithProvenance(sequence: string): SyncTmEstimate;

  compute(sequence: string, options?: { signal?: AbortSignal }): Promise<TmResult>;
}

export interface TmCalculatorConfig extends TmResolutionInputs {
  conditions?: TmConditions;
  concNm?: number;

  nebFetch?: ComputeTmDeps['nebFetch'];
  online?: boolean;
  onNebError?: ComputeTmDeps['onNebError'];
}

function localOptionsFor(model: TmModel, config: TmCalculatorConfig): TmOptions {
  const concOption: TmOptions = config.concNm === undefined ? {} : { primerConc: config.concNm };

  if (isOwczarzyModel(model)) {
    const conditions = config.conditions ?? DEFAULT_TM_CONDITIONS;
    return {
      ...concOption,
      naConc: conditions.monovalentMm,
      mgConc: conditions.divalentMm,
      dntpConc: conditions.dntpMm,
      saltMethod: 'owczarzy',
    };
  }
  return concOption;
}

export function createTmCalculator(config: TmCalculatorConfig = {}): TmCalculator {
  const resolution = resolveTmModelWithSource(config);
  const options = localOptionsFor(resolution.model, config);

  const estimate = (sequence: string): number => calculateTmNN(sequence, options);

  return {
    resolution,
    estimate,
    estimateWithProvenance: (sequence: string): SyncTmEstimate => ({
      tm: estimate(sequence),
      model: resolution.model,
      source: resolution.source,
      pendingNebVerification: resolution.model.kind === 'neb',
    }),
    compute: (sequence: string, computeOptions = {}): Promise<TmResult> =>
      computeTm(resolution.model, sequence, {
        localFn: estimate,
        nebFetch: config.nebFetch,
        online: config.online,
        conc_nM: config.concNm ?? DEFAULT_PRIMER_CONC_NM,
        onNebError: config.onNebError,
        signal: computeOptions.signal,
      }),
  };
}

export const LOCAL_TM_CALCULATOR: TmCalculator = createTmCalculator();

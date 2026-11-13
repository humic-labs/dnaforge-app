export type NebPolymeraseFamily = 'q5' | 'phusion' | 'onetaq' | 'taq' | 'longamp';

export type TmModel =
  | { kind: 'local'; algorithm: 'santalucia98' | 'santalucia-owczarzy' }
  | { kind: 'neb'; prodcode: string; polymerase: NebPolymeraseFamily };

export const DEFAULT_TM_MODEL: TmModel = { kind: 'local', algorithm: 'santalucia98' };

export const OWCZARZY_TM_MODEL: TmModel = { kind: 'local', algorithm: 'santalucia-owczarzy' };

export const DEFAULT_PRIMER_CONC_NM = 500;

export interface TmConditions {
  monovalentMm: number;

  divalentMm: number;

  dntpMm: number;
}

export const DEFAULT_TM_CONDITIONS: TmConditions = {
  monovalentMm: 50,
  divalentMm: 0,
  dntpMm: 0,
};

export interface NebTmOption {
  prodcode: string;
  label: string;
  family: NebPolymeraseFamily;
  familyLabel: string;
}

export const NEB_TM_OPTIONS: readonly NebTmOption[] = [
  { prodcode: 'q5-0', label: 'NEB Q5', family: 'q5', familyLabel: 'Q5' },
  { prodcode: 'q5hs-0', label: 'NEB Q5 Hot Start', family: 'q5', familyLabel: 'Q5' },
  { prodcode: 'phusion-0', label: 'NEB Phusion (HF)', family: 'phusion', familyLabel: 'Phusion' },
  { prodcode: 'phusion-1', label: 'NEB Phusion (GC)', family: 'phusion', familyLabel: 'Phusion' },
  { prodcode: 'onetaq-0', label: 'NEB OneTaq', family: 'onetaq', familyLabel: 'OneTaq' },
  { prodcode: 'onetaq-1', label: 'NEB OneTaq (GC)', family: 'onetaq', familyLabel: 'OneTaq' },
  { prodcode: 'taq-0', label: 'NEB Taq', family: 'taq', familyLabel: 'Taq' },
  { prodcode: 'hstaq-0', label: 'NEB Hot Start Taq', family: 'taq', familyLabel: 'Taq' },
  { prodcode: 'lataq-0', label: 'NEB LongAmp Taq', family: 'longamp', familyLabel: 'LongAmp' },
];

const NEB_OPTION_BY_PRODCODE: Record<string, NebTmOption> = Object.fromEntries(
  NEB_TM_OPTIONS.map((o) => [o.prodcode, o])
);

export const LOCAL_SELECT_VALUE = 'local';
export const OWCZARZY_SELECT_VALUE = 'owczarzy';

export function tmModelSelectValue(model: TmModel): string {
  if (model.kind === 'local') {
    return model.algorithm === 'santalucia-owczarzy' ? OWCZARZY_SELECT_VALUE : LOCAL_SELECT_VALUE;
  }
  return model.prodcode;
}

export function tmModelFromSelectValue(value: string): TmModel {
  if (value === LOCAL_SELECT_VALUE) return DEFAULT_TM_MODEL;
  if (value === OWCZARZY_SELECT_VALUE) return OWCZARZY_TM_MODEL;
  const option = NEB_OPTION_BY_PRODCODE[value];
  if (!option) return DEFAULT_TM_MODEL;
  return { kind: 'neb', prodcode: option.prodcode, polymerase: option.family };
}

export function isOwczarzyModel(model: TmModel): boolean {
  return model.kind === 'local' && model.algorithm === 'santalucia-owczarzy';
}

export function tmModelLabel(model: TmModel): string {
  if (model.kind === 'local') {
    return model.algorithm === 'santalucia-owczarzy'
      ? 'SantaLucia + Owczarzy salt'
      : 'Default (SantaLucia)';
  }
  return NEB_OPTION_BY_PRODCODE[model.prodcode]?.label ?? `NEB ${model.prodcode}`;
}

export interface ReactionContext {
  polymerase?: string | null;
  buffer?: string | null;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function modelFromReaction(reaction: ReactionContext): TmModel | null {
  const raw = reaction.polymerase?.trim();
  if (!raw) return null;
  const token = normalizeToken(raw);

  const byCode = NEB_OPTION_BY_PRODCODE[token];
  if (byCode) return { kind: 'neb', prodcode: byCode.prodcode, polymerase: byCode.family };

  const match = NEB_TM_OPTIONS.find(
    (o) =>
      token === o.family ||
      token.startsWith(`${o.family} `) ||
      token.startsWith(o.familyLabel.toLowerCase())
  );
  if (!match) return null;
  return { kind: 'neb', prodcode: match.prodcode, polymerase: match.family };
}

export function resolveTmModel(input: {
  userChoice?: TmModel | null;
  reaction?: ReactionContext | null;
}): TmModel {
  if (input.userChoice) return input.userChoice;
  const derived = input.reaction ? modelFromReaction(input.reaction) : null;
  return derived ?? DEFAULT_TM_MODEL;
}

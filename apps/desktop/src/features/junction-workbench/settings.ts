import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { GOLDENGATE_DEFAULT_PCR_TM } from '../design/public/validation-constants';
import {
  DEFAULT_TM_MODEL,
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_CONDITIONS,
  tmModelLabel,
  tmModelSelectValue,
  type TmModel,
  type TmConditions,
} from '../design/public/algorithms/tm-model';
import {
  createTmCalculator,
  resolveTmModelWithSource,
  type TmCalculator,
  type TmCalculatorConfig,
  type TmModelResolution,
} from '../design/public/algorithms/tm-service';

export type JunctionWorkbenchViewportVariant =
  | 'legacy-linked-camera'
  | 'registered-assembly-viewport';

type PersistedSettingsState = {
  experimentalJunctionWorkbench?: boolean;
  junctionWorkbenchViewportVariant?: JunctionWorkbenchViewportVariant;
  defaultPcrTm?: number;
  tmModel?: TmModel;
  tmModelExplicit?: boolean;
  primerConcNm?: number;
  primerConcExplicit?: boolean;
  tmConditions?: TmConditions;
};

interface SettingsState {
  experimentalJunctionWorkbench: boolean;
  junctionWorkbenchViewportVariant: JunctionWorkbenchViewportVariant;
  defaultPcrTm: number;
  tmModel: TmModel;
  tmModelExplicit: boolean;
  primerConcNm: number;
  primerConcExplicit: boolean;
  tmConditions: TmConditions;
  setExperimentalJunctionWorkbench: (enabled: boolean) => void;
  setJunctionWorkbenchViewportVariant: (variant: JunctionWorkbenchViewportVariant) => void;
  setDefaultPcrTm: (tm: number) => void;
  setTmModel: (tmModel: TmModel) => void;
  setPrimerConcNm: (nm: number) => void;
  setTmConditions: (patch: Partial<TmConditions>) => void;
  resetPrimerTmSettings: () => void;
}

export function migrateSettingsState(
  persistedState: unknown,
  version: number
): PersistedSettingsState | undefined {
  const state = persistedState as PersistedSettingsState | undefined;
  if (!state) return undefined;
  const fallbackVariant: JunctionWorkbenchViewportVariant = 'registered-assembly-viewport';
  const defaultPcrTm = state.defaultPcrTm ?? GOLDENGATE_DEFAULT_PCR_TM;
  const tmModel = state.tmModel ?? DEFAULT_TM_MODEL;
  const tmModelExplicit =
    state.tmModelExplicit ??
    (version >= 4 && tmModelSelectValue(tmModel) !== tmModelSelectValue(DEFAULT_TM_MODEL));
  const primerConcNm = state.primerConcNm ?? DEFAULT_PRIMER_CONC_NM;
  const primerConcExplicit =
    state.primerConcExplicit ??
    (version >= 4 &&
      state.primerConcNm !== undefined &&
      state.primerConcNm !== DEFAULT_PRIMER_CONC_NM);
  const tmConditions = { ...DEFAULT_TM_CONDITIONS, ...(state.tmConditions ?? {}) };
  if (version < 2 && state.junctionWorkbenchViewportVariant === 'legacy-linked-camera') {
    return {
      experimentalJunctionWorkbench: state.experimentalJunctionWorkbench ?? false,
      junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
      defaultPcrTm,
      tmModel,
      tmModelExplicit,
      primerConcNm,
      primerConcExplicit,
      tmConditions,
    };
  }
  return {
    experimentalJunctionWorkbench: state.experimentalJunctionWorkbench ?? false,
    junctionWorkbenchViewportVariant: state.junctionWorkbenchViewportVariant ?? fallbackVariant,
    defaultPcrTm,
    tmModel,
    tmModelExplicit,
    primerConcNm,
    primerConcExplicit,
    tmConditions,
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      experimentalJunctionWorkbench: true,
      junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
      defaultPcrTm: GOLDENGATE_DEFAULT_PCR_TM,
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
      tmConditions: DEFAULT_TM_CONDITIONS,
      setExperimentalJunctionWorkbench: (experimentalJunctionWorkbench) =>
        set({ experimentalJunctionWorkbench }),
      setJunctionWorkbenchViewportVariant: (junctionWorkbenchViewportVariant) =>
        set({ junctionWorkbenchViewportVariant }),
      setDefaultPcrTm: (defaultPcrTm) => set({ defaultPcrTm }),
      setTmModel: (tmModel) => set({ tmModel, tmModelExplicit: true }),
      setPrimerConcNm: (primerConcNm) => set({ primerConcNm, primerConcExplicit: true }),
      setTmConditions: (patch) => set((s) => ({ tmConditions: { ...s.tmConditions, ...patch } })),
      resetPrimerTmSettings: () =>
        set({
          defaultPcrTm: GOLDENGATE_DEFAULT_PCR_TM,
          tmModel: DEFAULT_TM_MODEL,
          tmModelExplicit: false,
          primerConcNm: DEFAULT_PRIMER_CONC_NM,
          primerConcExplicit: false,
          tmConditions: DEFAULT_TM_CONDITIONS,
        }),
    }),
    {
      name: 'waypoint-settings',
      version: 6,
      migrate: migrateSettingsState,
      partialize: (state) => ({
        experimentalJunctionWorkbench: state.experimentalJunctionWorkbench,
        junctionWorkbenchViewportVariant: state.junctionWorkbenchViewportVariant,
        defaultPcrTm: state.defaultPcrTm,
        tmModel: state.tmModel,
        tmModelExplicit: state.tmModelExplicit,
        primerConcNm: state.primerConcNm,
        primerConcExplicit: state.primerConcExplicit,
        tmConditions: state.tmConditions,
      }),
    }
  )
);

export function createAppTmCalculator(polymerase?: string | null): TmCalculator {
  const settings = useSettingsStore.getState();
  return createTmCalculator({
    reaction: { polymerase: polymerase ?? null },
    userSetting: settings.tmModel,
    userSettingIsExplicit: settings.tmModelExplicit,
    conditions: settings.tmConditions,
    concNm: settings.primerConcNm,
  });
}

export interface AssemblyTmContext {
  evaluates: 'binding-part';
  modelLabel: string;
  primerConcNm: number;
}

export function describeAssemblyTmContext(polymerase?: string | null): AssemblyTmContext {
  return {
    evaluates: 'binding-part',
    modelLabel: tmModelLabel(createAppTmCalculator(polymerase).resolution.model),
    primerConcNm: useSettingsStore.getState().primerConcNm,
  };
}

type StoredPrimerTmContext = Pick<
  TmCalculatorConfig,
  'override' | 'nebFetch' | 'online' | 'onNebError'
> & {
  polymerase?: string | null;
};

function storedPrimerTmCalculatorConfig(context: StoredPrimerTmContext): TmCalculatorConfig {
  const settings = useSettingsStore.getState();
  return {
    override: context.override,
    reaction: { polymerase: context.polymerase ?? null },
    userSetting: settings.tmModel,
    userSettingIsExplicit: settings.tmModelExplicit,
    conditions: settings.tmConditions,
    concNm: settings.primerConcNm,
    nebFetch: context.nebFetch,
    online: context.online,
    onNebError: context.onNebError,
  };
}

export function resolveStoredPrimerTmModel(
  context: Pick<StoredPrimerTmContext, 'override' | 'polymerase'> = {}
): TmModelResolution {
  return resolveTmModelWithSource(storedPrimerTmCalculatorConfig(context));
}

export function createStoredPrimerTmCalculator(context: StoredPrimerTmContext = {}): TmCalculator {
  return createTmCalculator(storedPrimerTmCalculatorConfig(context));
}

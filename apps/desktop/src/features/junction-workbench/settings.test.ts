import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAppTmCalculator,
  createStoredPrimerTmCalculator,
  describeAssemblyTmContext,
  migrateSettingsState,
  useSettingsStore,
} from './settings';
import { GOLDENGATE_DEFAULT_PCR_TM } from '../design/validation-constants';
import {
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_CONDITIONS,
  DEFAULT_TM_MODEL,
  type TmModel,
} from '../design/algorithms/tm-model';
import { estimateTm, LOCAL_TM_DEFAULT_PRIMER_CONC_NM } from '../design/algorithms/tm-calculator';

describe('junction workbench settings', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      experimentalJunctionWorkbench: false,
      junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
    });
  });

  it('keeps the viewport renderer behind an explicit rollback variant', () => {
    expect(useSettingsStore.getState().junctionWorkbenchViewportVariant).toBe(
      'registered-assembly-viewport'
    );

    useSettingsStore.getState().setJunctionWorkbenchViewportVariant('legacy-linked-camera');

    expect(useSettingsStore.getState().junctionWorkbenchViewportVariant).toBe(
      'legacy-linked-camera'
    );
  });

  it('defaults defaultPcrTm to the Golden Gate constant and supports updates  #11)', () => {
    expect(useSettingsStore.getState().defaultPcrTm).toBe(GOLDENGATE_DEFAULT_PCR_TM);
    useSettingsStore.getState().setDefaultPcrTm(62);
    expect(useSettingsStore.getState().defaultPcrTm).toBe(62);
  });

  it('resets the complete primer Tm configuration and clears explicit-choice state', () => {
    useSettingsStore.setState({
      defaultPcrTm: 64,
      tmModel: { kind: 'neb', polymerase: 'q5', prodcode: 'q5-0' },
      tmModelExplicit: true,
      primerConcNm: 125,
      primerConcExplicit: true,
      tmConditions: { monovalentMm: 75, divalentMm: 2, dntpMm: 0.8 },
    });

    useSettingsStore.getState().resetPrimerTmSettings();

    expect(useSettingsStore.getState()).toMatchObject({
      defaultPcrTm: GOLDENGATE_DEFAULT_PCR_TM,
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
      tmConditions: DEFAULT_TM_CONDITIONS,
    });
  });
});

describe('migrateSettingsState  #11, v2→v3)', () => {
  it('seeds defaultPcrTm for v2 state that predates the field', () => {
    const migrated = migrateSettingsState(
      {
        experimentalJunctionWorkbench: true,
        junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
      },
      2
    );
    expect(migrated?.defaultPcrTm).toBe(GOLDENGATE_DEFAULT_PCR_TM);
    expect(migrated?.junctionWorkbenchViewportVariant).toBe('registered-assembly-viewport');
  });

  it('preserves an already-set defaultPcrTm', () => {
    const migrated = migrateSettingsState(
      {
        experimentalJunctionWorkbench: true,
        junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
        defaultPcrTm: 61,
      },
      3
    );
    expect(migrated?.defaultPcrTm).toBe(61);
  });

  it('seeds defaultPcrTm on the legacy v<2 camera-variant path too', () => {
    const migrated = migrateSettingsState(
      {
        experimentalJunctionWorkbench: false,
        junctionWorkbenchViewportVariant: 'legacy-linked-camera',
      },
      1
    );
    expect(migrated?.defaultPcrTm).toBe(GOLDENGATE_DEFAULT_PCR_TM);
    expect(migrated?.junctionWorkbenchViewportVariant).toBe('registered-assembly-viewport');
  });

  it('returns undefined for empty persisted state', () => {
    expect(migrateSettingsState(undefined, 2)).toBeUndefined();
  });
});

describe('tmModel — the primer Tm configurator , v3→v4)', () => {
  const NEB_Q5: TmModel = { kind: 'neb', polymerase: 'q5', prodcode: 'q5-0' };

  beforeEach(() => {
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL, tmModelExplicit: false });
  });

  it('defaults tmModel to the local SantaLucia model and records deliberate updates', () => {
    expect(useSettingsStore.getState().tmModel).toEqual(DEFAULT_TM_MODEL);
    expect(useSettingsStore.getState().tmModelExplicit).toBe(false);
    useSettingsStore.getState().setTmModel(NEB_Q5);
    expect(useSettingsStore.getState().tmModel).toEqual(NEB_Q5);
    expect(useSettingsStore.getState().tmModelExplicit).toBe(true);
  });

  it('migrate seeds tmModel = local default for v3 state predating the field', () => {
    const migrated = migrateSettingsState(
      {
        experimentalJunctionWorkbench: true,
        junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
        defaultPcrTm: 60,
      },
      3
    );
    expect(migrated?.tmModel).toEqual(DEFAULT_TM_MODEL);
    expect(migrated?.tmModelExplicit).toBe(false);
  });

  it('infers that a persisted non-default v4 model was an explicit user choice', () => {
    const migrated = migrateSettingsState(
      {
        experimentalJunctionWorkbench: true,
        junctionWorkbenchViewportVariant: 'registered-assembly-viewport',
        tmModel: NEB_Q5,
      },
      4
    );
    expect(migrated?.tmModel).toEqual(NEB_Q5);
    expect(migrated?.tmModelExplicit).toBe(true);
  });

  it('preserves the explicitness flag once v5 persisted it', () => {
    const migrated = migrateSettingsState(
      {
        tmModel: NEB_Q5,
        tmModelExplicit: false,
      },
      5
    );
    expect(migrated?.tmModelExplicit).toBe(false);
  });

  it('does not treat the seeded 500 nM concentration as a user choice', () => {
    const migrated = migrateSettingsState(
      {
        primerConcNm: DEFAULT_PRIMER_CONC_NM,
      },
      5
    );
    expect(migrated?.primerConcExplicit).toBe(false);
  });

  it('preserves an older non-default concentration as a user choice', () => {
    const migrated = migrateSettingsState({ primerConcNm: 125 }, 5);
    expect(migrated?.primerConcExplicit).toBe(true);
  });

  it('records a deliberate concentration edit, including one set to the seeded value', () => {
    useSettingsStore.setState({
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
    });
    useSettingsStore.getState().setPrimerConcNm(DEFAULT_PRIMER_CONC_NM);
    expect(useSettingsStore.getState().primerConcExplicit).toBe(true);
  });
});

describe('createAppTmCalculator', () => {
  const SEQUENCE = 'ATGCGTACGTTAGCATCGATCGATCGTAGCTA';

  it('uses the stored concentration on an unconfigured design, not the calculator default', () => {
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
    });

    expect(DEFAULT_PRIMER_CONC_NM).not.toBe(LOCAL_TM_DEFAULT_PRIMER_CONC_NM);
    expect(createAppTmCalculator(null).estimate(SEQUENCE)).not.toBeCloseTo(estimateTm(SEQUENCE), 2);
  });

  it('agrees with the saved oligo temperature for the same bases under default settings', () => {
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: DEFAULT_PRIMER_CONC_NM,
      primerConcExplicit: false,
    });

    expect(createAppTmCalculator(null).estimate(SEQUENCE)).toBeCloseTo(
      createStoredPrimerTmCalculator().estimate(SEQUENCE),
      6
    );
    expect(describeAssemblyTmContext(null).primerConcNm).toBe(DEFAULT_PRIMER_CONC_NM);
  });

  it('still agrees after the user changes the concentration', () => {
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: 125,
      primerConcExplicit: true,
    });

    expect(createAppTmCalculator(null).estimate(SEQUENCE)).toBeCloseTo(
      createStoredPrimerTmCalculator().estimate(SEQUENCE),
      6
    );
    expect(describeAssemblyTmContext(null).primerConcNm).toBe(125);
  });

  it('uses the configured concentration after the user deliberately changes it', () => {
    useSettingsStore.setState({
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
      primerConcNm: 125,
      primerConcExplicit: true,
    });

    const actual = createAppTmCalculator(null).estimate(SEQUENCE);
    expect(actual).not.toBeCloseTo(estimateTm(SEQUENCE), 6);
  });
});

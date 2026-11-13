import { describe, expect, it } from 'vitest';
import {
  CIDAR_MOCLO_MIXED_ROUTE_RED_TU_DESIGN_ID,
  CIDAR_MOCLO_RED_TU_DESIGN_ID,
  cidarMocloMixedRouteRedFluorescentTu,
  cidarMocloRedFluorescentTu,
} from '../../test/scenarios/assembly-real-pipeline';
import { createMocloWorkspaceModel } from './moclo-workspace-model';

describe('createMocloWorkspaceModel', () => {
  it('projects the exact closed CIDAR fusion-site cycle in physical part order', () => {
    const scenario = cidarMocloRedFluorescentTu();
    const design = scenario.designs?.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
    if (!design) throw new Error('CIDAR fixture design is unavailable.');

    const model = createMocloWorkspaceModel(design, 'tailwind');

    expect(model?.enzyme).toBe('BsaI');
    expect(model?.schema.slots.map((slot) => [slot.label, slot.outgoingOverhang])).toEqual([
      ['Promoter', 'TACT'],
      ['RBS', 'AATG'],
      ['CDS', 'AGGT'],
      ['Terminator', 'GCTT'],
      ['Destination vector', 'GGAG'],
    ]);
    expect(model?.schemaIsPersisted).toBe(true);
    expect(model?.isClosed).toBe(true);
    expect(
      model?.parts.map((part) => ({
        name: part.name,
        role: part.role,
        route: part.route,
        entry: part.entryOverhang,
        exit: part.exitOverhang,
      }))
    ).toEqual([
      {
        name: 'J23106_AB',
        role: 'Promoter',
        route: 'Restriction digest',
        entry: 'GGAG',
        exit: 'TACT',
      },
      {
        name: 'B0034m_BC',
        role: 'RBS',
        route: 'Restriction digest',
        entry: 'TACT',
        exit: 'AATG',
      },
      {
        name: 'E1010m_CD',
        role: 'CDS',
        route: 'Restriction digest',
        entry: 'AATG',
        exit: 'AGGT',
      },
      {
        name: 'B0015_DE',
        role: 'Terminator',
        route: 'Restriction digest',
        entry: 'AGGT',
        exit: 'GCTT',
      },
      {
        name: 'DVA_AE',
        role: 'Destination vector',
        route: 'Restriction digest',
        entry: 'GCTT',
        exit: 'GGAG',
      },
    ]);
  });

  it('keeps PCR and digest routes while projecting one unchanged final overhang cycle', () => {
    const scenario = cidarMocloMixedRouteRedFluorescentTu();
    const design = scenario.designs?.designs[CIDAR_MOCLO_MIXED_ROUTE_RED_TU_DESIGN_ID];
    if (!design) throw new Error('Mixed-route CIDAR fixture design is unavailable.');

    const model = createMocloWorkspaceModel(design, 'tailwind');

    expect(model?.parts.map((part) => part.route)).toEqual([
      'PCR',
      'Restriction digest',
      'PCR',
      'Restriction digest',
      'Restriction digest',
    ]);
    expect(model?.parts.map((part) => `${part.entryOverhang}→${part.exitOverhang}`)).toEqual([
      'GGAG→TACT',
      'TACT→AATG',
      'AATG→AGGT',
      'AGGT→GCTT',
      'GCTT→GGAG',
    ]);
    expect(model?.isClosed).toBe(true);
  });

  it('does not pretend a non-Golden-Gate design is a MoClo workspace', () => {
    const scenario = cidarMocloRedFluorescentTu();
    const design = scenario.designs?.designs[CIDAR_MOCLO_RED_TU_DESIGN_ID];
    if (!design) throw new Error('CIDAR fixture design is unavailable.');

    expect(
      createMocloWorkspaceModel(
        { ...design, assemblyMethod: 'gibson', goldenGateConfig: undefined },
        'tailwind'
      )
    ).toBeNull();
  });
});

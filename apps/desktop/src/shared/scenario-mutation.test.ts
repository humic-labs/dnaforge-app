import { describe, expect, it } from 'vitest';
import {
  createElectronRuntimeProfile,
  DISPOSABLE_SCENARIO_PROFILE_ARGUMENT,
} from './scenario-mutation';

describe('renderer scenario capability follows physical main approval', () => {
  it.each([
    [['DNAForge'], { DNAFORGE_ALLOW_SCENARIO_MUTATION: '1' }],
    [['DNAForge', '--dnaforge-allow-scenario-mutation=1'], {}],
    [['DNAForge', '--e2e'], { WAYPOINT_TEST: '1' }],
  ])('launch permission markers alone cannot authorize a persistent profile', (argv, env) => {
    expect(createElectronRuntimeProfile(argv, env)).toMatchObject({
      kind: 'primary',
      scenarioMutationAllowed: false,
    });
  });
  it('requires permission as well as physical profile approval', () => {
    expect(
      createElectronRuntimeProfile(['DNAForge', DISPOSABLE_SCENARIO_PROFILE_ARGUMENT], {})
    ).toMatchObject({ scenarioMutationAllowed: false });
  });
  it('permits a main-approved explicit scenario lease or E2E profile', () => {
    expect(
      createElectronRuntimeProfile(['DNAForge', DISPOSABLE_SCENARIO_PROFILE_ARGUMENT], {
        DNAFORGE_ALLOW_SCENARIO_MUTATION: '1',
      })
    ).toMatchObject({ kind: 'scenario-e2e', scenarioMutationAllowed: true });
    expect(
      createElectronRuntimeProfile(
        ['DNAForge', '--waypoint-e2e=1', '--waypoint-test=1', DISPOSABLE_SCENARIO_PROFILE_ARGUMENT],
        {}
      )
    ).toMatchObject({ kind: 'scenario-e2e', scenarioMutationAllowed: true });
  });
});

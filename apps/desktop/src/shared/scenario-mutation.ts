import { createRuntimeProfile, type RuntimeProfile } from './runtime-profile';

export const DISPOSABLE_SCENARIO_PROFILE_ARGUMENT = '--dnaforge-disposable-scenario-profile=1';

export function isScenarioMutationRequested(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const args = new Set(argv);
  const explicitLease =
    env.DNAFORGE_ALLOW_SCENARIO_MUTATION === '1' ||
    args.has('--dnaforge-allow-scenario-mutation=1');
  const e2e = args.has('--e2e') || args.has('--waypoint-e2e=1');
  const test = env.WAYPOINT_TEST === '1' || args.has('--waypoint-test=1');
  return explicitLease || (e2e && test);
}

export function createElectronRuntimeProfile(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): RuntimeProfile {
  const args = new Set(argv);
  const isE2e =
    args.has('--e2e') ||
    args.has('--waypoint-e2e=1') ||
    env.WAYPOINT_TEST === '1' ||
    args.has('--waypoint-test=1');
  const allowed =
    isScenarioMutationRequested(argv, env) && args.has(DISPOSABLE_SCENARIO_PROFILE_ARGUMENT);
  return createRuntimeProfile({
    isElectron: true,
    isE2e,
    scenarioMutationAllowed: allowed,
    scenarioMutationReason: allowed
      ? 'Allowed: main approved an isolated temporary scenario profile.'
      : 'Blocked: scenario mutation requires an isolated temporary profile approved at startup.',
  });
}

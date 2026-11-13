export type RuntimeProfileKind = 'browser-mock' | 'hosted-browser' | 'primary' | 'scenario-e2e';

export interface RuntimeProfile {
  kind: RuntimeProfileKind;
  isElectron: boolean;
  isE2e: boolean;
  scenarioMutationAllowed: boolean;
  scenarioMutationReason: string;
}

export interface RuntimeProvenance {
  kind: 'electron-main' | 'browser-mock' | 'hosted-browser';
  appName: string;
  appVersion: string;
  isPackaged: boolean;
  isReleaseBuild: boolean;
  appPath: string | null;
  execPath: string | null;
  cwd: string | null;
  userDataPath: string | null;
  projectRoot: string | null;
  apiUrl: string | null;
  pid: number | null;
  sidecarPid: number | null;
  startedAtMs: number | null;
  desktopDevPort: string | null;
  desktopHmrPort: string | null;
  nodeEnv: string | null;
  waypointTest: string | null;
  cacheContractToken: string | null;
  buildSourceFingerprint: string | null;
  sidecarSourceFingerprint: string | null;
}

export function createHostedRuntimeProfile(): RuntimeProfile {
  return {
    kind: 'hosted-browser',
    isElectron: false,
    isE2e: false,
    scenarioMutationAllowed: false,
    scenarioMutationReason:
      'Hosted browser uses server-authoritative workspace state, not in-memory fixtures.',
  };
}

export function createRuntimeProfile({
  isElectron,
  isE2e,
  scenarioMutationAllowed,
  scenarioMutationReason,
}: {
  isElectron: boolean;
  isE2e: boolean;
  scenarioMutationAllowed: boolean;
  scenarioMutationReason: string;
}): RuntimeProfile {
  if (!isElectron) {
    return {
      kind: 'browser-mock',
      isElectron: false,
      isE2e: false,
      scenarioMutationAllowed: true,
      scenarioMutationReason: 'Browser/mock runtime uses in-memory fixture state.',
    };
  }

  return {
    kind: scenarioMutationAllowed ? 'scenario-e2e' : 'primary',
    isElectron: true,
    isE2e,
    scenarioMutationAllowed,
    scenarioMutationReason,
  };
}

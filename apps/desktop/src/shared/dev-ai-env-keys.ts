export interface DevAiEnvKeyLookup {
  enabled: boolean;
  fileEnv: Record<string, string | undefined>;
  processEnv: Record<string, string | undefined>;
}

const APP_SCOPED_PREFIX = 'WAYPOINT_DEV_';

export function resolveDevAiEnvKey(
  providerEnvVar: string,
  lookup: DevAiEnvKeyLookup,
  bareFallback = ''
): string {
  if (!lookup.enabled || lookup.processEnv.DNAFORGE_AI_QUALIFICATION_BUILD === '1') return '';
  const scoped = `${APP_SCOPED_PREFIX}${providerEnvVar}`;
  return lookup.fileEnv[scoped] || lookup.processEnv[scoped] || bareFallback;
}

import type { AppBuildIdentity } from './app-build-identity';

export interface RendererDefineValues {
  enableDevAiEnvKeys: boolean;
  anthropicApiKey: string;
  openaiApiKey: string;
  googleApiKey: string;
  xaiApiKey: string;
  deepseekApiKey: string;
  devBranchLabel: string;
  wpAssetsPath: string;
  testFixturesPath: string;
  humanFixturesPath: string;
  appVersion: string;
  appBuildIdentity: AppBuildIdentity | null;
  buildSourceFingerprint: string;
  proteinWorkerSourceSha256: string;
  macTeamIdCutoverEnabled: boolean;
  macTeamIdCutoverMarker: string;
  hostedAiEnabled: boolean;
  hostedAiMarker: string;
}

export const MAC_TEAM_ID_CUTOVER_RENDERER_ENABLED_MARKER =
  'DNAFORGE_MAC_TEAM_ID_CUTOVER_RENDERER:enabled';
export const MAC_TEAM_ID_CUTOVER_RENDERER_DISABLED_MARKER =
  'DNAFORGE_MAC_TEAM_ID_CUTOVER_RENDERER:disabled';

export function macTeamIdCutoverRendererMarker(enabled: boolean): string {
  return enabled
    ? MAC_TEAM_ID_CUTOVER_RENDERER_ENABLED_MARKER
    : MAC_TEAM_ID_CUTOVER_RENDERER_DISABLED_MARKER;
}

const DEFINE_KEY_BY_FIELD = {
  enableDevAiEnvKeys: '__ENABLE_DEV_AI_ENV_KEYS__',
  anthropicApiKey: '__DEV_ANTHROPIC_API_KEY__',
  openaiApiKey: '__DEV_OPENAI_API_KEY__',
  googleApiKey: '__DEV_GOOGLE_API_KEY__',
  xaiApiKey: '__DEV_XAI_API_KEY__',
  deepseekApiKey: '__DEV_DEEPSEEK_API_KEY__',
  devBranchLabel: '__DEV_BRANCH_LABEL__',
  wpAssetsPath: '__DEV_WP_ASSETS_PATH__',
  testFixturesPath: '__DEV_TEST_FIXTURES_PATH__',
  humanFixturesPath: '__DEV_HUMAN_FIXTURES_PATH__',
  appVersion: '__APP_VERSION__',
  appBuildIdentity: '__DNAFORGE_APP_BUILD__',
  buildSourceFingerprint: '__WAYPOINT_BUILD_SOURCE_FINGERPRINT__',
  proteinWorkerSourceSha256: '__DNAFORGE_PROTEIN_WORKER_SOURCE_SHA256__',
  macTeamIdCutoverEnabled: '__DNAFORGE_MAC_TEAM_ID_CUTOVER__',
  macTeamIdCutoverMarker: '__DNAFORGE_MAC_TEAM_ID_CUTOVER_RENDERER_MARKER__',
  hostedAiEnabled: '__DNAFORGE_HOSTED_AI_ENABLED__',
  hostedAiMarker: '__DNAFORGE_HOSTED_AI_RENDERER_MARKER__',
} as const satisfies Record<keyof RendererDefineValues, `__${string}__`>;

export function createRendererDefines(values: RendererDefineValues): Record<string, string> {
  if (
    values.appBuildIdentity &&
    (values.appBuildIdentity.version ?? 'unknown') !== values.appVersion
  ) {
    throw new Error('Renderer version disagrees with its build identity');
  }
  return Object.fromEntries(
    Object.entries(DEFINE_KEY_BY_FIELD).map(([field, key]) => [
      key,
      JSON.stringify(values[field as keyof RendererDefineValues]),
    ])
  );
}

export const RENDERER_DEFINE_KEYS = Object.values(DEFINE_KEY_BY_FIELD);

export const MAIN_ONLY_DECLARED_GLOBALS = ['__SENTRY_DSN__'] as const;

export function testRendererDefineValues(
  overrides: Partial<RendererDefineValues> = {}
): RendererDefineValues {
  return {
    enableDevAiEnvKeys: false,
    anthropicApiKey: '',
    openaiApiKey: '',
    googleApiKey: '',
    xaiApiKey: '',
    deepseekApiKey: '',
    devBranchLabel: '',
    wpAssetsPath: '',
    testFixturesPath: '',
    humanFixturesPath: '',
    appVersion: '0.0.0-test',
    appBuildIdentity: null,
    buildSourceFingerprint: '',
    proteinWorkerSourceSha256: '',
    macTeamIdCutoverEnabled: false,
    macTeamIdCutoverMarker: '',
    hostedAiEnabled: true,
    hostedAiMarker: 'DNAFORGE_RELEASE_A_HOSTED_RENDERER:enabled',
    ...overrides,
  };
}

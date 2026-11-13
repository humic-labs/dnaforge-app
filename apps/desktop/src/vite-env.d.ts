/// <reference types="vite/client" />

declare const __ENABLE_DEV_AI_ENV_KEYS__: boolean;
declare const __DEV_ANTHROPIC_API_KEY__: string;
declare const __DEV_OPENAI_API_KEY__: string;
declare const __DEV_GOOGLE_API_KEY__: string;
declare const __DEV_XAI_API_KEY__: string;
declare const __DEV_DEEPSEEK_API_KEY__: string;
declare const __DEV_BRANCH_LABEL__: string;
declare const __DEV_WP_ASSETS_PATH__: string;
declare const __DEV_HUMAN_FIXTURES_PATH__: string;
declare const __DEV_TEST_FIXTURES_PATH__: string;
declare const __APP_VERSION__: string;
declare const __DNAFORGE_APP_BUILD__: import('./shared/app-build-identity').AppBuildIdentity | null;
declare const __SENTRY_DSN__: string;
declare const __WAYPOINT_BUILD_SOURCE_FINGERPRINT__: string;
declare const __DNAFORGE_PROTEIN_WORKER_SOURCE_SHA256__: string;
declare const __DNAFORGE_MAC_TEAM_ID_CUTOVER__: boolean;
declare const __DNAFORGE_MAC_TEAM_ID_CUTOVER_RENDERER_MARKER__: string;
declare const __DNAFORGE_HOSTED_AI_ENABLED__: boolean;
declare const __DNAFORGE_HOSTED_AI_RENDERER_MARKER__: string;

declare module 'brotli/decompress' {
  export default function decompress(buffer: Uint8Array, outputSize?: number): Uint8Array;
}

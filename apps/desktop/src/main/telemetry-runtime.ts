import { app } from 'electron';
import type { AnalyticsRuntimeConfig } from '../shared/analytics-types';
import {
  normalizeEnvironment,
  normalizePlatformFamily,
  normalizeReleaseChannel,
} from '../shared/analytics-allowlist';
import { getInstallId } from './ipc/feedback';
import { buildTagFromTelemetryStamp } from './release-stamp';
import { resolveTelemetryActorContext } from './telemetry-actor-context';
export {
  resolveTelemetryActorContext,
  resolveTelemetryActor,
  isTelemetryEgressSuppressed,
  resolvePublicTelemetryActorRequestContext,
  type TelemetryActorContext,
  type PublicTelemetryActorRequestContext,
} from './telemetry-actor-context';

const SAFE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RuntimeDimensions = Omit<AnalyticsRuntimeConfig, 'apiKey' | 'host'>;

interface RuntimeDimensionOptions {
  allowRuntimeCanary?: boolean;
}

export function resolveTelemetryRuntimeDimensions(
  config: Record<string, string> = {},
  appDataPath: string = app.getPath('userData'),
  options: RuntimeDimensionOptions = {}
): RuntimeDimensions {
  const bakedReleaseChannel =
    typeof __DNAFORGE_RELEASE_CHANNEL__ !== 'undefined' ? __DNAFORGE_RELEASE_CHANNEL__ : '';
  const releaseChannel = normalizeReleaseChannel(
    bakedReleaseChannel ||
      config.DNAFORGE_RELEASE_CHANNEL ||
      config.RELEASE_CHANNEL ||
      process.env.DNAFORGE_RELEASE_CHANNEL ||
      process.env.RELEASE_CHANNEL
  );
  const allowRuntimeCanary = options.allowRuntimeCanary ?? !app.isPackaged;
  const rawCanaryId = allowRuntimeCanary
    ? config.DNAFORGE_TELEMETRY_CANARY_ID || process.env.DNAFORGE_TELEMETRY_CANARY_ID || ''
    : '';
  const telemetryCanaryId = SAFE_UUID_RE.test(rawCanaryId) ? rawCanaryId.toLowerCase() : undefined;
  const bakedBuildTagStamp =
    typeof __DNAFORGE_BUILD_TAG__ !== 'undefined' ? __DNAFORGE_BUILD_TAG__ : '';
  const buildTag = buildTagFromTelemetryStamp(bakedBuildTagStamp);
  const { telemetryActor, ciRunId } = resolveTelemetryActorContext(
    config,
    telemetryCanaryId !== undefined,
    {
      appVersion: app.getVersion(),
      releaseChannel,
      ...(buildTag ? { buildTag } : {}),
      appDataPath,
    }
  );

  return {
    appVersion: app.getVersion(),
    platformFamily: normalizePlatformFamily(process.platform),
    environment: normalizeEnvironment(
      (allowRuntimeCanary
        ? config.DNAFORGE_TELEMETRY_ENVIRONMENT || process.env.DNAFORGE_TELEMETRY_ENVIRONMENT
        : '') ||
        (app.isPackaged ? 'production' : config.NODE_ENV || process.env.NODE_ENV || 'development')
    ),
    releaseChannel,
    ...(buildTag ? { buildTag } : {}),
    pseudonymousInstallId: getInstallId(appDataPath),
    isSynthetic: telemetryCanaryId !== undefined,
    ...(telemetryCanaryId ? { telemetryCanaryId } : {}),
    telemetryActor,
    ...(ciRunId ? { ciRunId } : {}),
  };
}

export function telemetryRuntimeProperties(dimensions: RuntimeDimensions): Record<string, unknown> {
  return {
    app_version: dimensions.appVersion,
    platform_family: dimensions.platformFamily,
    environment: dimensions.environment,
    release_channel: dimensions.releaseChannel,
    telemetry_mode: dimensions.releaseChannel,
    ...(dimensions.buildTag ? { build_tag: dimensions.buildTag } : {}),
    ...(dimensions.pseudonymousInstallId
      ? { pseudonymous_install_id: dimensions.pseudonymousInstallId }
      : {}),
    is_synthetic: dimensions.isSynthetic,
    ...(dimensions.telemetryCanaryId ? { telemetry_canary_id: dimensions.telemetryCanaryId } : {}),
    telemetry_actor: dimensions.telemetryActor,
    ...(dimensions.ciRunId ? { ci_run_id: dimensions.ciRunId } : {}),
  };
}

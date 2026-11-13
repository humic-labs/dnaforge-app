import { app } from 'electron';
import {
  normalizeTelemetryActor,
  sanitizeCiRunId,
  type TelemetryActor,
} from '@waypoint/analytics-policy';
import {
  isTelemetryActorAssertionToken,
  telemetryActorAssertionPublicKeyFromStamp,
  verifyTelemetryActorAssertion,
} from '@waypoint/analytics-policy/telemetry-actor-assertion';
import { resolveTelemetrySuppressionFence } from '@waypoint/analytics-policy/telemetry-suppression-fence';
import { normalizeReleaseChannel } from '../shared/analytics-allowlist';
import { buildTagFromTelemetryStamp } from './release-stamp';

export interface TelemetryActorContext {
  telemetryActor: TelemetryActor;
  ciRunId?: string;
  telemetrySuppressed?: true;
}

export interface PublicTelemetryActorRequestContext extends TelemetryActorContext {
  appVersion: string;
  releaseChannel: string;
  buildTag?: string;
  actorAssertion?: string;
}

export function resolveTelemetryActorContext(
  config: Readonly<Record<string, string | undefined>> = {},
  isAuthorizedCanary = false,
  identity: {
    appVersion?: string;
    buildTag?: string;
    releaseChannel?: string;
    appDataPath?: string;
  } = {}
): TelemetryActorContext {
  const resolution = resolveTelemetryActorDisposition(config, isAuthorizedCanary, identity);
  const telemetryActor = resolution.telemetryActor;
  const ciRunId =
    telemetryActor === 'ci' && !resolution.telemetrySuppressed
      ? sanitizeCiRunId(
          config.DNAFORGE_TELEMETRY_CI_RUN_ID ||
            config.GITHUB_RUN_ID ||
            process.env.DNAFORGE_TELEMETRY_CI_RUN_ID ||
            process.env.GITHUB_RUN_ID
        )
      : undefined;
  return {
    telemetryActor,
    ...(ciRunId ? { ciRunId } : {}),
    ...(resolution.telemetrySuppressed ? { telemetrySuppressed: true as const } : {}),
  };
}

export function resolvePublicTelemetryActorRequestContext(
  config: Readonly<Record<string, string | undefined>> = {}
): PublicTelemetryActorRequestContext {
  const bakedReleaseChannel =
    typeof __DNAFORGE_RELEASE_CHANNEL__ !== 'undefined' ? __DNAFORGE_RELEASE_CHANNEL__ : '';
  const releaseChannel = normalizeReleaseChannel(
    bakedReleaseChannel ||
      config.DNAFORGE_RELEASE_CHANNEL ||
      config.RELEASE_CHANNEL ||
      process.env.DNAFORGE_RELEASE_CHANNEL ||
      process.env.RELEASE_CHANNEL
  );
  const bakedBuildTag = typeof __DNAFORGE_BUILD_TAG__ !== 'undefined' ? __DNAFORGE_BUILD_TAG__ : '';
  const buildTag = buildTagFromTelemetryStamp(bakedBuildTag);
  const actor = resolveTelemetryActorContext(config, false, {
    appVersion: app.getVersion(),
    releaseChannel,
    ...(buildTag ? { buildTag } : {}),
    appDataPath: app.getPath('userData'),
  });
  const assertionCandidate =
    config.DNAFORGE_TELEMETRY_ACTOR_ASSERTION ||
    process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION ||
    '';
  const actorAssertion = isTelemetryActorAssertionToken(assertionCandidate)
    ? assertionCandidate
    : undefined;
  return {
    ...actor,
    appVersion: app.getVersion(),
    releaseChannel,
    ...(buildTag ? { buildTag } : {}),
    ...(actorAssertion ? { actorAssertion } : {}),
  };
}

export function resolveTelemetryActor(
  config: Readonly<Record<string, string | undefined>>,
  isAuthorizedCanary: boolean
): TelemetryActor {
  return resolveTelemetryActorDisposition(config, isAuthorizedCanary).telemetryActor;
}

export function isTelemetryEgressSuppressed(
  config: Readonly<Record<string, string | undefined>> = {},
  appDataPath: string = app.getPath('userData')
): boolean {
  return resolveTelemetryActorDisposition(config, false, { appDataPath }).telemetrySuppressed;
}

function bakedActorAssertionPublicKey(): string | null {
  const stamp =
    typeof __DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__ !== 'undefined'
      ? __DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__
      : '';
  return telemetryActorAssertionPublicKeyFromStamp(stamp);
}

function resolveTelemetryActorDisposition(
  config: Readonly<Record<string, string | undefined>>,
  isAuthorizedCanary: boolean,
  identity: {
    appVersion?: string;
    buildTag?: string;
    releaseChannel?: string;
    appDataPath?: string;
  } = {}
): { telemetryActor: TelemetryActor; telemetrySuppressed: boolean } {
  if (isAuthorizedCanary) return { telemetryActor: 'canary', telemetrySuppressed: false };

  const bakedReleaseChannel =
    typeof __DNAFORGE_RELEASE_CHANNEL__ !== 'undefined' ? __DNAFORGE_RELEASE_CHANNEL__ : '';
  const releaseChannel =
    identity.releaseChannel ||
    normalizeReleaseChannel(
      bakedReleaseChannel ||
        config.DNAFORGE_RELEASE_CHANNEL ||
        config.RELEASE_CHANNEL ||
        process.env.DNAFORGE_RELEASE_CHANNEL ||
        process.env.RELEASE_CHANNEL
    );
  const bakedBuildTag = typeof __DNAFORGE_BUILD_TAG__ !== 'undefined' ? __DNAFORGE_BUILD_TAG__ : '';
  const buildTag = identity.buildTag || buildTagFromTelemetryStamp(bakedBuildTag);
  const appVersion = identity.appVersion || app.getVersion();

  const rawExplicitActor =
    config.DNAFORGE_TELEMETRY_ACTOR || process.env.DNAFORGE_TELEMETRY_ACTOR || '';
  const explicitActor = normalizeTelemetryActor(rawExplicitActor);
  const assertion =
    config.DNAFORGE_TELEMETRY_ACTOR_ASSERTION ||
    process.env.DNAFORGE_TELEMETRY_ACTOR_ASSERTION ||
    '';
  if (app.isPackaged) {
    const fence = resolveTelemetrySuppressionFence({
      userDataPath: identity.appDataPath ?? app.getPath('userData'),
    });
    if (fence.kind === 'active') {
      return { telemetryActor: 'user', telemetrySuppressed: true };
    }
    const internalLaunchAttempted = rawExplicitActor.length > 0 || assertion.length > 0;
    if (!internalLaunchAttempted) {
      return { telemetryActor: buildTag ? 'user' : 'dev', telemetrySuppressed: false };
    }
    const ciRunId =
      explicitActor === 'ci'
        ? sanitizeCiRunId(
            config.DNAFORGE_TELEMETRY_CI_RUN_ID ||
              config.GITHUB_RUN_ID ||
              process.env.DNAFORGE_TELEMETRY_CI_RUN_ID ||
              process.env.GITHUB_RUN_ID
          )
        : undefined;
    const publicKey = bakedActorAssertionPublicKey();
    const claims =
      (explicitActor === 'maintainer' || explicitActor === 'ci') &&
      publicKey &&
      appVersion &&
      buildTag &&
      releaseChannel
        ? verifyTelemetryActorAssertion({
            token: assertion,
            publicKey,
            actor: explicitActor,
            appVersion,
            buildTag,
            releaseChannel,
            ...(ciRunId ? { ciRunId } : {}),
          })
        : null;
    return claims
      ? { telemetryActor: claims.actor, telemetrySuppressed: false }
      : { telemetryActor: 'user', telemetrySuppressed: true };
  }
  if (explicitActor === 'maintainer') {
    return { telemetryActor: 'maintainer', telemetrySuppressed: false };
  }
  if (
    explicitActor === 'ci' ||
    isCiMarker(config.GITHUB_ACTIONS || process.env.GITHUB_ACTIONS) ||
    isCiMarker(config.CI || process.env.CI)
  ) {
    return { telemetryActor: 'ci', telemetrySuppressed: false };
  }

  return { telemetryActor: 'dev', telemetrySuppressed: false };
}

function isCiMarker(value: unknown): boolean {
  return typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase());
}
